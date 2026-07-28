// Operator management of pricing-page access grants.
//
// Admin-gated, matching the tier that gifts tokens: a grant reveals commercial
// pricing to someone outside the customer base, which is a commercial decision
// rather than a support one.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export const listAccessGrants = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { data, error } = await adminAny
      .from("storefront_access_grants")
      .select("id, label, note, expires_at, revoked_at, last_used_at, use_count, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, grants: data ?? [] };
  });

export const createAccessGrant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) =>
    z
      .object({
        label: z.string().min(1).max(120),
        note: z.string().max(500).optional(),
        // Days until it lapses. Defaulted rather than optional: an access link
        // with no end date is one nobody remembers to revoke.
        expiresInDays: z.number().int().min(1).max(365).default(30),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const expiresAt = new Date(Date.now() + data.expiresInDays * 86_400_000).toISOString();
    const { data: row, error } = await adminAny
      .from("storefront_access_grants")
      .insert({
        label: data.label,
        note: data.note ?? null,
        expires_at: expiresAt,
        created_by: (context as { user?: { id?: string } })?.user?.id ?? null,
      })
      .select("id, label, expires_at")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, grant: row };
  });

export const revokeAccessGrant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data }) => {
    // Revoked rather than deleted: the row is the record of who was given
    // access and when, and that outlives the access itself.
    const { error } = await adminAny
      .from("storefront_access_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .is("revoked_at", null);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
