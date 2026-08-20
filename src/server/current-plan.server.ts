// What plan a workspace is on right now.
//
// The pricing page needs this to label its buttons honestly: the same card is
// "Get started" to a new workspace, "Upgrade" to one on a cheaper tier, and
// "Downgrade" to one on a dearer tier. Without it every card says "Get
// started", which is wrong for anyone who already pays us.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { rankTenantCandidates, type TenantCandidate } from "@/server/billing-tenant.server";

const adminAny = supabaseAdmin;

export type CurrentPlan = { slug: string; name: string | null } | null;

/** The plan on a tenant, or null when it has none (never subscribed, exempt). */
export async function planForTenant(tenantId: string | null): Promise<CurrentPlan> {
  if (!tenantId) return null;
  const { data } = await adminAny
    .from("tenants")
    .select("billing_plans:plan_id(slug, name)")
    .eq("id", tenantId)
    .maybeSingle();
  const plan = data?.billing_plans;
  return plan?.slug ? { slug: plan.slug, name: plan.name ?? null } : null;
}

/**
 * Which workspace a storefront `?uid=` link points at — without creating one.
 *
 * Ranked exactly as checkout and the subscription webhook rank it, because it
 * has to reach the same answer they do. A plan change is recorded against the
 * tenant the webhook picked; looking it up against a different one would show
 * the workspace nothing and leave the notice unread forever.
 *
 * Deliberately read-only: the purchase path may provision a tenant for a clone
 * that has none, but merely looking at a pricing page must not.
 */
export async function tenantIdForBillingUserId(uid: string): Promise<string | null> {
  const { data: clone } = await adminAny
    .from("clones")
    .select("id")
    .eq("billing_user_id", uid)
    .maybeSingle();

  if (clone?.id) {
    const { data: rows } = await adminAny
      .from("tenants")
      .select("id, external_ref, billing_user_id, created_at")
      .eq("clone_id", clone.id);
    const best = rankTenantCandidates((rows ?? []) as TenantCandidate[], {
      billingUserId: uid,
    })[0];
    if (best?.id) return best.id;
  }

  const { data: direct } = await adminAny
    .from("tenants")
    .select("id")
    .eq("billing_user_id", uid)
    .maybeSingle();
  return direct?.id ?? null;
}

/**
 * The plan behind a storefront `?uid=` link.
 *
 * Mirrors how uid checkout resolves its tenant, so the plan shown on the
 * pricing page is the plan the purchase would actually change.
 */
export async function planForBillingUserId(uid: string): Promise<CurrentPlan> {
  return planForTenant(await tenantIdForBillingUserId(uid));
}
