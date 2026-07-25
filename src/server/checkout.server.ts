// @ts-nocheck
// Shared Stripe checkout engine (user-attributed pricing workflow).
//
// Callers: the operator RPC fns in src/lib/stripe.functions.ts, and the
// storefront REST route (api/public/storefront/checkout) that powers the
// customer-facing pricing page on the Aurixa Systems website. Mission Control
// is the headless billing engine — the customer never needs its UI.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/server/stripe.server";
import { ensureTenant } from "@/server/clone-api-keys.server";
import {
  attributionMetadata,
  consumeHandoff,
  loadValidHandoff,
  recordPurchaseInitiated,
} from "@/server/purchases.server";
import { intentAllows } from "@/server/billing-handoffs.server";
import { countActivePaymentMethods, MAX_PAYMENT_METHODS } from "@/server/payment-methods.server";
import type { OriginAttribution } from "@/server/purchases.server";

export type CheckoutMode = "topup" | "seat_plan" | "setup_package";

/**
 * Sanitized, operator-actionable message from a Stripe SDK error. Stripe's
 * `raw.message` for config failures ("No such price: …", "You must configure
 * your tax settings…") contains no secrets and is exactly what an operator
 * needs to see; anything unexpected degrades to the generic Error message.
 */
function stripeErrorMessage(err: unknown): string {
  const e = err as { raw?: { message?: string }; message?: string } | null;
  return String(e?.raw?.message ?? e?.message ?? "stripe_error").slice(0, 300);
}

type CatalogItem = {
  id: string;
  slug: string;
  name: string;
  stripe_price_id: string | null;
  currency: string;
  is_active: boolean;
};

export async function resolveItem(mode: CheckoutMode, itemId: string): Promise<CatalogItem | null> {
  const cols = "id, slug, name, stripe_price_id, currency, is_active";
  const query =
    mode === "topup"
      ? supabaseAdmin.from("topup_packs").select(cols).eq("id", itemId).maybeSingle()
      : mode === "seat_plan"
        ? supabaseAdmin.from("seat_plans").select(cols).eq("id", itemId).maybeSingle()
        : supabaseAdmin.from("setup_packages").select(cols).eq("id", itemId).maybeSingle();
  const { data } = await query;
  return (data as CatalogItem | null) ?? null;
}

export async function ensureStripeCustomer(tenantId: string): Promise<string> {
  const { data: tenant } = await supabaseAdmin
    .from("tenants")
    .select("id, display_name, external_ref, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) throw new Error("tenant_not_found");
  if (tenant.stripe_customer_id) return tenant.stripe_customer_id;

  const customer = await getStripe().customers.create({
    name: tenant.display_name ?? tenant.external_ref ?? `tenant_${tenantId.slice(0, 8)}`,
    metadata: { tenant_id: tenantId, external_ref: tenant.external_ref ?? "" },
  });
  await supabaseAdmin
    .from("tenants")
    .update({ stripe_customer_id: customer.id })
    .eq("id", tenantId);
  return customer.id;
}

export type CheckoutCoreArgs = {
  mode: CheckoutMode;
  itemId: string;
  quantity: number;
  cloneId: string | null;
  tenantId?: string;
  /** Absolute URL; must contain the {CHECKOUT_SESSION_ID} placeholder. */
  successUrl: string;
  /** Absolute URL. */
  cancelUrl: string;
  attribution: OriginAttribution;
  /** Single-use handoff to burn once a session exists. */
  handoffToConsume?: string | null;
};

/**
 * Shared checkout core. Callers are responsible for authorisation and for
 * resolving attribution; everything from catalog lookup to the purchases
 * bookkeeping lives here.
 */
export async function startCheckoutCore(args: CheckoutCoreArgs) {
  const item = await resolveItem(args.mode, args.itemId);
  if (!item) return { ok: false as const, error: "item_not_found" };
  if (!item.is_active) return { ok: false as const, error: "item_inactive" };
  if (!item.stripe_price_id) return { ok: false as const, error: "stripe_price_not_linked" };

  // Topups + setup packages need a tenant. If a cloneId is supplied without
  // an explicit tenantId, auto-resolve (or provision) the clone's primary
  // tenant so the pricing page can be fully client-centric.
  const cloneId = args.cloneId;
  let tenantId = args.tenantId;
  if ((args.mode === "topup" || args.mode === "setup_package") && !tenantId) {
    if (!cloneId) return { ok: false as const, error: "tenant_or_clone_required" };
    // Look up clone display name for nicer Stripe customer naming.
    const { data: clone } = await supabaseAdmin
      .from("clones")
      .select("id, name, slug")
      .eq("id", cloneId)
      .maybeSingle();
    if (!clone) return { ok: false as const, error: "clone_not_found" };
    const ensured = await ensureTenant(clone.id, `clone:${clone.slug ?? clone.id}`, clone.name);
    if (!ensured.ok) return { ok: false as const, error: ensured.error };
    tenantId = ensured.tenantId;
  }

  let customerId: string | undefined;
  let billingUserId = "";
  if (tenantId) {
    try {
      customerId = await ensureStripeCustomer(tenantId);
    } catch (err) {
      const msg = stripeErrorMessage(err);
      console.error("[checkout] ensureStripeCustomer failed:", msg);
      return { ok: false as const, error: `stripe_customer: ${msg}` };
    }
    // Operator-assigned tracking id for this tenant/clone — stamped onto every
    // session so payments and the exact products bought are attributable to it
    // regardless of whether checkout arrived via a handoff or a ?uid= link.
    const { data: t } = await supabaseAdmin
      .from("tenants")
      .select("billing_user_id")
      .eq("id", tenantId)
      .maybeSingle();
    billingUserId = t?.billing_user_id ?? "";
  }

  const sharedMeta = {
    mode: args.mode,
    item_id: args.itemId,
    item_slug: item.slug,
    item_name: item.name,
    tenant_id: tenantId ?? "",
    clone_id: cloneId ?? "",
    billing_user_id: billingUserId,
    quantity: String(args.quantity),
    // Attribution contract fields — propagate to the webhook via Stripe so
    // the purchases ledger knows who initiated this checkout, from where.
    ...attributionMetadata(args.attribution),
  };

  const sessionParams = {
    mode: args.mode === "seat_plan" ? "subscription" : "payment",
    customer: customerId,
    line_items: [{ price: item.stripe_price_id, quantity: args.quantity }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    metadata: sharedMeta,
    // Propagate metadata onto the Subscription so that subsequent
    // subscription.* / invoice.* webhook events carry tenant/clone context.
    // One-time payments additionally get a real Stripe invoice (hosted page +
    // PDF) so every purchase surfaces on the Invoices ledger, with the same
    // metadata contract on the invoice itself.
    ...(args.mode === "seat_plan"
      ? { subscription_data: { metadata: sharedMeta } }
      : {
          payment_intent_data: { metadata: sharedMeta },
          invoice_creation: { enabled: true, invoice_data: { metadata: sharedMeta } },
        }),
  };

  let session;
  try {
    session = await getStripe().checkout.sessions.create(sessionParams);
  } catch (err) {
    const msg = stripeErrorMessage(err);
    // Stripe Tax not being configured on the account must never block a
    // checkout — retry once without automatic tax and let it succeed.
    if (/automatic.?tax|tax settings|origin address|head office/i.test(msg)) {
      console.warn("[checkout] automatic_tax unavailable, retrying without it:", msg);
      try {
        session = await getStripe().checkout.sessions.create({
          ...sessionParams,
          automatic_tax: { enabled: false },
        });
      } catch (retryErr) {
        const retryMsg = stripeErrorMessage(retryErr);
        console.error("[checkout] session create failed after tax retry:", retryMsg);
        return { ok: false as const, error: `stripe: ${retryMsg}` };
      }
    } else {
      // Surface the sanitized Stripe reason ('No such price…', key/mode
      // mismatches, …) instead of a blind checkout_failed 500 — these are
      // config errors an operator must see to fix.
      console.error("[checkout] session create failed:", msg);
      return { ok: false as const, error: `stripe: ${msg}` };
    }
  }

  // Attribution bookkeeping. Best-effort insert (never blocks checkout);
  // the handoff is single-use, so burn it now that a session exists.
  await recordPurchaseInitiated({
    sessionId: session.id,
    mode: args.mode,
    itemId: args.itemId,
    itemSlug: item.slug,
    itemName: item.name,
    quantity: args.quantity,
    cloneId,
    tenantId: tenantId ?? null,
    attribution: args.attribution,
  });
  if (args.handoffToConsume) await consumeHandoff(args.handoffToConsume);

  return { ok: true as const, url: session.url, sessionId: session.id };
}

export type HandoffCheckoutInput = {
  handoffId: string;
  mode: CheckoutMode;
  itemId: string;
  quantity: number;
  /** Absolute URLs for the post-checkout redirect (storefront pages). */
  successUrl: string;
  cancelUrl: string;
};

/**
 * Handoff-scoped checkout: the single-use, expiring, server-minted token IS
 * the credential. Scope (clone/tenant) comes strictly from the handoff, the
 * purchasable item is restricted by its intent, and the token is burned the
 * moment a Stripe session exists. Shared by the RPC fn and the storefront
 * REST endpoint.
 */
export async function startHandoffCheckout(input: HandoffCheckoutInput) {
  const handoff = await loadValidHandoff(input.handoffId);
  if (!handoff) return { ok: false as const, error: "handoff_invalid" };
  if (!intentAllows(handoff.intent, input.mode, input.itemId)) {
    return { ok: false as const, error: "handoff_intent_mismatch" };
  }

  return await startCheckoutCore({
    mode: input.mode,
    itemId: input.itemId,
    quantity: input.quantity,
    // Scope comes strictly from the handoff — input cannot redirect the
    // purchase onto another clone or tenant.
    cloneId: handoff.clone_id,
    tenantId: handoff.tenant_id ?? undefined,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    attribution: {
      originUserId: handoff.origin_user_id,
      originUsername: handoff.origin_username,
      originSource: handoff.origin_source,
      handoffId: handoff.id,
    },
    handoffToConsume: handoff.id,
  });
}

export type UidCheckoutInput = {
  billingUserId: string;
  mode: CheckoutMode;
  itemId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
};

/**
 * `?uid=`-scoped checkout for the public pricing page. The operator-assigned
 * `billing_user_id` resolves to a clone (admins set it there) or, failing
 * that, a global/prime tenant carrying the id. Scope is pinned to that
 * resolution and the uid becomes the attribution origin. Unlike a handoff the
 * uid is stable and reusable, so nothing is burned.
 */
export async function startUidCheckout(input: UidCheckoutInput) {
  const uid = input.billingUserId.trim();
  if (!uid) return { ok: false as const, error: "uid_required" };

  const { data: clone } = await supabaseAdmin
    .from("clones")
    .select("id, name, slug")
    .eq("billing_user_id", uid)
    .maybeSingle();

  let cloneId: string | null = null;
  let tenantId: string | undefined;
  let displayName: string | null = null;

  if (clone) {
    cloneId = clone.id;
    displayName = clone.name ?? clone.slug ?? null;
    const ensured = await ensureTenant(clone.id, `clone:${clone.slug ?? clone.id}`, clone.name);
    if (!ensured.ok) return { ok: false as const, error: ensured.error };
    tenantId = ensured.tenantId;
  } else {
    const { data: tenant } = await supabaseAdmin
      .from("tenants")
      .select("id, clone_id, display_name")
      .eq("billing_user_id", uid)
      .maybeSingle();
    if (!tenant) return { ok: false as const, error: "uid_unknown" };
    tenantId = tenant.id;
    cloneId = tenant.clone_id ?? null;
    displayName = tenant.display_name ?? null;
  }

  return await startCheckoutCore({
    mode: input.mode,
    itemId: input.itemId,
    quantity: input.quantity,
    cloneId,
    tenantId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    attribution: {
      originUserId: uid,
      originUsername: displayName,
      originSource: "storefront_uid",
      handoffId: null,
    },
  });
}

// ── Saved cards (wallet) — Stripe Checkout in `setup` mode ──────────────────
//
// Same credential model and redirect plumbing as purchases, but no catalog
// item and no money moves: the session only vaults a payment method against
// the tenant's Stripe customer. The webhook (checkout.session.completed with
// session.mode === 'setup') persists the resulting card reference.

export type CardSetupCoreArgs = {
  cloneId: string | null;
  tenantId: string;
  successUrl: string;
  cancelUrl: string;
  attribution: OriginAttribution;
  handoffToConsume?: string | null;
};

export async function startCardSetupCore(args: CardSetupCoreArgs) {
  const existing = await countActivePaymentMethods(args.tenantId);
  if (existing >= MAX_PAYMENT_METHODS) {
    return { ok: false as const, error: "card_limit_reached" };
  }

  let customerId: string;
  try {
    customerId = await ensureStripeCustomer(args.tenantId);
  } catch (err) {
    const msg = stripeErrorMessage(err);
    console.error("[wallet] ensureStripeCustomer failed:", msg);
    return { ok: false as const, error: `stripe_customer: ${msg}` };
  }

  const meta = {
    kind: "save_card",
    tenant_id: args.tenantId,
    clone_id: args.cloneId ?? "",
    ...attributionMetadata(args.attribution),
  };

  let session;
  try {
    session = await getStripe().checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: meta,
    });
  } catch (err) {
    const msg = stripeErrorMessage(err);
    console.error("[wallet] setup session create failed:", msg);
    return { ok: false as const, error: `stripe: ${msg}` };
  }

  // Traceability: card-save attempts land in the audit log (they are not
  // purchases, so the purchases ledger is not the right home).
  try {
    await supabaseAdmin.from("audit_log").insert({
      action: "payment_method.setup_started",
      entity_type: "stripe",
      metadata: {
        session_id: session.id,
        tenant_id: args.tenantId,
        clone_id: args.cloneId,
        origin_user_id: args.attribution.originUserId,
        origin_username: args.attribution.originUsername,
        origin_source: args.attribution.originSource,
      },
    });
  } catch {
    /* best effort */
  }

  if (args.handoffToConsume) await consumeHandoff(args.handoffToConsume);
  return { ok: true as const, url: session.url, sessionId: session.id };
}

export async function startHandoffCardSetup(input: {
  handoffId: string;
  successUrl: string;
  cancelUrl: string;
}) {
  const handoff = await loadValidHandoff(input.handoffId);
  if (!handoff) return { ok: false as const, error: "handoff_invalid" };
  if (!handoff.tenant_id) return { ok: false as const, error: "handoff_missing_tenant" };

  return await startCardSetupCore({
    cloneId: handoff.clone_id,
    tenantId: handoff.tenant_id,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    attribution: {
      originUserId: handoff.origin_user_id,
      originUsername: handoff.origin_username,
      originSource: handoff.origin_source,
      handoffId: handoff.id,
    },
    handoffToConsume: handoff.id,
  });
}

export async function startUidCardSetup(input: {
  billingUserId: string;
  successUrl: string;
  cancelUrl: string;
}) {
  const uid = input.billingUserId.trim();
  if (!uid) return { ok: false as const, error: "uid_required" };

  const { data: clone } = await supabaseAdmin
    .from("clones")
    .select("id, name, slug")
    .eq("billing_user_id", uid)
    .maybeSingle();

  let cloneId: string | null = null;
  let tenantId: string | undefined;
  let displayName: string | null = null;

  if (clone) {
    cloneId = clone.id;
    displayName = clone.name ?? clone.slug ?? null;
    const ensured = await ensureTenant(clone.id, `clone:${clone.slug ?? clone.id}`, clone.name);
    if (!ensured.ok) return { ok: false as const, error: ensured.error };
    tenantId = ensured.tenantId;
  } else {
    const { data: tenant } = await supabaseAdmin
      .from("tenants")
      .select("id, clone_id, display_name")
      .eq("billing_user_id", uid)
      .maybeSingle();
    if (!tenant) return { ok: false as const, error: "uid_unknown" };
    tenantId = tenant.id;
    cloneId = tenant.clone_id ?? null;
    displayName = tenant.display_name ?? null;
  }

  return await startCardSetupCore({
    cloneId,
    tenantId: tenantId as string,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    attribution: {
      originUserId: uid,
      originUsername: displayName,
      originSource: "storefront_uid",
      handoffId: null,
    },
  });
}
