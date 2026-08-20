// @ts-nocheck
// E3 — Client-owned Supabase account records. Stores the client's org id
// and (encrypted) Personal Access Token so the handoff orchestrator can
// provision a twin project in *their* org (round 2). PAT is encrypted at
// rest via CREDENTIALS_ENC_KEY (see crypto.server.ts) and never returned
// to the client — only pat_last4 is exposed.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const createSchema = z.object({
  clone_id: z.string().uuid().nullable().optional(),
  owner_email: z.string().email(),
  owner_name: z.string().nullable().optional(),
  org_slug: z.string().nullable().optional(),
  org_id: z.string().nullable().optional(),
  plan_tier: z.string().nullable().optional(),
  region_allowed: z.array(z.string()).default([]),
  notes: z.string().nullable().optional(),
  pat: z.string().min(20).nullable().optional(),
});

export const listClientSupabaseAccounts = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("client_supabase_accounts")
      .select(
        "id, clone_id, owner_email, owner_name, org_slug, org_id, plan_tier, region_allowed, pat_last4, verified_at, revoked_at, created_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

export const createClientSupabaseAccount = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => createSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { encryptSecret, encodeBytea } = await import("@/server/crypto.server");
    const patEnc = data.pat ? encryptSecret(data.pat) : null;
    const last4 = data.pat ? data.pat.slice(-4) : null;
    const { data: row, error } = await context.supabase
      .from("client_supabase_accounts")
      .insert({
        clone_id: data.clone_id ?? null,
        owner_email: data.owner_email,
        owner_name: data.owner_name ?? null,
        org_slug: data.org_slug ?? null,
        org_id: data.org_id ?? null,
        plan_tier: data.plan_tier ?? null,
        region_allowed: data.region_allowed,
        notes: data.notes ?? null,
        pat_last4: last4,
        // Store encrypted PAT in metadata JSONB for now; a future migration
        // moves it to a dedicated bytea column once vault-backed storage is
        // wired. Keeping it here avoids a second migration this round.
        // The record itself is admin-only via RLS.
        pat_ciphertext: null,
      })
      .select("id, owner_email")
      .single();
    if (error) throw error;
    if (patEnc) {
      // Stash encrypted PAT via a service-role write to avoid RLS quirks
      // with bytea. Because BYTEA needs an admin path.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: patErr } = await supabaseAdmin
        .from("client_supabase_accounts")
        .update({ pat_ciphertext: encodeBytea(patEnc) })
        .eq("id", row.id);
      // The account row is already written at this point, so a silent failure
      // here leaves a client account that LOOKS captured and has no credential
      // behind it — which is exactly what the caller must not be told.
      if (patErr) {
        return {
          ok: false as const,
          id: row.id,
          error: `account_saved_pat_not_stored: ${patErr.message}`,
        };
      }
    }
    return { ok: true as const, id: row.id };
  });

export const revokeClientSupabaseAccount = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("client_supabase_accounts")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true as const };
  });

// G12 — verify captured PAT against Supabase Management API.
// Calls /v1/organizations with the decrypted PAT and, if an org_slug/org_id
// is set, confirms membership. Populates verified_at and enriches missing
// org_id / plan_tier from the matched org record. Never returns the PAT.
export const verifyClientSupabaseAccount = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: acct, error } = await supabaseAdmin
      .from("client_supabase_accounts")
      .select("id, org_id, org_slug, pat_ciphertext")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!acct) throw new Error("Client Supabase account not found");
    if (!acct.pat_ciphertext) throw new Error("No PAT stored — capture one first");

    const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
    const pat = decryptSecret(decodeBytea(acct.pat_ciphertext));

    const res = await fetch("https://api.supabase.com/v1/organizations", {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await supabaseAdmin
        .from("client_supabase_accounts")
        .update({ verified_at: null, notes: `Verify failed ${res.status}: ${body.slice(0, 200)}` })
        .eq("id", data.id);
      return { ok: false as const, status: res.status, error: body.slice(0, 400) };
    }
    const orgs = (await res.json()) as Array<{
      id: string;
      slug?: string | null;
      name?: string | null;
      plan?: { id?: string; name?: string } | string | null;
    }>;

    // Prefer explicit slug/id match; otherwise fall back to the first org if only one exists.
    const wanted = acct.org_slug ?? acct.org_id ?? null;
    let match =
      wanted != null
        ? orgs.find((o) => o.id === wanted || o.slug === wanted)
        : orgs.length === 1
          ? orgs[0]
          : undefined;

    if (!match) {
      await supabaseAdmin
        .from("client_supabase_accounts")
        .update({
          verified_at: null,
          notes: `PAT valid but no matching org (${orgs.length} accessible)`,
        })
        .eq("id", data.id);
      return {
        ok: false as const,
        error: "org_not_found",
        available_orgs: orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name })),
      };
    }

    const plan =
      typeof match.plan === "string" ? match.plan : (match.plan?.name ?? match.plan?.id ?? null);

    await supabaseAdmin
      .from("client_supabase_accounts")
      .update({
        org_id: match.id,
        org_slug: match.slug ?? null,
        plan_tier: plan,
        verified_at: new Date().toISOString(),
        notes: null,
      })
      .eq("id", data.id);

    await context.supabase.from("audit_log").insert({
      actor_id: context.userId,
      action: "client_supabase_account_verified",
      target_type: "client_supabase_account",
      target_id: data.id,
      metadata: { org_id: match.id, org_slug: match.slug, plan_tier: plan } as never,
    });

    return {
      ok: true as const,
      org_id: match.id,
      org_slug: match.slug,
      org_name: match.name,
      plan_tier: plan,
    };
  });

export const updateClientSupabaseAccount = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        owner_email: z.string().email().optional(),
        owner_name: z.string().nullable().optional(),
        org_slug: z.string().nullable().optional(),
        org_id: z.string().nullable().optional(),
        plan_tier: z.string().nullable().optional(),
        region_allowed: z.array(z.string()).optional(),
        notes: z.string().nullable().optional(),
        clone_id: z.string().uuid().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...rest } = data;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length === 0) return { ok: true as const, noop: true };
    const { error } = await context.supabase
      .from("client_supabase_accounts")
      .update(patch)
      .eq("id", id);
    if (error) throw error;
    return { ok: true as const };
  });

export const rotateClientSupabasePat = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ id: z.string().uuid(), pat: z.string().min(20) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { encryptSecret, encodeBytea } = await import("@/server/crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const enc = encryptSecret(data.pat);
    const last4 = data.pat.slice(-4);
    const { error } = await supabaseAdmin
      .from("client_supabase_accounts")
      .update({
        pat_ciphertext: encodeBytea(enc),
        pat_last4: last4,
        verified_at: null,
      })
      .eq("id", data.id);
    if (error) throw error;
    await context.supabase.from("audit_log").insert({
      actor_id: context.userId,
      action: "client_supabase_pat_rotated",
      target_type: "client_supabase_account",
      target_id: data.id,
    });
    return { ok: true as const };
  });
