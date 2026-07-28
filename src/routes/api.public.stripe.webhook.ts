// Stripe webhook receiver.
// Verifies the signature, dedupes events atomically, fans out per-event
// handlers, and returns 5xx on internal failures so Stripe retries.
import { createFileRoute } from "@tanstack/react-router";
import type Stripe from "stripe";
import { getStripe, getStripeCryptoProvider } from "@/server/stripe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  attributionFromMetadata,
  finalizePurchaseFromSession,
  markPurchaseRefunded,
} from "@/server/purchases.server";
import {
  markDetachedByStripeId,
  savePaymentMethodFromSetupSession,
} from "@/server/payment-methods.server";
import { upsertInvoiceRecord } from "@/server/invoices.server";
import { recordTenantTaxIdFromSession } from "@/server/billing-contact.server";
import { balanceSnapshot, fireTokenWebhook } from "@/server/token-webhooks.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Raised for events that can never succeed (bad/missing metadata, unknown mode,
// inactive pack). These are acked with 200 so Stripe stops retrying and the
// reason is recorded on the event row. Anything else is transient → 5xx so
// Stripe retries, and we leave the event unprocessed for the next attempt.
class PermanentError extends Error {}

/**
 * Has this session's money actually landed? `paid` is the normal card outcome;
 * `no_payment_required` covers a fully discounted order. Anything else (most
 * often `unpaid` for a delayed payment method) is not yet spendable.
 */
function isPaidSession(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

/**
 * Atomic idempotency claim using the unique constraint on
 * stripe_events.stripe_event_id (no TOCTOU read-then-write):
 *   - "claimed":   we inserted the row; we own first processing.
 *   - "duplicate": row exists AND was already processed → skip.
 *   - "retry":     row exists but processing never completed (a prior attempt
 *                  failed transiently) → reprocess (handlers are idempotent).
 */
async function claimEvent(event: Stripe.Event): Promise<"claimed" | "duplicate" | "retry"> {
  const { error } = await adminAny.from("stripe_events").insert({
    stripe_event_id: event.id,
    type: event.type,
    payload: event,
  });
  if (!error) return "claimed";
  // 23505 = unique_violation → already inserted by a prior delivery/worker.
  if (error.code === "23505") {
    const { data } = await adminAny
      .from("stripe_events")
      .select("processed_at")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    return data?.processed_at ? "duplicate" : "retry";
  }
  // Any other error is a real DB problem — let the caller fail with 5xx.
  throw new Error(`claim_event_failed: ${error.message}`);
}

async function markProcessed(eventId: string, error?: string) {
  await adminAny
    .from("stripe_events")
    .update({ processed_at: new Date().toISOString(), error: error ?? null })
    .eq("stripe_event_id", eventId);
}

async function audit(action: string, metadata: Record<string, unknown>) {
  await adminAny.from("audit_log").insert({ action, entity_type: "stripe", metadata });
}

// Operator-facing signal that an attributed purchase landed. Best effort —
// notification failures must not fail the webhook (fulfilment already ran).
async function notifyPurchaseCompleted(session: Stripe.Checkout.Session) {
  try {
    const md = (session.metadata ?? {}) as Record<string, string>;
    const attr = attributionFromMetadata(md);
    const amount =
      session.amount_total != null
        ? `${(session.amount_total / 100).toFixed(2)} ${(session.currency ?? "aud").toUpperCase()}`
        : "unknown amount";
    const buyer = attr.originUsername ?? attr.originUserId ?? "unknown user";
    await adminAny.from("notifications").insert({
      kind: "purchase_completed",
      severity: "info",
      title: `Purchase completed: ${md.item_slug ?? md.mode ?? "item"}`,
      body: `${buyer} (${attr.originSource}) purchased ${md.item_slug ?? md.item_id ?? "an item"} for ${amount}.`,
      clone_id: md.clone_id || null,
      url: "/settings/billing",
      metadata: {
        session_id: session.id,
        mode: md.mode ?? null,
        item_slug: md.item_slug ?? null,
        tenant_id: md.tenant_id || null,
        origin_user_id: attr.originUserId,
        origin_username: attr.originUsername,
        origin_source: attr.originSource,
      },
    });
  } catch (err) {
    console.error("notifyPurchaseCompleted failed", err);
  }
}

// ---------- Event handlers ----------

// Setup-mode sessions vault a card (wallet flow) — no money moves and no
// purchases row exists for them, so they bypass fulfilment entirely.
async function handleSetupSessionCompleted(session: Stripe.Checkout.Session) {
  const saved = await savePaymentMethodFromSetupSession(session);
  if (!saved.ok) throw new PermanentError(`save_payment_method:${saved.error}`);

  const md = (session.metadata ?? {}) as Record<string, string>;
  const attr = attributionFromMetadata(md);
  try {
    await adminAny.from("notifications").insert({
      kind: "tokens_alert",
      severity: "info",
      title: "Payment method saved",
      body: `${attr.originUsername ?? attr.originUserId ?? "A user"} (${attr.originSource}) saved a ${saved.row.brand ?? "card"} •••• ${saved.row.last4 ?? "????"}.`,
      clone_id: md.clone_id || null,
      url: "/settings/billing",
      metadata: {
        session_id: session.id,
        tenant_id: md.tenant_id || null,
        payment_method_row_id: saved.row.id,
        brand: saved.row.brand,
        last4: saved.row.last4,
        priority: saved.row.priority,
      },
    });
  } catch (err) {
    console.error("payment-method notification failed", err);
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode === "setup") {
    await handleSetupSessionCompleted(session);
    return;
  }
  // Fulfil first; then finalise the attribution row. Permanent fulfilment
  // failures mark the purchase 'failed' before re-throwing so the ledger
  // reflects reality even for unprocessable events.
  try {
    await fulfillCheckout(session);
  } catch (err) {
    if (err instanceof PermanentError) {
      try {
        await finalizePurchaseFromSession(session, "failed", err.message);
      } catch (finalizeErr) {
        console.error("finalizePurchaseFromSession(failed) errored", finalizeErr);
      }
    }
    throw err;
  }

  // A delayed payment method's `completed` event arrives before the money
  // does. Nothing has been fulfilled yet, so leave the purchase in its
  // 'initiated' state and let checkout.session.async_payment_succeeded (or
  // _failed) settle it — marking it completed here would show a paid purchase
  // for funds that may never clear, and would fire the "purchase completed"
  // notification twice.
  if (!isPaidSession(session)) return;

  // Idempotent upsert keyed on the session id — safe on webhook replays and
  // covers sessions whose initiated-insert never landed.
  await finalizePurchaseFromSession(session, "completed");

  // Mirror any ABN / business tax ID the buyer entered on Stripe's page, so it
  // is visible in Mission Control and the next checkout knows they have one.
  // Best-effort: never fail a fulfilled purchase over a bookkeeping copy.
  const tenantIdForTax = (session.metadata ?? {}).tenant_id;
  if (tenantIdForTax) {
    try {
      await recordTenantTaxIdFromSession(tenantIdForTax, session.customer_details);
    } catch (err) {
      console.error("recordTenantTaxIdFromSession failed", err);
    }
  }

  await notifyPurchaseCompleted(session);
}

async function fulfillCheckout(session: Stripe.Checkout.Session) {
  const md = session.metadata ?? {};
  const mode = md.mode as "topup" | "seat_plan" | "setup_package" | undefined;
  const itemId = md.item_id;
  const tenantId = md.tenant_id || null;
  const cloneId = md.clone_id || null;
  if (!mode || !itemId) throw new PermanentError("missing_metadata");

  if (mode === "topup") {
    if (!tenantId) throw new PermanentError("missing_tenant");
    // Only credit money we actually have. `checkout.session.completed` fires
    // for delayed payment methods with payment_status 'unpaid'; those become
    // spendable credits on checkout.session.async_payment_succeeded instead,
    // which routes back through here once the funds clear.
    if (!isPaidSession(session)) {
      console.log("[webhook] topup deferred until payment clears", {
        session: session.id,
        payment_status: session.payment_status,
      });
      return;
    }
    const attr = attributionFromMetadata(md as Record<string, string>);
    // adminAny: generated DB types don't yet include apply_topup's _metadata param.
    const { data, error } = await adminAny.rpc("apply_topup", {
      _tenant_id: tenantId,
      _pack_id: itemId,
      _source_ref: `stripe:${session.id}`,
      _metadata: {
        origin_user_id: attr.originUserId,
        origin_username: attr.originUsername,
        origin_source: attr.originSource,
        handoff_id: attr.handoffId,
      },
    });
    if (error) throw new Error(error.message); // transient (DB / RPC failure)
    if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
      // Logical failure from the RPC (e.g. pack_not_found) — retrying won't help.
      throw new PermanentError((data as { error?: string }).error ?? "apply_topup_failed");
    }

    // The credits exist now; tell the clone so its dashboard reflects them
    // immediately. Without this the balance only moves on the clone's next
    // poll, so a buyer returning straight from Stripe sees the old number and
    // reasonably concludes the top-up didn't work. Fire-and-forget: the ledger
    // is already correct, and the clone re-reads on its own schedule anyway.
    balanceSnapshot(tenantId)
      .then((snap) =>
        fireTokenWebhook("tokens.balance.updated", { ...snap, source: "topup" }, cloneId),
      )
      .catch((err) => console.error("topup balance webhook failed", err));
    return;
  }

  if (mode === "setup_package") {
    if (!tenantId) throw new PermanentError("missing_tenant");
    await adminAny.from("setup_purchases").upsert(
      {
        tenant_id: tenantId,
        setup_package_id: itemId,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
        amount_cents: session.amount_total ?? 0,
        currency: (session.currency ?? "aud").toUpperCase(),
        status: session.payment_status === "paid" ? "paid" : "pending",
        fulfilled_at: session.payment_status === "paid" ? new Date().toISOString() : null,
        metadata: md,
      },
      { onConflict: "stripe_checkout_session_id" },
    );
    return;
  }

  if (mode === "seat_plan") {
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null);
    const customerId =
      typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);

    // cloneId null = Prime (global) entitlement.
    const existingQ = cloneId
      ? adminAny.from("clone_seat_entitlements").select("id").eq("clone_id", cloneId).maybeSingle()
      : adminAny.from("clone_seat_entitlements").select("id").is("clone_id", null).maybeSingle();
    const { data: existing } = await existingQ;
    const patch: Record<string, unknown> = {
      seat_plan_id: itemId,
      status: "active",
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: customerId,
      canceled_at: null,
      past_due_at: null,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const updQ = cloneId
        ? adminAny.from("clone_seat_entitlements").update(patch).eq("clone_id", cloneId)
        : adminAny.from("clone_seat_entitlements").update(patch).is("clone_id", null);
      await updQ;
    } else {
      await adminAny
        .from("clone_seat_entitlements")
        .insert({ clone_id: cloneId, seats_used: 0, ...patch });
    }
    return;
  }

  throw new PermanentError(`unsupported_mode:${mode}`);
}

async function handleSubscriptionUpdated(sub: Stripe.Subscription) {
  const md = sub.metadata ?? {};
  const seatPlanId = md.item_id || null;
  const cloneId = md.clone_id || null;
  // current_period_end is on the subscription's primary item in newer API versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subAny = sub as any;
  const periodEndTs =
    subAny.current_period_end ?? subAny.items?.data?.[0]?.current_period_end ?? null;
  const periodEnd = periodEndTs ? new Date(periodEndTs * 1000).toISOString() : null;

  const status =
    sub.status === "active" || sub.status === "trialing"
      ? "active"
      : sub.status === "past_due" || sub.status === "unpaid"
        ? "past_due"
        : sub.status === "canceled" || sub.status === "incomplete_expired"
          ? "canceled"
          : sub.status;

  const patch: Record<string, unknown> = {
    status,
    current_period_end: periodEnd,
    past_due_at: status === "past_due" ? new Date().toISOString() : null,
    canceled_at: status === "canceled" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  if (seatPlanId) patch.seat_plan_id = seatPlanId;

  // Prefer subscription id mapping; fall back to clone_id from metadata.
  const bySub = await adminAny
    .from("clone_seat_entitlements")
    .update(patch)
    .eq("stripe_subscription_id", sub.id)
    .select("id");
  if ((bySub.data?.length ?? 0) === 0 && cloneId) {
    await adminAny
      .from("clone_seat_entitlements")
      .update({ ...patch, stripe_subscription_id: sub.id })
      .eq("clone_id", cloneId);
  }
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  await adminAny
    .from("clone_seat_entitlements")
    .update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", sub.id);
}

/**
 * The invoice ledger is a read-only mirror for the billing & usage page. It is
 * bookkeeping, and it must never be the reason an entitlement update does not
 * happen: when `public.invoices` was missing in production, an unguarded mirror
 * here failed every `invoice.paid` event, which meant a renewal that Stripe had
 * collected never cleared `past_due` on the subscription.
 */
async function mirrorInvoice(invoice: Stripe.Invoice) {
  try {
    await upsertInvoiceRecord(invoice);
  } catch (err) {
    console.error("[webhook] invoice mirror failed (continuing)", err);
  }
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  // Mirror every invoice into the invoices ledger (billing & usage page).
  await mirrorInvoice(invoice);

  // Renewal succeeded — clear past_due if it was set.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subId = (invoice as any).subscription as string | null | undefined;
  if (!subId) return;
  await adminAny
    .from("clone_seat_entitlements")
    .update({
      status: "active",
      past_due_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subId);
}

async function handleInvoiceFailed(invoice: Stripe.Invoice) {
  await mirrorInvoice(invoice);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subId = (invoice as any).subscription as string | null | undefined;
  if (!subId) return;
  await adminAny
    .from("clone_seat_entitlements")
    .update({
      status: "past_due",
      past_due_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subId);

  // Notify operators.
  await adminAny.from("notifications").insert({
    kind: "tokens_alert",
    severity: "error",
    title: "Subscription payment failed",
    body: `Invoice ${invoice.id} failed for subscription ${subId}.`,
    url: "/settings/billing",
    metadata: { invoice_id: invoice.id, subscription_id: subId },
  });
}

async function handleChargeRefunded(charge: Stripe.Charge) {
  // Update the matching setup_purchase if any.
  const refunded = charge.amount_refunded ?? 0;
  const updates: Record<string, unknown> = {
    refunded_at: new Date().toISOString(),
    refund_amount_cents: refunded,
    status: charge.refunded ? "refunded" : "partially_refunded",
    stripe_charge_id: charge.id,
    updated_at: new Date().toISOString(),
  };
  await adminAny
    .from("setup_purchases")
    .update(updates)
    .eq("stripe_payment_intent_id", charge.payment_intent as string);

  // Reflect the refund on the attribution ledger too.
  await markPurchaseRefunded(
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null),
    refunded,
    !!charge.refunded,
  );

  await adminAny.from("notifications").insert({
    kind: "tokens_alert",
    severity: "warning",
    title: "Stripe refund processed",
    body: `Charge ${charge.id} refunded ${(refunded / 100).toFixed(2)} ${(charge.currency ?? "aud").toUpperCase()}.`,
    url: "/settings/billing",
    metadata: { charge_id: charge.id, payment_intent_id: charge.payment_intent, refunded },
  });
}

// ---------- Route ----------

export const Route = createFileRoute("/api/public/stripe/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret) return json({ error: "webhook_secret_not_configured" }, 500);

        const sig = request.headers.get("stripe-signature");
        if (!sig) return json({ error: "missing_signature" }, 400);

        const raw = await request.text();
        let event: Stripe.Event;
        try {
          event = await getStripe().webhooks.constructEventAsync(
            raw,
            sig,
            secret,
            undefined,
            getStripeCryptoProvider(),
          );
        } catch (err) {
          return json(
            { error: "signature_verification_failed", detail: (err as Error).message },
            400,
          );
        }

        // Atomic idempotency claim. "duplicate" = already fully processed;
        // "retry" = a prior attempt claimed it but failed before finishing.
        let claim: "claimed" | "duplicate" | "retry";
        try {
          claim = await claimEvent(event);
        } catch (err) {
          // DB hiccup → 5xx so Stripe retries.
          return json({ error: "claim_failed", detail: (err as Error).message }, 500);
        }
        if (claim === "duplicate") return json({ received: true, duplicate: true });

        try {
          switch (event.type) {
            // A delayed payment method clearing after the fact. Same
            // fulfilment path — apply_topup is idempotent on the session id,
            // so a session that somehow ran both events credits once.
            case "checkout.session.async_payment_succeeded":
            case "checkout.session.completed":
              await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
              break;
            // The funds never cleared. Nothing was credited (fulfilment waits
            // for `paid`), so this only settles the purchases ledger.
            case "checkout.session.async_payment_failed":
              await finalizePurchaseFromSession(
                event.data.object as Stripe.Checkout.Session,
                "failed",
                "async_payment_failed",
              );
              break;
            case "customer.subscription.created":
            case "customer.subscription.updated":
              await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
              break;
            case "customer.subscription.deleted":
              await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
              break;
            case "invoice.paid":
            case "invoice.payment_succeeded":
              await handleInvoicePaid(event.data.object as Stripe.Invoice);
              break;
            case "invoice.finalized":
            case "invoice.voided":
            case "invoice.marked_uncollectible":
              // Keep the mirrored ledger row in step with Stripe's lifecycle.
              await mirrorInvoice(event.data.object as Stripe.Invoice);
              break;
            case "invoice.payment_failed":
            case "payment_intent.payment_failed":
              // payment_intent_failed lacks a subscription — best handled via invoice events.
              if (event.type === "invoice.payment_failed") {
                await handleInvoiceFailed(event.data.object as Stripe.Invoice);
              }
              break;
            case "payment_method.detached":
              // Card removed at Stripe out-of-band (e.g. via the Stripe
              // dashboard) — retire the wallet row so the UI can't offer it.
              await markDetachedByStripeId((event.data.object as Stripe.PaymentMethod).id);
              break;
            case "charge.refunded":
              await handleChargeRefunded(event.data.object as Stripe.Charge);
              break;
            default:
              // Acknowledge but mark un-handled. Stripe won't retry; we have a
              // complete row in stripe_events for inspection.
              await markProcessed(event.id, `unhandled_event_type:${event.type}`);
              await audit("stripe.event.unhandled", { type: event.type, id: event.id });
              return json({ received: true, unhandled: event.type });
          }

          await markProcessed(event.id);
          await audit(`stripe.${event.type}`, { id: event.id });
          return json({ received: true });
        } catch (err) {
          const msg = (err as Error).message ?? "handler_error";
          if (err instanceof PermanentError) {
            // Unprocessable event: ack with 200 so Stripe stops retrying, and
            // record the reason on the event row.
            await markProcessed(event.id, msg);
            await audit("stripe.event.permanent_error", {
              type: event.type,
              id: event.id,
              error: msg,
            });
            return json({ received: true, error: msg });
          }
          // Transient failure (DB/RPC/network): do NOT mark processed, so the
          // next Stripe retry re-claims it as "retry" and reprocesses. Handlers
          // are idempotent (apply_topup dedupes on source_ref; the rest upsert).
          await audit("stripe.event.transient_error", {
            type: event.type,
            id: event.id,
            error: msg,
          });
          return json({ error: msg }, 500);
        }
      },
    },
  },
});
