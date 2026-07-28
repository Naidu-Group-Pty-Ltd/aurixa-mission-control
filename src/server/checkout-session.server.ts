// @ts-nocheck
// Checkout-session summary + fulfilment-status helpers, shared by the
// operator server fns (src/lib/checkout-session.functions.ts) and the
// storefront REST endpoint (api/public/storefront/session) that powers the
// receipt page on the Aurixa Systems website.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/server/stripe.server";

const adminAny = supabaseAdmin as any;

/**
 * Proves a session belongs to a handoff: the purchases row (or, as fallback
 * for rows whose initiated-insert failed, the Stripe session metadata) must
 * reference exactly this handoff id. Possession of the (session_id, handoff)
 * pair is the authorisation — it only ever exists in the redirect URL Stripe
 * sent that purchaser to.
 */
export async function sessionMatchesHandoff(
  sessionId: string,
  handoffId: string,
): Promise<boolean> {
  const { data: purchase } = await adminAny
    .from("purchases")
    .select("handoff_id")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();
  if (purchase?.handoff_id) return purchase.handoff_id === handoffId;
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    return (session.metadata?.handoff_id ?? null) === handoffId;
  } catch {
    return false;
  }
}

/**
 * Proves a session belongs to a `?uid=` purchaser: the session's stamped
 * `billing_user_id` metadata must equal the uid. Possession of the
 * (session_id, uid) pair is the authorisation — the session_id only ever
 * exists in the redirect URL Stripe sent that purchaser to, and the uid is the
 * operator-assigned tracking id the checkout was scoped to.
 */
export async function sessionMatchesUid(sessionId: string, uid: string): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    return (session.metadata?.billing_user_id ?? null) === uid;
  } catch {
    return false;
  }
}

export async function buildSessionSummary(sessionId: string) {
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  const meta = (session.metadata ?? {}) as Record<string, string>;
  const mode = meta.mode ?? null;
  const itemSlug = meta.item_slug ?? null;
  const tenantId = meta.tenant_id || null;
  const cloneId = meta.clone_id || null;

  let cloneName: string | null = null;
  if (cloneId) {
    const { data: clone } = await adminAny
      .from("clones")
      .select("name, slug")
      .eq("id", cloneId)
      .maybeSingle();
    cloneName = clone?.name ?? clone?.slug ?? null;
  }

  let tenantName: string | null = null;
  if (!cloneName && tenantId) {
    const { data: tenant } = await supabaseAdmin
      .from("tenants")
      .select("display_name, external_ref")
      .eq("id", tenantId)
      .maybeSingle();
    tenantName = tenant?.display_name ?? tenant?.external_ref ?? null;
  }

  // Attribution (user-attributed pricing workflow): prefer the purchases
  // row, fall back to session metadata for sessions created mid-deploy.
  let originUsername = meta.origin_username || null;
  let originUserId = meta.origin_user_id || null;
  let originSource = meta.origin_source || null;
  const { data: purchase } = await adminAny
    .from("purchases")
    .select("origin_user_id, origin_username, origin_source")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();
  if (purchase) {
    originUserId = purchase.origin_user_id ?? originUserId;
    originUsername = purchase.origin_username ?? originUsername;
    originSource = purchase.origin_source ?? originSource;
  }

  return {
    ok: true as const,
    mode,
    itemSlug,
    cloneId,
    cloneName,
    tenantId,
    tenantName,
    originUserId,
    originUsername,
    originSource,
    amountTotal: session.amount_total,
    currency: session.currency,
    paymentStatus: session.payment_status,
  };
}

export async function fulfillmentStatus(sessionId: string) {
  // Was the webhook event seen + processed? A delayed payment method fulfils
  // on async_payment_succeeded rather than completed, so both count — checking
  // only `completed` would leave the receipt page reporting "webhook not
  // processed" forever for those purchases.
  const { data: events } = await adminAny
    .from("stripe_events")
    .select("processed_at, type, error")
    .in("type", ["checkout.session.completed", "checkout.session.async_payment_succeeded"])
    .filter("payload->>id", "eq", sessionId);
  const rows = (events ?? []) as Array<{
    processed_at: string | null;
    type: string;
    error: string | null;
  }>;
  // Prefer a clean processed row; fall back to whatever we have so a recorded
  // error still surfaces.
  const ev = rows.find((r) => r.processed_at && !r.error) ?? rows[0] ?? null;

  let mode: string | null = null;
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    mode = (session.metadata?.mode as string | undefined) ?? null;
  } catch {
    /* ignore */
  }

  let fulfilled = false;
  if (mode === "setup_package") {
    const { data: sp } = await adminAny
      .from("setup_purchases")
      .select("fulfilled_at, status")
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();
    fulfilled = !!sp?.fulfilled_at;
  } else if (mode === "topup") {
    const { data: ledger } = await adminAny
      .from("token_ledger")
      .select("id")
      .eq("source_ref", `stripe:${sessionId}`)
      .limit(1)
      .maybeSingle();
    fulfilled = !!ledger;
  } else if (mode === "seat_plan") {
    // Seat plan is fulfilled when the webhook processed checkout.session.completed
    fulfilled = !!ev?.processed_at && !ev?.error;
  }

  return {
    ok: true as const,
    mode,
    webhookProcessed: !!ev?.processed_at,
    webhookError: ev?.error ?? null,
    fulfilled,
  };
}
