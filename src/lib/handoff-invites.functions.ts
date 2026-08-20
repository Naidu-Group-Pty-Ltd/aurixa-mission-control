// G11 — Client onboarding portal invites.
// Admins mint short-lived bearer tokens that a third party can redeem via
// the public /api/public/handoffs/consent endpoint to submit their Supabase
// org + PAT + DPA signature without needing a Mission Control account.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { createHash, randomBytes } from "crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashTerms(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export const createHandoffInvite = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        ttl_hours: z.number().int().min(1).max(24 * 30).default(72),
        terms_version: z.string().min(1),
        terms_body: z.string().min(20),
        region_allowlist: z.array(z.string().min(1)).optional().default([]),
        plan_allowlist: z.array(z.string().min(1)).optional().default([]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // 32-byte URL-safe token — shown once.
    const raw = randomBytes(32).toString("base64url");
    const token = `hoi_${raw}`;
    const token_hash = hashToken(token);
    const token_prefix = token.slice(0, 10);
    const terms_hash = hashTerms(data.terms_body);
    const expires_at = new Date(Date.now() + data.ttl_hours * 3600 * 1000).toISOString();

    const { data: row, error } = await context.supabase
      .from("handoff_invites")
      .insert({
        handoff_id: data.handoff_id,
        token_hash,
        token_prefix,
        terms_version: data.terms_version,
        terms_hash,
        terms_body: data.terms_body,
        region_allowlist: data.region_allowlist,
        plan_allowlist: data.plan_allowlist,
        expires_at,
        created_by: context.userId,
      })
      .select("id, expires_at, token_prefix")
      .single();
    if (error) throw error;

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "invite.created",
      actor_user_id: context.userId,
      details: {
        invite_id: row.id,
        token_prefix: row.token_prefix,
        expires_at: row.expires_at,
        terms_version: data.terms_version,
      },
    });

    return {
      ok: true as const,
      id: row.id,
      token, // returned once — client must copy the link now.
      expires_at: row.expires_at,
      token_prefix: row.token_prefix,
    };
  });

export const listHandoffInvites = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ handoff_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("handoff_invites")
      .select(
        "id, token_prefix, terms_version, region_allowlist, plan_allowlist, expires_at, consumed_at, revoked_at, revoked_reason, created_at",
      )
      .eq("handoff_id", data.handoff_id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return { ok: true as const, invites: rows ?? [] };
  });

export const revokeHandoffInvite = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        reason: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_invites")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: data.reason ?? null })
      .eq("id", data.id)
      .is("revoked_at", null)
      .is("consumed_at", null)
      .select("id, handoff_id")
      .maybeSingle();
    if (error) throw error;
    if (row) {
      await context.supabase.from("handoff_events").insert({
        handoff_id: row.handoff_id,
        kind: "invite.revoked",
        actor_user_id: context.userId,
        details: { invite_id: row.id, reason: data.reason ?? null },
      });
    }
    return { ok: true as const };
  });
