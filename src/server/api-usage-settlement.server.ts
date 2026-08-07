/**
 * Settling a period's piggybacked API usage into a real charge.
 *
 * Two steps, deliberately separate:
 *
 *   1. CLOSE — freeze the period's rollups into an immutable `api_usage_charges`
 *      row plus its per-secret lines. The free allowance is applied here and
 *      micros become cents here, once. Closing is idempotent: re-closing a
 *      closed period returns it untouched rather than charging twice.
 *
 *   2. INVOICE — push the closed amount to Stripe as an *invoice item* on the
 *      tenant's customer, then make sure that item actually reaches a bill.
 *
 * Splitting them means a Stripe outage cannot corrupt the billing record, and a
 * disputed charge can be waived after close without unwinding the meter.
 *
 * ON STEP 2, AND WHY IT IS NOT JUST AN INVOICE ITEM
 * ------------------------------------------------
 * An invoice item is not a bill. It is a pending line waiting for an invoice to
 * attach itself to, and Stripe only attaches pending items on its own when a
 * subscription cycle renews. So the same charge needs two different treatments:
 *
 *   • Tenant WITH a live subscription — leave the item pending. It rides the
 *     next cycle invoice as an extra line, which is exactly what "an additional
 *     charge for API key usage" should look like on a statement. Raising our
 *     own invoice as well would bill the same usage twice.
 *   • Tenant WITHOUT one — raise a standalone invoice and finalise it, because
 *     no cycle will ever sweep the item up.
 *
 * The second case is the normal one today, not an edge case: the Aurixa Stripe
 * account has no subscriptions at all, so before this every settled charge
 * would have been metered, rated, converted to cents — and then never
 * collected, with nothing anywhere reporting an error.
 *
 * Finalising is what turns a draft into a bill: it assigns the invoice number,
 * mints the hosted page and the PDF, and lets Stripe collect and email the
 * receipt. Receipts are never created here, or anywhere — Stripe emits them
 * itself when a payment succeeds. There is no API that makes one.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/server/stripe.server";
import { formatMicros, planCollection } from "@/lib/api-usage-rating";

// The metering tables are newer than the generated DB types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

/** Below this, a Stripe invoice item costs more in reconciliation than it
 *  collects. Sub-threshold periods close and stay closed at zero owed. */
export const MIN_INVOICEABLE_CENTS = 50;

export type ChargeRow = {
  id: string;
  tenant_id: string;
  clone_id: string | null;
  period_start: string;
  period_end: string;
  currency: string;
  amount_cents: number;
  amount_micros: number;
  cost_micros: number;
  status: "open" | "closed" | "invoiced" | "waived" | "failed";
  stripe_invoice_item_id: string | null;
  last_error: string | null;
  closed_at: string | null;
  invoiced_at: string | null;
};

export type CloseResult =
  | { ok: true; chargeId: string; alreadyClosed: boolean; amountCents: number; lines: number }
  | { ok: false; error: string };

/**
 * Close one tenant-period. Thin wrapper over `close_api_usage_period` — the
 * arithmetic lives in SQL so it runs in the same transaction as the read of the
 * rollups it is summing.
 */
export async function closeUsagePeriod(
  tenantId: string,
  periodStart: string,
): Promise<CloseResult> {
  const { data, error } = await adminAny.rpc("close_api_usage_period", {
    _tenant_id: tenantId,
    _period_start: periodStart,
  });
  if (error) return { ok: false, error: error.message };
  const r = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    charge_id?: string;
    already_closed?: boolean;
    amount_cents?: number;
    lines?: number;
  };
  if (!r.ok) return { ok: false, error: r.error ?? "close_failed" };
  return {
    ok: true,
    chargeId: r.charge_id as string,
    alreadyClosed: Boolean(r.already_closed),
    amountCents: r.amount_cents ?? 0,
    lines: r.lines ?? 0,
  };
}

/**
 * Which periods are ready to close.
 *
 * A period is closeable once it has ended — never before. Closing an open cycle
 * would bill a tenant for half a month and leave the rest unattributable, since
 * closing freezes the rollups it summed.
 */
export async function findClosablePeriods(
  now = new Date(),
  limit = 200,
): Promise<Array<{ tenant_id: string; period_start: string }>> {
  const today = now.toISOString().slice(0, 10);
  const { data, error } = await adminAny
    .from("api_usage_rollups")
    .select("tenant_id, period_start")
    .lt("period_start", today)
    .order("period_start", { ascending: true })
    .limit(limit * 20);
  if (error || !data) return [];

  // One entry per (tenant, period); the rollup table has one row per secret.
  const seen = new Set<string>();
  const out: Array<{ tenant_id: string; period_start: string }> = [];
  for (const row of data as Array<{ tenant_id: string; period_start: string }>) {
    // A period is only over once the *next* one has started. `period_start` is
    // the tenant's cycle anchor, so compare against a month on from it.
    const end = new Date(`${row.period_start}T00:00:00.000Z`);
    end.setUTCMonth(end.getUTCMonth() + 1);
    if (end.getTime() > now.getTime()) continue;

    const k = `${row.tenant_id}:${row.period_start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export type InvoiceResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped: false;
      invoiceItemId: string;
      /** The invoice raised to collect it, or null when it rides a subscription cycle. */
      invoiceId: string | null;
      amountCents: number;
    }
  | { ok: false; error: string };

/**
 * Push a closed charge onto the tenant's next Stripe invoice.
 *
 * Idempotent three times over: an already-invoiced charge returns early, the
 * Stripe call carries an idempotency key derived from the charge id, and the
 * resulting item id is written back before anything else can run.
 */
export async function invoiceClosedCharge(chargeId: string): Promise<InvoiceResult> {
  const { data: charge, error } = await adminAny
    .from("api_usage_charges")
    .select("*")
    .eq("id", chargeId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!charge) return { ok: false, error: "charge_not_found" };

  const row = charge as ChargeRow;
  if (row.status === "invoiced") {
    return { ok: true, skipped: true, reason: "already_invoiced" };
  }
  if (row.status === "waived") {
    return { ok: true, skipped: true, reason: "waived" };
  }
  if (row.status !== "closed") {
    return { ok: true, skipped: true, reason: `not_closed:${row.status}` };
  }
  if (row.amount_cents < MIN_INVOICEABLE_CENTS) {
    // Nothing worth collecting. Mark it invoiced so the cron stops revisiting
    // it, and record why the amount never reached a statement.
    await adminAny
      .from("api_usage_charges")
      .update({
        status: "invoiced",
        invoiced_at: new Date().toISOString(),
        metadata: { ...(charge.metadata ?? {}), below_threshold: true },
      })
      .eq("id", chargeId);
    return { ok: true, skipped: true, reason: "below_threshold" };
  }

  const { data: tenant } = await adminAny
    .from("tenants")
    .select("id, display_name, external_ref, stripe_customer_id, billing_stripe_customer_id")
    .eq("id", row.tenant_id)
    .maybeSingle();

  const customerId: string | null =
    tenant?.stripe_customer_id ?? tenant?.billing_stripe_customer_id ?? null;
  if (!customerId) {
    // No customer to bill. This is an operator problem, not a data problem —
    // leave the charge closed and say so, so it appears in the failures list
    // instead of vanishing.
    await adminAny
      .from("api_usage_charges")
      .update({ last_error: "no_stripe_customer" })
      .eq("id", chargeId);
    return { ok: false, error: "no_stripe_customer" };
  }

  const { data: lines } = await adminAny
    .from("api_usage_charge_lines")
    .select("display_name, charged_quantity, unit, amount_micros")
    .eq("charge_id", chargeId)
    .gt("charged_quantity", 0)
    .order("amount_micros", { ascending: false });

  const topProviders = ((lines ?? []) as Array<{ display_name: string }>)
    .slice(0, 3)
    .map((l) => l.display_name)
    .join(", ");
  const description =
    `API usage — ${row.period_start} to ${row.period_end}` +
    (topProviders ? ` (${topProviders}${(lines?.length ?? 0) > 3 ? ", …" : ""})` : "");

  try {
    const stripe = getStripe();
    const item = await stripe.invoiceItems.create(
      {
        customer: customerId,
        amount: row.amount_cents,
        currency: row.currency.toLowerCase(),
        description,
        metadata: {
          kind: "api_usage",
          charge_id: chargeId,
          tenant_id: row.tenant_id,
          clone_id: row.clone_id ?? "",
          period_start: row.period_start,
          period_end: row.period_end,
          amount_micros: String(row.amount_micros),
        },
      },
      // Same charge, same key — a retried cron run cannot double-bill even if
      // the write-back below never landed the first time.
      { idempotencyKey: `api-usage-charge-${chargeId}` },
    );

    // An invoice item is NOT a bill. It is a pending line waiting for an
    // invoice, and Stripe only attaches pending items on its own when a
    // subscription cycle renews. A tenant with no subscription would otherwise
    // have this metered, rated, settled — and then never collected, silently.
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    const activeCount = subs.data.filter((s) =>
      ["active", "trialing", "past_due", "unpaid"].includes(s.status),
    ).length;

    const plan = planCollection({
      amountCents: row.amount_cents,
      minInvoiceableCents: MIN_INVOICEABLE_CENTS,
      hasCustomer: true,
      subscription: { activeCount },
    });

    let invoiceId: string | null = null;
    let finalizedAt: string | null = null;

    if (plan.action === "raise_invoice") {
      // `pending_invoice_items_behavior: "include"` is what sweeps the item we
      // just created onto this invoice. Without it Stripe raises an empty
      // invoice and leaves the item pending — the exact failure this is here
      // to prevent.
      const invoice = await stripe.invoices.create(
        {
          customer: customerId,
          collection_method: "charge_automatically",
          // Finalising is a separate, explicit step below, so the invoice
          // cannot be emailed before its lines are confirmed.
          auto_advance: false,
          pending_invoice_items_behavior: "include",
          description,
          metadata: {
            kind: "api_usage",
            charge_id: chargeId,
            tenant_id: row.tenant_id,
            period_start: row.period_start,
            period_end: row.period_end,
          },
        },
        { idempotencyKey: `api-usage-invoice-${chargeId}` },
      );

      // Finalising is what turns a draft into a bill: it assigns the invoice
      // number, mints the hosted page and the PDF, and lets Stripe collect and
      // email a receipt on payment. A draft does none of that.
      const finalized = await stripe.invoices.finalizeInvoice(
        invoice.id as string,
        { auto_advance: true },
        { idempotencyKey: `api-usage-invoice-finalize-${chargeId}` },
      );
      invoiceId = finalized.id as string;
      finalizedAt = new Date().toISOString();
    }

    await adminAny
      .from("api_usage_charges")
      .update({
        status: "invoiced",
        stripe_invoice_item_id: item.id,
        stripe_invoice_id: invoiceId,
        invoice_mode: plan.action === "raise_invoice" ? "standalone" : "subscription_cycle",
        invoice_finalized_at: finalizedAt,
        stripe_customer_id: customerId,
        invoiced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", chargeId);

    await adminAny.from("audit_log").insert({
      action: "api_usage.charge_invoiced",
      entity_type: "tenant",
      entity_id: row.tenant_id,
      metadata: {
        charge_id: chargeId,
        stripe_invoice_item_id: item.id,
        stripe_invoice_id: invoiceId,
        collection: plan.action,
        collection_reason: plan.reason,
        active_subscriptions: activeCount,
        amount_cents: row.amount_cents,
        currency: row.currency,
        period_start: row.period_start,
      },
    });

    return {
      ok: true,
      skipped: false,
      invoiceItemId: item.id,
      invoiceId,
      amountCents: row.amount_cents,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "stripe_error";
    await adminAny
      .from("api_usage_charges")
      .update({ status: "failed", last_error: message.slice(0, 500) })
      .eq("id", chargeId);
    return { ok: false, error: message };
  }
}

export type SweepResult = {
  closed: number;
  alreadyClosed: number;
  invoiced: number;
  /** Of `invoiced`, how many needed a standalone invoice raised for them.
   *  The rest are pending against a subscription cycle. */
  invoicesRaised: number;
  skipped: number;
  failed: number;
  totalCents: number;
  errors: Array<{ tenant_id: string; period_start: string; error: string }>;
};

/**
 * Close every ended period, then invoice what closed. Driven by the cron hook.
 *
 * Failures are collected rather than thrown: one tenant without a Stripe
 * customer must not stop the other forty from being billed.
 */
export async function sweepApiUsageSettlement(now = new Date()): Promise<SweepResult> {
  const out: SweepResult = {
    closed: 0,
    alreadyClosed: 0,
    invoiced: 0,
    invoicesRaised: 0,
    skipped: 0,
    failed: 0,
    totalCents: 0,
    errors: [],
  };

  for (const period of await findClosablePeriods(now)) {
    const closed = await closeUsagePeriod(period.tenant_id, period.period_start);
    if (!closed.ok) {
      out.failed += 1;
      out.errors.push({ ...period, error: closed.error });
      continue;
    }
    if (closed.alreadyClosed) out.alreadyClosed += 1;
    else out.closed += 1;

    const invoiced = await invoiceClosedCharge(closed.chargeId);
    if (!invoiced.ok) {
      out.failed += 1;
      out.errors.push({ ...period, error: invoiced.error });
      continue;
    }
    if (invoiced.skipped) {
      out.skipped += 1;
    } else {
      out.invoiced += 1;
      if (invoiced.invoiceId) out.invoicesRaised += 1;
      out.totalCents += invoiced.amountCents;
    }
  }

  return out;
}

/**
 * Waive a closed charge. The meter is never edited — the events and rollups
 * stay exactly as reported, and the waiver is recorded against the charge with
 * who did it and why, so a written-off month still reconciles against usage.
 */
export async function waiveCharge(
  chargeId: string,
  userId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: charge } = await adminAny
    .from("api_usage_charges")
    .select("id, status, tenant_id, amount_cents")
    .eq("id", chargeId)
    .maybeSingle();
  if (!charge) return { ok: false, error: "charge_not_found" };
  if (charge.status === "invoiced") {
    // Once it is on a Stripe invoice, the credit belongs in Stripe — waiving it
    // here would leave our record and the customer's statement disagreeing.
    return { ok: false, error: "already_invoiced_refund_in_stripe" };
  }

  const { error } = await adminAny
    .from("api_usage_charges")
    .update({
      status: "waived",
      waived_by: userId,
      waived_reason: reason.slice(0, 500),
    })
    .eq("id", chargeId);
  if (error) return { ok: false, error: error.message };

  await adminAny.from("audit_log").insert({
    action: "api_usage.charge_waived",
    entity_type: "tenant",
    entity_id: charge.tenant_id,
    actor_user_id: userId,
    metadata: { charge_id: chargeId, amount_cents: charge.amount_cents, reason },
  });
  return { ok: true };
}

/** Human-readable amount for notifications and the operator UI. */
export function describeCharge(row: Pick<ChargeRow, "amount_micros" | "currency">): string {
  return formatMicros(row.amount_micros, row.currency);
}
