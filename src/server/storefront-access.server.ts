// Who may see the restricted parts of the public pricing page.
//
// Add-on modules, onboarding packages and report economics are commercial
// detail we do not publish to the open web. Three ways in, and no others:
//
//   • a `?h=` handoff  — minted server-to-server by a workspace
//   • a `?uid=` link   — an operator-assigned billing id on a clone/tenant
//   • an `?access=` grant — deliberately issued to a named outsider
//
// Mission Control is the only place that can answer this. The storefront asks
// before it serves the data, rather than the browser asking before it renders
// it: hiding a section in the UI is not a gate while the same JSON is one
// request away.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadValidHandoff } from "@/server/purchases.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export type AccessReason =
  | "handoff"
  | "workspace"
  | "grant"
  | "no_credential"
  | "handoff_invalid"
  | "uid_unknown"
  | "grant_unknown"
  | "grant_revoked"
  | "grant_expired";

export type AccessDecision = {
  granted: boolean;
  reason: AccessReason;
  /** Who the access belongs to, for display ("Acme Partners"). */
  label: string | null;
};

export type GrantRow = {
  id: string;
  label: string | null;
  revoked_at: string | null;
  expires_at: string | null;
};

/**
 * Whether a grant row still confers access. Pure — unit tested.
 *
 * Revocation is checked before expiry so a revoked-and-expired grant reports
 * the deliberate act rather than the incidental one; an operator asking "why
 * did this stop working" should be told the answer they can act on.
 */
export function evaluateGrant(grant: GrantRow | null, now: Date): AccessDecision {
  if (!grant) return { granted: false, reason: "grant_unknown", label: null };
  if (grant.revoked_at) return { granted: false, reason: "grant_revoked", label: grant.label };
  if (grant.expires_at && Date.parse(grant.expires_at) <= now.getTime()) {
    return { granted: false, reason: "grant_expired", label: grant.label };
  }
  return { granted: true, reason: "grant", label: grant.label };
}

/** A token must look like a UUID before it ever reaches the database. */
export const isGrantToken = (v: string | null | undefined): v is string =>
  !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

/**
 * Resolve a visitor's access to the restricted sections.
 *
 * Order matters only in that the first credential that works wins; a visitor
 * with a workspace link never needs a grant. Nothing here consumes a handoff —
 * they are single-use for CHECKOUT, and looking at a price list must not burn
 * someone's ability to buy.
 */
export async function resolveStorefrontAccess(input: {
  h?: string | null;
  uid?: string | null;
  token?: string | null;
}): Promise<AccessDecision> {
  const { h, uid, token } = input;

  if (h) {
    const handoff = await loadValidHandoff(h).catch(() => null);
    if (handoff) return { granted: true, reason: "handoff", label: null };
    // Fall through: an expired handoff should not stop a valid grant working.
    if (!uid && !token) return { granted: false, reason: "handoff_invalid", label: null };
  }

  if (uid) {
    const trimmed = uid.trim();
    if (trimmed && trimmed.length <= 200) {
      const [{ data: clone }, { data: tenant }] = await Promise.all([
        adminAny.from("clones").select("name").eq("billing_user_id", trimmed).maybeSingle(),
        adminAny
          .from("tenants")
          .select("display_name")
          .eq("billing_user_id", trimmed)
          .maybeSingle(),
      ]);
      if (clone || tenant) {
        return {
          granted: true,
          reason: "workspace",
          label: clone?.name ?? tenant?.display_name ?? null,
        };
      }
      if (!token) return { granted: false, reason: "uid_unknown", label: null };
    }
  }

  if (isGrantToken(token)) {
    const { data } = await adminAny
      .from("storefront_access_grants")
      .select("id, label, revoked_at, expires_at")
      .eq("id", token.trim())
      .maybeSingle();
    const decision = evaluateGrant((data as GrantRow) ?? null, new Date());

    if (decision.granted) {
      // Best-effort usage trail. An access check must not fail because the
      // bookkeeping write did.
      adminAny
        .from("storefront_access_grants")
        .update({ last_used_at: new Date().toISOString(), use_count: (data?.use_count ?? 0) + 1 })
        .eq("id", token.trim())
        .then(
          () => {},
          () => {},
        );
    }
    return decision;
  }

  return { granted: false, reason: token ? "grant_unknown" : "no_credential", label: null };
}
