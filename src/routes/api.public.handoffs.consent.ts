// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// G11 — public client onboarding endpoint.
// GET  /api/public/handoffs/consent?token=hoi_... → invite preview
// POST /api/public/handoffs/consent               → submit org + PAT + DPA
//
// Auth: the invite token itself is the credential. No Mission Control account
// needed. Tokens are single-use, expire, and are hashed at rest.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encodeBytea, encryptSecret } from "@/server/crypto.server";
import type { Database } from "@/integrations/supabase/types";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function hashToken(t: string) {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

function hashTerms(body: string) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

async function loadInvite(token: string) {
  const token_hash = hashToken(token);
  const { data, error } = await supabaseAdmin
    .from("handoff_invites")
    .select(
      "id, handoff_id, terms_version, terms_hash, terms_body, region_allowlist, plan_allowlist, expires_at, consumed_at, revoked_at",
    )
    .eq("token_hash", token_hash)
    .maybeSingle();
  if (error || !data) return { ok: false as const, status: 404, error: "invite_not_found" };
  if (data.revoked_at)
    return { ok: false as const, status: 410, error: "invite_revoked" };
  if (data.consumed_at)
    return { ok: false as const, status: 410, error: "invite_already_used" };
  if (new Date(data.expires_at).getTime() < Date.now())
    return { ok: false as const, status: 410, error: "invite_expired" };
  return { ok: true as const, invite: data };
}

const SubmitSchema = z.object({
  token: z.string().min(20).max(200),
  org_id: z.string().min(1).max(200),
  org_slug: z.string().min(1).max(200).optional().nullable(),
  owner_email: z.string().email().max(200),
  owner_name: z.string().min(1).max(200),
  pat: z.string().min(20).max(400),
  target_region: z.string().min(1).max(64),
  target_plan_tier: z.string().min(1).max(64),
  terms_version: z.string().min(1),
  terms_hash_ack: z.string().min(1),
  signed_by_name: z.string().min(1).max(200),
  dpa_accepted: z.literal(true),
  notes: z.string().max(2000).optional().nullable(),
});

export const Route = createFileRoute("/api/public/handoffs/consent")({
  server: {
    handlers: {
      OPTIONS: async () => json({ ok: true }, 204),

      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("token");
        if (!token) return json({ ok: false, error: "missing_token" }, 400);
        const res = await loadInvite(token);
        if (!res.ok) return json({ ok: false, error: res.error }, res.status);

        // Load minimal handoff + clone context for the client wizard.
        const { data: handoff } = await supabaseAdmin
          .from("clone_handoffs")
          .select(
            "id, state, target_region, target_plan_tier, clones(name, slug)",
          )
          .eq("id", res.invite.handoff_id)
          .maybeSingle();

        return json({
          ok: true,
          invite: {
            terms_version: res.invite.terms_version,
            terms_hash: res.invite.terms_hash,
            terms_body: res.invite.terms_body,
            region_allowlist: res.invite.region_allowlist,
            plan_allowlist: res.invite.plan_allowlist,
            expires_at: res.invite.expires_at,
          },
          handoff: handoff
            ? {
                state: handoff.state,
                target_region: handoff.target_region,
                target_plan_tier: handoff.target_plan_tier,
                clone_name: handoff.clones?.name,
                clone_slug: handoff.clones?.slug,
              }
            : null,
        });
      },

      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = SubmitSchema.safeParse(body);
        if (!parsed.success)
          return json(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        const data = parsed.data;

        const invRes = await loadInvite(data.token);
        if (!invRes.ok) return json({ ok: false, error: invRes.error }, invRes.status);
        const invite = invRes.invite;

        // Enforce version + hash acknowledgement.
        if (data.terms_version !== invite.terms_version)
          return json({ ok: false, error: "terms_version_mismatch" }, 409);
        if (data.terms_hash_ack !== invite.terms_hash)
          return json({ ok: false, error: "terms_hash_mismatch" }, 409);

        // Enforce allowlists when configured.
        if (
          invite.region_allowlist?.length &&
          !invite.region_allowlist.includes(data.target_region)
        )
          return json(
            { ok: false, error: "region_not_allowed", allowed: invite.region_allowlist },
            422,
          );
        if (
          invite.plan_allowlist?.length &&
          !invite.plan_allowlist.includes(data.target_plan_tier)
        )
          return json(
            { ok: false, error: "plan_not_allowed", allowed: invite.plan_allowlist },
            422,
          );

        // Load handoff to find clone_id and prior account link.
        const { data: handoff, error: hErr } = await supabaseAdmin
          .from("clone_handoffs")
          .select("id, clone_id, state, client_account_id")
          .eq("id", invite.handoff_id)
          .maybeSingle();
        if (hErr || !handoff)
          return json({ ok: false, error: "handoff_not_found" }, 404);

        // Encrypt the PAT before storing. Last-4 shown for admin display.
        const pat_ciphertext = encodeBytea(encryptSecret(data.pat));
        const pat_last4 = data.pat.slice(-4);

        // Upsert client_supabase_accounts. Reuse an existing row when the
        // handoff already points at one; otherwise create fresh.
        let accountId = handoff.client_account_id as string | null;
        if (accountId) {
          const { error: upErr } = await supabaseAdmin
            .from("client_supabase_accounts")
            .update({
              owner_email: data.owner_email,
              owner_name: data.owner_name,
              org_id: data.org_id,
              org_slug: data.org_slug ?? null,
              plan_tier: data.target_plan_tier,
              region_allowed:
                invite.region_allowlist?.length ? invite.region_allowlist : [data.target_region],
              pat_ciphertext,
              pat_last4,
              verified_at: new Date().toISOString(),
              notes: data.notes ?? null,
            })
            .eq("id", accountId);
          if (upErr) return json({ ok: false, error: upErr.message }, 500);
        } else {
          const { data: acct, error: aErr } = await supabaseAdmin
            .from("client_supabase_accounts")
            .insert({
              clone_id: handoff.clone_id,
              owner_email: data.owner_email,
              owner_name: data.owner_name,
              org_id: data.org_id,
              org_slug: data.org_slug ?? null,
              plan_tier: data.target_plan_tier,
              region_allowed:
                invite.region_allowlist?.length ? invite.region_allowlist : [data.target_region],
              pat_ciphertext,
              pat_last4,
              verified_at: new Date().toISOString(),
              notes: data.notes ?? null,
            })
            .select("id")
            .single();
          if (aErr || !acct) return json({ ok: false, error: aErr?.message ?? "account_insert_failed" }, 500);
          accountId = acct.id;
        }

        // Wire the account and target region/plan into the handoff, and
        // advance state to awaiting_client_consent if we're still upstream of it.
        const ADVANCEABLE_FROM = new Set(["draft", "dry_run_ready"]);
        const nowIso = new Date().toISOString();
        const patch: Database["public"]["Tables"]["clone_handoffs"]["Update"] = {
          client_account_id: accountId,
          target_region: data.target_region,
          target_plan_tier: data.target_plan_tier,
          consent_signed_at: nowIso,
          consent_terms_version: data.terms_version,
        };
        if (ADVANCEABLE_FROM.has(handoff.state as string)) {
          patch.state = "awaiting_client_consent";
        }
        const { error: hUpErr } = await supabaseAdmin
          .from("clone_handoffs")
          .update(patch)
          .eq("id", handoff.id);
        if (hUpErr) return json({ ok: false, error: hUpErr.message }, 500);

        // Record the signed DPA/contract (G13 — signed handoff record).
        const forwardedFor = request.headers.get("x-forwarded-for");
        const clientIp = forwardedFor ? forwardedFor.split(",")[0]?.trim() : null;
        const userAgent = request.headers.get("user-agent");

        // Resolve canonical terms version row (if the invite's version matches
        // a registered one). Non-blocking — legacy invites still work.
        const { data: termsRow } = await supabaseAdmin
          .from("handoff_terms_versions")
          .select("id, version, terms_hash")
          .eq("version", data.terms_version)
          .maybeSingle();

        // Snapshot manifest: every handoff_snapshot for this handoff, captured
        // at signing time so the contract is anchored to a concrete artifact set.
        const { data: snapshotRows } = await supabaseAdmin
          .from("handoff_snapshots")
          .select("id, kind, status, sha256, size_bytes, storage_path, retention_expires_at, created_at")
          .eq("handoff_id", handoff.id)
          .order("created_at", { ascending: true });
        const snapshotManifest = (snapshotRows ?? []).map((s) => ({
          id: s.id,
          kind: s.kind,
          status: s.status,
          sha256: s.sha256,
          size_bytes: s.size_bytes,
          storage_path: s.storage_path,
          retention_expires_at: s.retention_expires_at,
          created_at: s.created_at,
        }));

        // Signature bundle: canonical JSON hashed to anchor the whole record.
        const bundle = {
          handoff_id: handoff.id,
          clone_id: handoff.clone_id,
          terms_version: data.terms_version,
          terms_hash: invite.terms_hash,
          signed_by_name: data.signed_by_name,
          signed_by_email: data.owner_email,
          signed_at: nowIso,
          ip_address: clientIp,
          user_agent: userAgent,
          org_id: data.org_id,
          org_slug: data.org_slug ?? null,
          target_region: data.target_region,
          target_plan_tier: data.target_plan_tier,
          snapshot_manifest: snapshotManifest,
        };
        const bundleJson = JSON.stringify(bundle);
        const signatureBundleSha256 = createHash("sha256")
          .update(bundleJson, "utf8")
          .digest("hex");

        // Build a human-readable signed document (markdown) and upload it
        // to the private handoff-contracts bucket.
        const doc = [
          `# Aurixa Handoff Data Processing Agreement`,
          ``,
          `**Handoff ID:** ${handoff.id}`,
          `**Clone:** ${handoff.clone_id}`,
          `**Terms version:** ${data.terms_version}`,
          `**Terms SHA-256:** \`${invite.terms_hash}\``,
          ``,
          `## Signatory`,
          `- Name: ${data.signed_by_name}`,
          `- Email: ${data.owner_email}`,
          `- Signed at: ${nowIso}`,
          `- IP: ${clientIp ?? "unknown"}`,
          `- User agent: ${userAgent ?? "unknown"}`,
          ``,
          `## Target Supabase organization`,
          `- org_id: ${data.org_id}`,
          `- org_slug: ${data.org_slug ?? "—"}`,
          `- region: ${data.target_region}`,
          `- plan tier: ${data.target_plan_tier}`,
          ``,
          `## Snapshot manifest at signing`,
          snapshotManifest.length === 0
            ? "_No snapshots recorded at signing time._"
            : snapshotManifest
                .map(
                  (s) =>
                    `- \`${s.kind}\` · ${s.id} · status=${s.status} · sha256=\`${s.sha256 ?? "n/a"}\``,
                )
                .join("\n"),
          ``,
          `## Signature bundle SHA-256`,
          `\`${signatureBundleSha256}\``,
          ``,
          `---`,
          `This document is the canonical signed record for the above handoff. Any`,
          `modification invalidates the signature bundle hash above.`,
          ``,
        ].join("\n");

        const docPath = `${handoff.id}/${signatureBundleSha256}.md`;
        const uploadRes = await supabaseAdmin.storage
          .from("handoff-contracts")
          .upload(docPath, new Blob([doc], { type: "text/markdown" }), {
            contentType: "text/markdown; charset=utf-8",
            upsert: false,
          });
        const documentStoragePath = uploadRes.error ? null : docPath;

        await supabaseAdmin.from("handoff_contracts").insert({
          handoff_id: handoff.id,
          version: data.terms_version,
          terms_version_id: termsRow?.id ?? null,
          terms_hash: invite.terms_hash,
          signed_by_name: data.signed_by_name,
          signed_by_email: data.owner_email,
          signed_at: nowIso,
          ip_address: clientIp,
          user_agent: userAgent,
          snapshot_manifest: snapshotManifest,
          signature_bundle_sha256: signatureBundleSha256,
          document_storage_path: documentStoragePath,
        });

        // Consume the invite (single-use).
        await supabaseAdmin
          .from("handoff_invites")
          .update({ consumed_at: nowIso, consumed_ip: clientIp })
          .eq("id", invite.id);

        // Audit trail.
        await supabaseAdmin.from("handoff_events").insert({
          handoff_id: handoff.id,
          kind: "invite.consumed",
          details: {
            invite_id: invite.id,
            owner_email: data.owner_email,
            org_id: data.org_id,
            org_slug: data.org_slug ?? null,
            target_region: data.target_region,
            target_plan_tier: data.target_plan_tier,
            terms_version: data.terms_version,
            signed_by_name: data.signed_by_name,
          },
        });

        // Operator notification so someone in Mission Control knows the
        // client just handed over credentials.
        await supabaseAdmin.from("notifications").insert({
          kind: "handoff_consent_received",
          severity: "info",
          title: `Handoff consent received from ${data.owner_email}`,
          body: `Client submitted Supabase org details, PAT, and DPA signature for handoff ${handoff.id.slice(0, 8)}.`,
          clone_id: handoff.clone_id,
          url: `/handoffs/${handoff.id}`,
          metadata: {
            handoff_id: handoff.id,
            client_account_id: accountId,
            target_region: data.target_region,
            target_plan_tier: data.target_plan_tier,
          },
        });

        return json({ ok: true, handoff_id: handoff.id, next_state: patch.state ?? handoff.state });
      },
    },
  },
});
