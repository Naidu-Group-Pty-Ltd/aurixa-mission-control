// Saved payment methods (billing & usage workflow).
//
// Cards are captured on the Aurixa Systems storefront via Stripe Checkout in
// `setup` mode — card data travels browser → Stripe only. Mission Control
// stores nothing but the Stripe payment-method reference plus display fields
// (brand / last4 / expiry), with an ordered role per tenant:
//   priority 1 = primary, 2 = secondary, 3 = backup  (max 3 active cards).
//
// Order integrity is owned by the reorder_payment_methods RPC (advisory-lock
// two-phase rewrite); this module supplies the Stripe plumbing and the row
// bookkeeping used by the webhook and the clone API routes.
import type Stripe from "stripe";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/server/stripe.server";
import { attributionFromMetadata } from "@/server/purchases.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export const MAX_PAYMENT_METHODS = 3;

export const PRIORITY_ROLES: Record<number, string> = {
  1: "primary",
  2: "secondary",
  3: "backup",
};

export type PaymentMethodRow = {
  id: string;
  tenant_id: string;
  clone_id: string | null;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  funding: string | null;
  billing_name: string | null;
  billing_email: string | null;
  priority: number;
  status: string;
  origin_user_id: string | null;
  origin_username: string | null;
  origin_source: string;
  created_at: string;
};

const ROW_COLS =
  "id, tenant_id, clone_id, stripe_customer_id, stripe_payment_method_id, brand, last4, " +
  "exp_month, exp_year, funding, billing_name, billing_email, priority, status, " +
  "origin_user_id, origin_username, origin_source, created_at";

export async function listActivePaymentMethods(tenantId: string): Promise<PaymentMethodRow[]> {
  const { data, error } = await adminAny
    .from("payment_methods")
    .select(ROW_COLS)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("priority", { ascending: true });
  if (error) throw new Error(`payment_methods_list_failed: ${error.message}`);
  return (data ?? []) as PaymentMethodRow[];
}

export async function countActivePaymentMethods(tenantId: string): Promise<number> {
  // Deliberately NOT a `head: true` count: PostgREST answers HEAD on a
  // missing/unknown table with an empty-body 404 that postgrest-js reports as
  // success (count null) — which made the card-setup flow look healthy while
  // the wallet tables didn't exist and every webhook write was failing. A row
  // fetch surfaces the real error (wallets hold at most 3 rows, so this is
  // just as cheap).
  const { data, error } = await adminAny
    .from("payment_methods")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (error) throw new Error(`payment_methods_count_failed: ${error.message}`);
  return (data ?? []).length;
}

/** Sync the tenant's primary card onto the Stripe customer so invoices and
 * off-session charges use it by default. Best-effort — Stripe being briefly
 * unreachable must not fail wallet bookkeeping. */
export async function syncStripeDefaultPaymentMethod(tenantId: string): Promise<void> {
  try {
    const rows = await listActivePaymentMethods(tenantId);
    const primary = rows.find((r) => r.priority === 1) ?? rows[0];
    if (!primary) return;
    await getStripe().customers.update(primary.stripe_customer_id, {
      invoice_settings: { default_payment_method: primary.stripe_payment_method_id },
    });
  } catch (err) {
    console.error("[wallet] syncStripeDefaultPaymentMethod failed:", err);
  }
}

/**
 * Persists the card captured by a completed setup-mode Checkout session.
 * Idempotent: replays and duplicate cards (same Stripe fingerprint) update the
 * existing row instead of inserting. Returns the resulting row, or an error
 * code the webhook treats as permanent.
 */
export async function savePaymentMethodFromSetupSession(
  session: Stripe.Checkout.Session,
): Promise<
  | { ok: true; row: PaymentMethodRow; error?: undefined }
  | { ok: false; error: string; row?: undefined }
> {
  const md = (session.metadata ?? {}) as Record<string, string>;
  const tenantId = md.tenant_id || null;
  if (!tenantId) return { ok: false, error: "missing_tenant" };

  const setupIntentId =
    typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!setupIntentId) return { ok: false, error: "missing_setup_intent" };

  const si = await getStripe().setupIntents.retrieve(setupIntentId, {
    expand: ["payment_method"],
  });
  const pm = si.payment_method as Stripe.PaymentMethod | null;
  if (!pm || typeof pm === "string") return { ok: false, error: "missing_payment_method" };

  const customerId =
    typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
  if (!customerId) return { ok: false, error: "missing_customer" };

  const attr = attributionFromMetadata(md);
  const card = pm.card ?? null;
  const fingerprint = card?.fingerprint ?? null;

  // Replay of the same session → return the existing row.
  const { data: bySession } = await adminAny
    .from("payment_methods")
    .select(ROW_COLS)
    .eq("stripe_checkout_session_id", session.id)
    .eq("status", "active")
    .maybeSingle();
  if (bySession) return { ok: true, row: bySession as PaymentMethodRow };

  // Same physical card already on file for this tenant → refresh the Stripe
  // reference/expiry on the existing row (card was re-added, possibly after
  // reissue) and detach the newly-minted duplicate payment method at Stripe.
  if (fingerprint) {
    const { data: dupe } = await adminAny
      .from("payment_methods")
      .select(ROW_COLS)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .eq("card_fingerprint", fingerprint)
      .maybeSingle();
    if (dupe) {
      await adminAny
        .from("payment_methods")
        .update({
          stripe_payment_method_id: pm.id,
          stripe_setup_intent_id: setupIntentId,
          stripe_checkout_session_id: session.id,
          exp_month: card?.exp_month ?? null,
          exp_year: card?.exp_year ?? null,
          billing_name: pm.billing_details?.name ?? null,
          billing_email: pm.billing_details?.email ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", dupe.id);
      if (dupe.stripe_payment_method_id !== pm.id) {
        try {
          await getStripe().paymentMethods.detach(dupe.stripe_payment_method_id);
        } catch {
          /* already detached or never attached — fine */
        }
      }
      await syncStripeDefaultPaymentMethod(tenantId);
      return { ok: true, row: { ...(dupe as PaymentMethodRow), stripe_payment_method_id: pm.id } };
    }
  }

  const existing = await listActivePaymentMethods(tenantId);
  if (existing.length >= MAX_PAYMENT_METHODS) return { ok: false, error: "card_limit_reached" };
  const taken = new Set(existing.map((r) => r.priority));
  const priority = [1, 2, 3].find((p) => !taken.has(p)) ?? MAX_PAYMENT_METHODS;

  const { data: inserted, error } = await adminAny
    .from("payment_methods")
    .insert({
      tenant_id: tenantId,
      clone_id: md.clone_id || null,
      stripe_customer_id: customerId,
      stripe_payment_method_id: pm.id,
      stripe_setup_intent_id: setupIntentId,
      stripe_checkout_session_id: session.id,
      brand: card?.brand ?? pm.type ?? null,
      last4: card?.last4 ?? null,
      exp_month: card?.exp_month ?? null,
      exp_year: card?.exp_year ?? null,
      funding: card?.funding ?? null,
      // Cardholder identity as Stripe captured it on the hosted page. Display
      // only (no card data): it is what turns an anonymous "Visa •••• 4242"
      // row in the dashboard into "Visa •••• 4242 — Jane Doe".
      billing_name: pm.billing_details?.name ?? null,
      billing_email: pm.billing_details?.email ?? null,
      card_fingerprint: fingerprint,
      priority,
      status: "active",
      origin_user_id: attr.originUserId,
      origin_username: attr.originUsername,
      origin_source: attr.originSource,
      metadata: { handoff_id: attr.handoffId },
    })
    .select(ROW_COLS)
    .single();
  if (error) throw new Error(`payment_method_insert_failed: ${error.message}`);

  if (priority === 1) await syncStripeDefaultPaymentMethod(tenantId);
  return { ok: true, row: inserted as PaymentMethodRow };
}

/** Applies a full desired order (array of row ids, position 1 = primary). */
export async function reorderPaymentMethods(
  tenantId: string,
  orderedIds: string[],
): Promise<{ ok: true; error?: undefined } | { ok: false; error: string }> {
  const { data, error } = await adminAny.rpc("reorder_payment_methods", {
    _tenant_id: tenantId,
    _ordered_ids: orderedIds,
  });
  if (error) return { ok: false, error: error.message };
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    return { ok: false, error: (data as { error?: string }).error ?? "reorder_failed" };
  }
  await syncStripeDefaultPaymentMethod(tenantId);
  return { ok: true };
}

/**
 * Detaches a card at Stripe and retires its row, then compacts the remaining
 * order so priorities stay 1..n (a removed primary promotes the secondary).
 */
export async function detachPaymentMethod(
  tenantId: string,
  rowId: string,
): Promise<{ ok: true; error?: undefined } | { ok: false; error: string }> {
  const { data: row } = await adminAny
    .from("payment_methods")
    .select(ROW_COLS)
    .eq("id", rowId)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .maybeSingle();
  if (!row) return { ok: false, error: "payment_method_not_found" };

  try {
    await getStripe().paymentMethods.detach(row.stripe_payment_method_id);
  } catch (err) {
    // Already detached at Stripe is fine; anything else should not strand the
    // row — the reference is dead either way once we retire it below.
    console.warn("[wallet] stripe detach warning:", (err as Error).message);
  }

  const { error } = await adminAny
    .from("payment_methods")
    .update({
      status: "detached",
      detached_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
  if (error) return { ok: false, error: error.message };

  const remaining = await listActivePaymentMethods(tenantId);
  if (remaining.length > 0) {
    const ordered = [...remaining].sort((a, b) => a.priority - b.priority).map((r) => r.id);
    const compacted = await reorderPaymentMethods(tenantId, ordered);
    if (!compacted.ok) console.error("[wallet] compact after detach failed:", compacted.error);
  }
  return { ok: true };
}

/** Marks a row detached when Stripe tells us the payment method went away
 * out-of-band (payment_method.detached webhook). */
export async function markDetachedByStripeId(stripePaymentMethodId: string): Promise<void> {
  const { data: row } = await adminAny
    .from("payment_methods")
    .select("id, tenant_id")
    .eq("stripe_payment_method_id", stripePaymentMethodId)
    .eq("status", "active")
    .maybeSingle();
  if (!row) return;
  await adminAny
    .from("payment_methods")
    .update({
      status: "detached",
      detached_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  const remaining = await listActivePaymentMethods(row.tenant_id);
  if (remaining.length > 0) {
    const ordered = [...remaining].sort((a, b) => a.priority - b.priority).map((r) => r.id);
    await reorderPaymentMethods(row.tenant_id, ordered);
  }
}

// ── Reconciliation against Stripe ───────────────────────────────────────────

export type StripeWalletTruth = {
  /** False when Stripe could not be reached — the UI must not claim knowledge. */
  verified: boolean;
  /** The payment method Stripe will actually charge, if any. */
  defaultPaymentMethodId: string | null;
  /** Stripe payment-method ids currently attached to the customer. */
  attachedIds: Set<string>;
};

/**
 * Ask Stripe what it actually holds for this tenant's customer.
 *
 * The wallet table is a local mirror, and a mirror can drift: a card detached
 * in the Stripe dashboard, a default changed by a subscription flow, or a
 * syncStripeDefaultPaymentMethod call that failed silently (it is deliberately
 * best-effort) all leave the rows saying one thing while Stripe does another.
 * Showing a confident "Primary" badge that Stripe disagrees with is worse than
 * showing nothing, because the number it governs is a real charge.
 *
 * Never throws: an unreachable Stripe yields verified:false, which the caller
 * renders as "couldn't confirm" rather than as a discrepancy.
 */
export async function readStripeWalletTruth(rows: PaymentMethodRow[]): Promise<StripeWalletTruth> {
  const customerId = rows.find((r) => r.stripe_customer_id)?.stripe_customer_id;
  if (!customerId) {
    return { verified: true, defaultPaymentMethodId: null, attachedIds: new Set() };
  }
  try {
    const stripe = getStripe();
    const [customer, attached] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }),
    ]);
    // A deleted customer carries none of the invoice settings, and the union
    // Stripe returns has to be narrowed before the field is reachable.
    const live = customer.deleted === true ? null : (customer as Stripe.Customer);
    const defaultPm = live?.invoice_settings?.default_payment_method ?? null;
    return {
      verified: true,
      defaultPaymentMethodId: typeof defaultPm === "string" ? defaultPm : (defaultPm?.id ?? null),
      attachedIds: new Set(attached.data.map((pm) => pm.id)),
    };
  } catch (err) {
    console.error("[wallet] readStripeWalletTruth failed:", err);
    return { verified: false, defaultPaymentMethodId: null, attachedIds: new Set() };
  }
}

/**
 * Force the tenant's Stripe default back onto its primary card.
 *
 * The same operation the wallet performs after every reorder, exposed so an
 * operator can repair drift without having to reorder cards to trigger it.
 * Returns the post-sync truth so the caller can confirm it took.
 */
export async function reconcileStripeDefault(
  tenantId: string,
): Promise<{ ok: boolean; defaultPaymentMethodId: string | null }> {
  await syncStripeDefaultPaymentMethod(tenantId);
  const rows = await listActivePaymentMethods(tenantId);
  const truth = await readStripeWalletTruth(rows);
  return { ok: truth.verified, defaultPaymentMethodId: truth.defaultPaymentMethodId };
}
