// Purchase-attribution persistence (user-attributed pricing workflow, Phase 1;
// see docs/user-tracking-pricing-workflow-plan.md).
//
// `purchases` is the reporting layer that spans all checkout modes and records
// which clone/tenant and which originating user a purchase belongs to.
// Fulfilment itself stays in token_ledger / setup_purchases /
// clone_seat_entitlements — nothing here grants credits or seats.
import type Stripe from "stripe";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export type OriginAttribution = {
  originUserId: string | null;
  originUsername: string | null;
  originSource: string;
  handoffId: string | null;
};

export const OPERATOR_SOURCE = "mission_control";

/**
 * Attribution fields in the shape Stripe metadata requires (string values,
 * snake_case keys — the canonical wire names of the attribution contract).
 */
export function attributionMetadata(attr: OriginAttribution): Record<string, string> {
  return {
    origin_user_id: attr.originUserId ?? "",
    origin_username: attr.originUsername ?? "",
    origin_source: attr.originSource,
    handoff_id: attr.handoffId ?? "",
  };
}

/** Inverse of attributionMetadata, tolerant of pre-feature sessions. */
export function attributionFromMetadata(
  md: Record<string, string | undefined> | null | undefined,
): OriginAttribution {
  const m = md ?? {};
  return {
    originUserId: m.origin_user_id || null,
    originUsername: m.origin_username || null,
    originSource: m.origin_source || OPERATOR_SOURCE,
    handoffId: m.handoff_id || null,
  };
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : (v.id ?? null);
}

/**
 * Maps a checkout session onto a `purchases` row patch. Pure — unit tested.
 * Used both at completion time (webhook) and as the upsert body when the
 * initiated-insert never happened (pre-feature sessions, insert failures).
 */
export function purchaseRowFromSession(
  session: Stripe.Checkout.Session,
  status: "completed" | "failed",
  error?: string,
): Record<string, unknown> {
  const md = (session.metadata ?? {}) as Record<string, string>;
  const attr = attributionFromMetadata(md);
  return {
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: stripeId(session.payment_intent),
    stripe_subscription_id: stripeId(session.subscription),
    mode: md.mode ?? "unknown",
    item_id: md.item_id || null,
    item_slug: md.item_slug || null,
    item_name: md.item_name || null,
    quantity: Math.max(1, Number(md.quantity ?? 1) || 1),
    clone_id: md.clone_id || null,
    tenant_id: md.tenant_id || null,
    handoff_id: attr.handoffId,
    origin_user_id: attr.originUserId,
    origin_username: attr.originUsername,
    origin_source: attr.originSource,
    amount_cents: session.amount_total ?? null,
    currency: session.currency ? session.currency.toUpperCase() : null,
    payment_status: session.payment_status ?? null,
    status,
    completed_at: status === "completed" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    ...(error ? { metadata: { fulfilment_error: error } } : {}),
  };
}

/**
 * Records that a checkout session was created ("initiated"). Best-effort by
 * design: attribution bookkeeping must never block a customer from paying, so
 * failures are logged to audit_log and swallowed.
 */
export async function recordPurchaseInitiated(input: {
  sessionId: string;
  mode: string;
  itemId: string;
  itemSlug: string | null;
  itemName?: string | null;
  quantity: number;
  cloneId: string | null;
  tenantId: string | null;
  attribution: OriginAttribution;
}): Promise<void> {
  try {
    const { error } = await adminAny.from("purchases").insert({
      stripe_checkout_session_id: input.sessionId,
      mode: input.mode,
      item_id: input.itemId,
      item_slug: input.itemSlug,
      item_name: input.itemName ?? null,
      quantity: input.quantity,
      clone_id: input.cloneId,
      tenant_id: input.tenantId,
      handoff_id: input.attribution.handoffId,
      origin_user_id: input.attribution.originUserId,
      origin_username: input.attribution.originUsername,
      origin_source: input.attribution.originSource,
      status: "initiated",
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error("recordPurchaseInitiated failed", err);
    try {
      await adminAny.from("audit_log").insert({
        action: "purchase.initiated.record_failed",
        entity_type: "stripe",
        metadata: {
          session_id: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Finalises the `purchases` row for a completed (or permanently failed)
 * checkout. Upserts on the session id so it also covers sessions whose
 * initiated-insert never landed. Idempotent — safe on webhook replays.
 */
export async function finalizePurchaseFromSession(
  session: Stripe.Checkout.Session,
  status: "completed" | "failed",
  error?: string,
): Promise<void> {
  const row = purchaseRowFromSession(session, status, error);
  const { error: dbError } = await adminAny
    .from("purchases")
    .upsert(row, { onConflict: "stripe_checkout_session_id" });
  if (dbError) throw new Error(`finalize_purchase_failed: ${dbError.message}`);
}

/** Marks the purchase matching a refunded charge's payment intent. */
export async function markPurchaseRefunded(
  paymentIntentId: string | null,
  refundAmountCents: number,
  fullyRefunded: boolean,
): Promise<void> {
  if (!paymentIntentId) return;
  await adminAny
    .from("purchases")
    .update({
      status: fullyRefunded ? "refunded" : "completed",
      metadata: { refund_amount_cents: refundAmountCents, partially_refunded: !fullyRefunded },
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_payment_intent_id", paymentIntentId);
}

export type BillingHandoff = {
  id: string;
  clone_id: string | null;
  tenant_id: string | null;
  origin_user_id: string;
  origin_username: string | null;
  origin_source: string;
  intent: string | null;
  return_url: string | null;
  expires_at: string;
  consumed_at: string | null;
};

/** Loads a handoff token if it exists, is unexpired, and unconsumed. */
export async function loadValidHandoff(handoffId: string): Promise<BillingHandoff | null> {
  const { data, error } = await adminAny
    .from("billing_handoffs")
    .select(
      "id, clone_id, tenant_id, origin_user_id, origin_username, origin_source, intent, return_url, expires_at, consumed_at",
    )
    .eq("id", handoffId)
    .maybeSingle();
  if (error || !data) return null;
  const handoff = data as BillingHandoff;
  if (handoff.consumed_at) return null;
  if (new Date(handoff.expires_at).getTime() <= Date.now()) return null;
  return handoff;
}

/** Single-use semantics: mark a handoff consumed once checkout is created. */
export async function consumeHandoff(handoffId: string): Promise<void> {
  await adminAny
    .from("billing_handoffs")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", handoffId)
    .is("consumed_at", null);
}

/**
 * Records a discretionary (non-Stripe) operator action — token grant, comp
 * top-up, plan/seat change — into the purchases oversight ledger, so Mission
 * Control's "secondary manner" of provisioning is as traceable as customer
 * checkouts. `admin_*` modes carry no revenue and are excluded from purchase
 * counts by the rollup aggregation. Best-effort by design: bookkeeping must
 * never fail the underlying grant.
 */
export async function recordAdminAction(input: {
  mode: "admin_grant" | "admin_topup" | "admin_plan_change" | "admin_seat_change";
  cloneId?: string | null;
  tenantId?: string | null;
  itemSlug?: string | null;
  operatorUserId: string;
  operatorUsername?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    let cloneId = input.cloneId ?? null;
    if (!cloneId && input.tenantId) {
      const { data: t } = await adminAny
        .from("tenants")
        .select("clone_id")
        .eq("id", input.tenantId)
        .maybeSingle();
      cloneId = t?.clone_id ?? null;
    }
    const { error } = await adminAny.from("purchases").insert({
      mode: input.mode,
      item_slug: input.itemSlug ?? null,
      quantity: 1,
      clone_id: cloneId,
      tenant_id: input.tenantId ?? null,
      origin_user_id: input.operatorUserId,
      origin_username: input.operatorUsername ?? null,
      origin_source: OPERATOR_SOURCE,
      amount_cents: 0,
      status: "completed",
      completed_at: new Date().toISOString(),
      metadata: input.metadata ?? {},
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error("recordAdminAction failed", err);
  }
}

/** Best-effort display name for an operator-initiated purchase. */
export async function operatorDisplayName(
  userId: string,
  fallbackEmail?: string | null,
): Promise<string | null> {
  try {
    const { data } = await adminAny
      .from("profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    return (data?.display_name as string | undefined) ?? fallbackEmail ?? null;
  } catch {
    return fallbackEmail ?? null;
  }
}
