// Invoice ledger (billing & usage workflow).
//
// Mirrors Stripe invoices into `public.invoices` so command centers and
// operators can list/download them without touching Stripe. Two sources:
//   • subscription cycle invoices (seat plans) — Stripe emits these natively;
//   • one-time purchases (topups / setup packages) — checkout sessions now
//     enable invoice_creation, so Stripe issues a real invoice (hosted page +
//     PDF) for those too, carrying our metadata contract via invoice_data.
//
// upsertInvoiceRecord is idempotent on stripe_invoice_id and tolerant of
// events arriving out of order (finalized vs paid vs payment_failed).
import { asRow } from "@/lib/json-cast";
import type { TablesInsert } from "@/integrations/supabase/types";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { attributionFromMetadata } from "@/server/purchases.server";

const adminAny = supabaseAdmin;

function ts(unix: number | null | undefined): string | null {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : (v.id ?? null);
}

/**
 * Best metadata available for an invoice: invoice.metadata (set via
 * invoice_creation.invoice_data on one-time checkouts) wins, then the
 * subscription's metadata (seat plans propagate the contract there).
 */
function invoiceMetadata(invoice: Stripe.Invoice): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = invoice as any;
  const own = (invoice.metadata ?? {}) as Record<string, string>;
  if (own.tenant_id || own.origin_user_id) return own;
  const subMeta = (inv.subscription_details?.metadata ?? {}) as Record<string, string>;
  return Object.keys(subMeta).length ? subMeta : own;
}

/** Resolve tenant/clone context, falling back to the Stripe customer id when
 * the metadata contract is absent (e.g. invoices minted outside checkout). */
async function resolveScope(
  md: Record<string, string>,
  customerId: string | null,
): Promise<{ tenantId: string | null; cloneId: string | null }> {
  if (md.tenant_id) return { tenantId: md.tenant_id, cloneId: md.clone_id || null };
  if (!customerId) return { tenantId: null, cloneId: null };
  const { data: tenant } = await adminAny
    .from("tenants")
    .select("id, clone_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return { tenantId: tenant?.id ?? null, cloneId: tenant?.clone_id ?? null };
}

/** Best-effort link to the purchases ledger via payment intent, then
 * subscription (latest purchase on that subscription). */
async function resolvePurchaseId(
  paymentIntentId: string | null,
  subscriptionId: string | null,
): Promise<string | null> {
  if (paymentIntentId) {
    const { data } = await adminAny
      .from("purchases")
      .select("id")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  if (subscriptionId) {
    const { data } = await adminAny
      .from("purchases")
      .select("id")
      .eq("stripe_subscription_id", subscriptionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  return null;
}

export async function upsertInvoiceRecord(invoice: Stripe.Invoice): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = invoice as any;
  const md = invoiceMetadata(invoice);
  const attr = attributionFromMetadata(md);
  const customerId = stripeId(invoice.customer as string | { id: string } | null);
  const subscriptionId = stripeId(inv.subscription);
  const paymentIntentId = stripeId(inv.payment_intent);
  const { tenantId, cloneId } = await resolveScope(md, customerId);
  const purchaseId = await resolvePurchaseId(paymentIntentId, subscriptionId);

  const firstLine = invoice.lines?.data?.[0];
  const description =
    invoice.description ?? firstLine?.description ?? md.item_name ?? md.item_slug ?? null;
  const mode = md.mode || (subscriptionId ? "subscription_cycle" : "unknown");

  const row: Record<string, unknown> = {
    stripe_invoice_id: invoice.id,
    tenant_id: tenantId,
    clone_id: cloneId,
    purchase_id: purchaseId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_payment_intent_id: paymentIntentId,
    number: invoice.number ?? null,
    status: invoice.status ?? null,
    description,
    mode,
    item_slug: md.item_slug || null,
    item_name: md.item_name || null,
    amount_due_cents: invoice.amount_due ?? null,
    amount_paid_cents: invoice.amount_paid ?? null,
    amount_remaining_cents: invoice.amount_remaining ?? null,
    subtotal_cents: invoice.subtotal ?? null,
    tax_cents: inv.tax ?? inv.total_taxes?.[0]?.amount ?? null,
    total_cents: invoice.total ?? null,
    currency: invoice.currency ? invoice.currency.toUpperCase() : null,
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    invoice_pdf_url: invoice.invoice_pdf ?? null,
    origin_user_id: attr.originUserId,
    origin_username: attr.originUsername,
    origin_source: md.origin_source ? attr.originSource : null,
    period_start: ts(invoice.period_start),
    period_end: ts(invoice.period_end),
    issued_at: ts(invoice.status_transitions?.finalized_at) ?? ts(invoice.created),
    paid_at: ts(invoice.status_transitions?.paid_at),
    updated_at: new Date().toISOString(),
  };

  const { error } = await adminAny
    .from("invoices")
    .upsert(asRow<TablesInsert<"invoices">>(row), { onConflict: "stripe_invoice_id" });
  if (error) throw new Error(`invoice_upsert_failed: ${error.message}`);
}
