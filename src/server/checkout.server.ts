// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Shared Stripe checkout engine (user-attributed pricing workflow).
//
// Callers: the operator RPC fns in src/lib/stripe.functions.ts, and the
// storefront REST route (api/public/storefront/checkout) that powers the
// customer-facing pricing page on the Aurixa Systems website. Mission Control
// is the headless billing engine — the customer never needs its UI.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/server/stripe.server";
import { resolveCloneBillingTenant } from "@/server/billing-tenant.server";
import {
  attributionMetadata,
  consumeHandoff,
  loadValidHandoff,
  recordPurchaseInitiated,
} from "@/server/purchases.server";
import { intentAllows } from "@/server/billing-handoffs.server";
import { AURIXA_INVOICE_FOOTER, AURIXA_INVOICE_RENDERING } from "@/lib/brand/aurixa-brand";
import { countActivePaymentMethods, MAX_PAYMENT_METHODS } from "@/server/payment-methods.server";
import {
  contactFromHandoffRow,
  contactMetadata,
  EMPTY_CONTACT,
  syncStripeCustomerContact,
  type BillingContact,
} from "@/server/billing-contact.server";
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
  /** Seat plans carry `annual_stripe_price_id` for the yearly price. */
  metadata?: Record<string, unknown> | null;
  currency: string;
  is_active: boolean;
};

export async function resolveItem(mode: CheckoutMode, itemId: string): Promise<CatalogItem | null> {
  const cols = "id, slug, name, stripe_price_id, currency, is_active, metadata";
  const query =
    mode === "topup"
      ? supabaseAdmin.from("topup_packs").select(cols).eq("id", itemId).maybeSingle()
      : mode === "seat_plan"
        ? supabaseAdmin.from("seat_plans").select(cols).eq("id", itemId).maybeSingle()
        : supabaseAdmin.from("setup_packages").select(cols).eq("id", itemId).maybeSingle();
  const { data } = await query;
  return (data as CatalogItem | null) ?? null;
}

/**
 * Resolve (or create) the tenant's Stripe Customer, populated with whatever we
 * know about the buyer.
 *
 * The contact block is what makes Checkout prefill: Stripe reads the email off
 * the attached Customer (`customer_email` cannot be combined with `customer`),
 * so a Customer created with a name and nothing else guarantees every buyer
 * retypes their email. On an existing Customer the sync only fills blanks —
 * see billing-contact.server.ts for why an org's billing email is not a
 * per-purchase field.
 */
export async function ensureStripeCustomer(
  tenantId: string,
  contact: BillingContact = EMPTY_CONTACT,
): Promise<string> {
  const { data: tenant } = await supabaseAdmin
    .from("tenants")
    .select("id, display_name, external_ref, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) throw new Error("tenant_not_found");

  const orgName =
    tenant.display_name ??
    contact.company ??
    tenant.external_ref ??
    `tenant_${tenantId.slice(0, 8)}`;

  if (tenant.stripe_customer_id) {
    await syncStripeCustomerContact(tenant.stripe_customer_id, contact, { orgName });
    return tenant.stripe_customer_id;
  }

  const customer = await getStripe().customers.create({
    name: orgName,
    // Seeding these at creation time is the whole point — a first-time buyer
    // then sees their own email already filled in on Stripe's page.
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    // Carried on the Customer so that SUBSCRIPTION invoices get it too: Stripe
    // mints those on the renewal cycle with no request of ours to attach
    // settings to, and inherits them from here. `include_inclusive_tax` is not
    // cosmetic — every Aurixa price is tax-inclusive, and the default display
    // would print line items ex-GST and disagree with what was quoted.
    invoice_settings: {
      footer: AURIXA_INVOICE_FOOTER,
      rendering_options: { ...AURIXA_INVOICE_RENDERING },
    },
    metadata: {
      tenant_id: tenantId,
      external_ref: tenant.external_ref ?? "",
      ...contactMetadata(contact),
    },
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
  /** Which Stripe price to use. Defaults to monthly. */
  period?: "monthly" | "annual";
  cloneId: string | null;
  tenantId?: string;
  /** Absolute URL; must contain the {CHECKOUT_SESSION_ID} placeholder. */
  successUrl: string;
  /** Absolute URL. */
  cancelUrl: string;
  attribution: OriginAttribution;
  /** Buyer details to seed the Stripe Customer and prefill Checkout. */
  contact?: BillingContact;
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
  // Annual is a different Stripe price, not a discount applied to the monthly
  // one. Without this the toggle changed the figure on the pricing page and
  // then billed the monthly amount anyway — the page would advertise
  // $7,549.20 a year and charge $699 a month.
  const annualPriceId =
    typeof item.metadata?.annual_stripe_price_id === "string"
      ? (item.metadata.annual_stripe_price_id as string)
      : null;
  const priceId = args.period === "annual" ? annualPriceId : item.stripe_price_id;
  if (!priceId) {
    return {
      ok: false as const,
      error:
        args.period === "annual" ? "annual_price_not_linked" : "stripe_price_not_linked",
    };
  }

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
    // Credit the tenant the clone actually SPENDS from. Provisioning
    // `clone:<slug>` here created a second tenant alongside the one the
    // clone meters under (`prime:<project-ref>`), so a top-up landed on a
    // balance the dashboard never reads — money taken, balance unchanged.
    const resolved = await resolveCloneBillingTenant(clone.id, {
      billingUserId:
        args.attribution.originSource === "storefront_uid" ? args.attribution.originUserId : null,
      fallbackExternalRef: `clone:${clone.slug ?? clone.id}`,
      fallbackDisplayName: clone.name,
    });
    if (!resolved.ok) return { ok: false as const, error: resolved.error };
    tenantId = resolved.tenantId;
  }

  const contact = args.contact ?? EMPTY_CONTACT;

  let customerId: string | undefined;
  let billingUserId = "";
  if (tenantId) {
    try {
      customerId = await ensureStripeCustomer(tenantId, contact);
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
    // Buyer identity, so a purchase can be traced to a person even though the
    // Stripe Customer represents the whole organisation.
    ...contactMetadata(contact),
  };

  // The buyer's own address for THIS purchase's receipt. The Customer's email
  // is the organisation's billing inbox and may belong to someone else, so the
  // person who actually paid would otherwise never receive their own receipt.
  const receiptEmail = contact.email ?? undefined;

  const sessionParams = {
    mode: args.mode === "seat_plan" ? "subscription" : "payment",
    customer: customerId,
    line_items: [{ price: priceId, quantity: args.quantity }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    // Collect the full billing address rather than just country+postcode. It
    // is what Stripe Tax needs to be accurate, what invoices need to be valid,
    // and — combined with customer_update below — what makes the NEXT checkout
    // prefill instead of asking again.
    billing_address_collection: "required",
    metadata: sharedMeta,
    // Write back the address the buyer confirms on Stripe's page. Without this
    // it is captured on the session and then thrown away: the Customer stays
    // blank, automatic_tax keeps failing its address check, and every future
    // purchase re-asks for details we have already been given.
    // `customer_update` requires a real `customer`, which is always set here
    // for tenant-scoped modes.
    //
    // `name` is deliberately NOT 'auto'. Outside the tax-ID form Checkout would
    // write the CARDHOLDER's personal name onto the Customer, and this Customer
    // is the organisation's billing account — its name is the workspace name
    // and belongs on every tax invoice. ensureStripeCustomer owns that field.
    ...(customerId ? { customer_update: { address: "auto" } } : {}),
    // ABN capture (and the equivalent business tax ID elsewhere). Checkout
    // shows the field only where the buyer's country supports it AND the
    // Customer has none saved — so once an ABN is on file, whether typed here
    // or pre-attached from the workspace's settings, the form stops appearing.
    // Optional rather than `required: 'if_supported'`: a buyer without an ABN
    // must still be able to pay.
    tax_id_collection: { enabled: true },
    // Propagate metadata onto the Subscription so that subsequent
    // subscription.* / invoice.* webhook events carry tenant/clone context.
    // One-time payments additionally get a real Stripe invoice (hosted page +
    // PDF) so every purchase surfaces on the Invoices ledger, with the same
    // metadata contract on the invoice itself.
    ...(args.mode === "seat_plan"
      ? { subscription_data: { metadata: sharedMeta } }
      : {
          payment_intent_data: {
            metadata: sharedMeta,
            ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
          },
          // The one-off invoice Stripe issues for this payment. The footer and
          // tax display are set here as well as on the Customer because a
          // one-off invoice is created from THIS request: it does not inherit
          // the Customer's invoice_settings the way a subscription cycle
          // invoice does.
          invoice_creation: {
            enabled: true,
            invoice_data: {
              metadata: sharedMeta,
              footer: AURIXA_INVOICE_FOOTER,
              rendering_options: { ...AURIXA_INVOICE_RENDERING },
            },
          },
        }),
  };

  // Stripe account configuration we cannot see from here must never block a
  // sale. Each entry names a parameter that some accounts reject, how to spot
  // that rejection, and the degraded value to retry with; a checkout only
  // fails once nothing is left to drop.
  const degradations: Array<{
    label: string;
    matches: RegExp;
    apply: (p: typeof sessionParams) => typeof sessionParams;
  }> = [
    {
      label: "automatic_tax",
      matches: /automatic.?tax|tax settings|origin address|head office/i,
      apply: (p) => ({ ...p, automatic_tax: { enabled: false } }),
    },
    {
      // Older API versions and some account shapes reject customer_update.
      // Losing it costs the write-back, not the sale.
      label: "customer_update",
      matches: /customer_update/i,
      apply: (p) => {
        const { customer_update: _drop, ...rest } = p as Record<string, unknown>;
        return rest as typeof sessionParams;
      },
    },
    {
      // Tax ID collection needs Stripe Tax reachable on the account. If it is
      // not, we lose ABN capture for that session — never the sale.
      label: "tax_id_collection",
      matches: /tax_id_collection|tax id/i,
      apply: (p) => ({ ...p, tax_id_collection: { enabled: false } }),
    },
    {
      // Branding on the invoice is presentation. If an account or API version
      // will not take the footer or the tax display, the invoice is still
      // issued and the sale still completes — plainer, but issued.
      label: "invoice_presentation",
      matches: /rendering_options|amount_tax_display|footer/i,
      apply: (p) => {
        const inv = (p as Record<string, unknown>).invoice_creation as
          | { enabled: boolean; invoice_data?: Record<string, unknown> }
          | undefined;
        if (!inv?.invoice_data) return p;
        const { footer: _f, rendering_options: _r, ...keep } = inv.invoice_data;
        return { ...p, invoice_creation: { ...inv, invoice_data: keep } } as typeof p;
      },
    },
  ];

  let session;
  let params: typeof sessionParams = sessionParams as typeof sessionParams;
  const dropped = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    try {
      session = await getStripe().checkout.sessions.create(params);
      break;
    } catch (err) {
      const msg = stripeErrorMessage(err);
      const next = degradations.find((d) => !dropped.has(d.label) && d.matches.test(msg));
      if (!next || attempt >= degradations.length) {
        // Surface the sanitized Stripe reason ('No such price…', key/mode
        // mismatches, …) instead of a blind checkout_failed 500 — these are
        // config errors an operator must see to fix.
        console.error("[checkout] session create failed:", msg);
        return { ok: false as const, error: `stripe: ${msg}` };
      }
      console.warn(`[checkout] ${next.label} unavailable, retrying without it:`, msg);
      dropped.add(next.label);
      params = next.apply(params);
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
  /** Which Stripe price to use. Defaults to monthly. */
  period?: "monthly" | "annual";
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
    period: input.period,
    // Scope comes strictly from the handoff — input cannot redirect the
    // purchase onto another clone or tenant.
    cloneId: handoff.clone_id,
    tenantId: handoff.tenant_id ?? undefined,
    // Buyer details travelled server-to-server with the handoff; the browser
    // never carried them, so they cannot have been tampered with in the URL.
    contact: contactFromHandoffRow(handoff as unknown as Record<string, unknown>),
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
  /** Which Stripe price to use. Defaults to monthly. */
  period?: "monthly" | "annual";
  successUrl: string;
  cancelUrl: string;
  /** Optional buyer details from the storefront. A `uid` is a stable, public
   *  link with no user attached, so anything here is self-declared and used
   *  only to seed blank Customer fields — never to change an established
   *  billing email. */
  contact?: BillingContact;
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
    // Same rule as startCheckoutCore: reuse the clone's existing (metering)
    // tenant rather than provisioning a parallel `clone:<slug>` one.
    const resolved = await resolveCloneBillingTenant(clone.id, {
      billingUserId: uid,
      fallbackExternalRef: `clone:${clone.slug ?? clone.id}`,
      fallbackDisplayName: clone.name,
    });
    if (!resolved.ok) return { ok: false as const, error: resolved.error };
    tenantId = resolved.tenantId;
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
    period: input.period,
    cloneId,
    tenantId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    contact: input.contact ?? EMPTY_CONTACT,
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
  contact?: BillingContact;
  handoffToConsume?: string | null;
};

export async function startCardSetupCore(args: CardSetupCoreArgs) {
  const existing = await countActivePaymentMethods(args.tenantId);
  if (existing >= MAX_PAYMENT_METHODS) {
    return { ok: false as const, error: "card_limit_reached" };
  }

  const contact = args.contact ?? EMPTY_CONTACT;

  let customerId: string;
  try {
    // Seeds email/phone/name onto the Customer. Setup mode does not support
    // Stripe's field-prefill features, but it DOES render the attached
    // Customer's email — so populating the Customer is the only way the
    // card-save page arrives with anything already filled in.
    customerId = await ensureStripeCustomer(args.tenantId, contact);
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
    ...contactMetadata(contact),
  };

  let session;
  try {
    session = await getStripe().checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      // Capture the cardholder's full billing address alongside the card. It
      // is stored on the payment method at Stripe (never here beyond the
      // display name), and it is what lets a later off-session charge and its
      // invoice carry a complete, tax-valid billing record.
      billing_address_collection: "required",
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
    contact: contactFromHandoffRow(handoff as unknown as Record<string, unknown>),
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
  contact?: BillingContact;
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
    // Same rule as startCheckoutCore: reuse the clone's existing (metering)
    // tenant rather than provisioning a parallel `clone:<slug>` one.
    const resolved = await resolveCloneBillingTenant(clone.id, {
      billingUserId: uid,
      fallbackExternalRef: `clone:${clone.slug ?? clone.id}`,
      fallbackDisplayName: clone.name,
    });
    if (!resolved.ok) return { ok: false as const, error: resolved.error };
    tenantId = resolved.tenantId;
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
    contact: input.contact ?? EMPTY_CONTACT,
    attribution: {
      originUserId: uid,
      originUsername: displayName,
      originSource: "storefront_uid",
      handoffId: null,
    },
  });
}
