// What plan a workspace is on right now.
//
// The pricing page needs this to label its buttons honestly: the same card is
// "Get started" to a new workspace, "Upgrade" to one on a cheaper tier, and
// "Downgrade" to one on a dearer tier. Without it every card says "Get
// started", which is wrong for anyone who already pays us.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

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
 * The plan behind a storefront `?uid=` link.
 *
 * Mirrors how uid checkout resolves its tenant, so the plan shown on the
 * pricing page is the plan the purchase would actually change.
 */
export async function planForBillingUserId(uid: string): Promise<CurrentPlan> {
  const { data: clone } = await adminAny
    .from("clones")
    .select("id")
    .eq("billing_user_id", uid)
    .maybeSingle();

  if (clone?.id) {
    const { data: tenant } = await adminAny
      .from("tenants")
      .select("id")
      .eq("clone_id", clone.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (tenant?.id) return planForTenant(tenant.id);
  }

  const { data: direct } = await adminAny
    .from("tenants")
    .select("id")
    .eq("billing_user_id", uid)
    .maybeSingle();
  return planForTenant(direct?.id ?? null);
}
