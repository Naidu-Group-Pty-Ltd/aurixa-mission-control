/**
 * A Stripe invoice, turned into the document Aurixa prints.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Stripe's own invoice PDF cannot be made dark. The account's branding gives
 * four fields — icon, logo, brand colour, accent colour — and the accent colour
 * (the one that paints backgrounds) is documented as not applying to invoice
 * PDFs at all. Invoice *rendering templates*, the other lever, only carry the
 * memo, the footer, custom fields and line-item grouping; they have no colour
 * or layout control. So a dark invoice has to be a document we render.
 *
 * ── The rule that makes a second document safe ──────────────────────────────
 * Two PDFs for one transaction is a real hazard: the moment they can disagree
 * about a number, one of them is wrong and nobody knows which. So this module
 * **never computes a figure**. Every amount is copied from the Stripe invoice,
 * and a total Stripe did not send is OMITTED rather than derived — including
 * the ex-GST line, which is `total_excluding_tax` when Stripe provides it and
 * simply absent when it does not. `total - tax` would be right almost always,
 * and "almost always" is the wrong standard for a tax invoice.
 *
 * The renderer stamps the Stripe invoice id on the page for the same reason.
 *
 * This module is pure: no Stripe SDK import, no I/O, no clock. The input is
 * declared structurally so it accepts a `Stripe.Invoice` without binding this
 * file to an SDK version.
 */

import { AURIXA_INVOICE_FOOTER } from "./aurixa-brand";

/**
 * A tax invoice carries the date it was issued, and for an Australian business
 * that is the local date — not whatever the renderer's host happens to be set
 * to. Passing the zone to Intl explicitly is also what makes the output
 * deterministic under test.
 *
 * Note this is NOT the Stripe account's dashboard timezone (Asia/Kuala_Lumpur).
 * That setting governs Stripe's reporting; it has no bearing on the date that
 * belongs on an invoice issued from Kellyville, NSW.
 */
export const INVOICE_TIME_ZONE = "Australia/Sydney";

export type InvoiceAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
} | null;

/** The shape this reads off a Stripe invoice. A `Stripe.Invoice` satisfies it. */
export type InvoiceSource = {
  id?: string | null;
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  created?: number | null;
  due_date?: number | null;
  status_transitions?: { finalized_at?: number | null; paid_at?: number | null } | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_address?: InvoiceAddress;
  account_name?: string | null;
  subtotal?: number | null;
  total?: number | null;
  total_excluding_tax?: number | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  tax?: number | null;
  total_taxes?: Array<{ amount?: number | null }> | null;
  lines?: { data?: Array<InvoiceSourceLine> | null } | null;
  footer?: string | null;
};

export type InvoiceSourceLine = {
  description?: string | null;
  quantity?: number | null;
  amount?: number | null;
  period?: { start?: number | null; end?: number | null } | null;
};

export type DocumentLine = {
  description: string;
  /** "7 Aug – 6 Sep 2026", or null when the line carries no period. */
  period: string | null;
  quantity: string;
  amount: string;
};

export type DocumentTotal = {
  label: string;
  value: string;
  /** `total` and `paid` are set in the brand gold; the rest are muted. */
  emphasis?: "total" | "paid";
};

export type InvoiceDocument = {
  title: string;
  /** Stripe's human invoice number, or the object id when it has none yet. */
  number: string;
  statusLabel: string;
  /** Sits under the headline amount, e.g. "Paid 7 August 2026". */
  statusDetail: string | null;
  issuedOn: string;
  dueOn: string | null;
  /** The one big figure: what is owed, or what was paid. */
  headline: { label: string; value: string };
  from: { name: string; lines: string[] };
  billTo: { name: string; lines: string[] };
  lines: DocumentLine[];
  totals: DocumentTotal[];
  footer: string[];
  /** Printed small, at the foot. Names the Stripe invoice this restates. */
  provenance: string;
};

/** The issuing party. Matches the registered details on the Stripe account. */
const AURIXA_FROM = {
  name: "Aurixa System Pty Ltd",
  lines: ["42 Seymour Way", "Kellyville NSW 2155", "Australia"],
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  open: "Due",
  paid: "Paid",
  void: "Void",
  uncollectible: "Uncollectible",
};

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
  }).format(cents / 100);
}

function longDate(unix: number): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: INVOICE_TIME_ZONE,
  }).format(new Date(unix * 1000));
}

function shortDate(unix: number, withYear: boolean): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: INVOICE_TIME_ZONE,
  }).format(new Date(unix * 1000));
}

/** "7 Aug – 6 Sep 2026". The year appears once when both ends share it. */
function periodLabel(period: InvoiceSourceLine["period"]): string | null {
  const start = period?.start;
  const end = period?.end;
  if (!start || !end) return null;
  const sameYear =
    new Date(start * 1000).getUTCFullYear() === new Date(end * 1000).getUTCFullYear();
  return `${shortDate(start, !sameYear)} – ${shortDate(end, true)}`;
}

function addressLines(address: InvoiceAddress | undefined): string[] {
  if (!address) return [];
  // city/state/postcode belong on one line the way an envelope is written;
  // everything else is its own.
  const locality = [address.city, address.state, address.postal_code]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return [address.line1, address.line2, locality, address.country]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);
}

/** The tax Stripe reported, or null. Never derived from total − subtotal. */
function taxAmount(source: InvoiceSource): number | null {
  if (typeof source.tax === "number") return source.tax;
  const parts = source.total_taxes ?? [];
  if (!parts.length) return null;
  let sum = 0;
  for (const part of parts) {
    if (typeof part?.amount !== "number") return null;
    sum += part.amount;
  }
  return sum;
}

/**
 * Build the printable document.
 *
 * Throws only when the invoice has no total at all — a document whose headline
 * figure is a guess should not exist.
 */
export function buildInvoiceDocument(source: InvoiceSource): InvoiceDocument {
  const currency = (source.currency ?? "aud").toUpperCase();
  const total = source.total;
  if (typeof total !== "number") {
    throw new Error("invoice_has_no_total");
  }

  const status = (source.status ?? "open").toLowerCase();
  const isPaid = status === "paid";
  const paidAt = source.status_transitions?.paid_at ?? null;
  const issuedAt = source.status_transitions?.finalized_at ?? source.created ?? null;

  const lines: DocumentLine[] = (source.lines?.data ?? []).map((line) => ({
    description: (line.description ?? "").trim() || "—",
    period: periodLabel(line.period),
    // Stripe omits quantity on some line kinds (proration, one-off amounts).
    // A blank cell is honest; inventing "1" is not.
    quantity: typeof line.quantity === "number" ? String(line.quantity) : "",
    amount: typeof line.amount === "number" ? money(line.amount, currency) : "",
  }));

  const totals: DocumentTotal[] = [];
  if (typeof source.subtotal === "number") {
    totals.push({ label: "Subtotal", value: money(source.subtotal, currency) });
  }
  if (typeof source.total_excluding_tax === "number") {
    totals.push({
      label: "Total excluding GST",
      value: money(source.total_excluding_tax, currency),
    });
  }
  const tax = taxAmount(source);
  if (tax !== null) {
    // "included", not "added": every Aurixa price is tax-inclusive, and the
    // invoice is rendered with amount_tax_display=include_inclusive_tax.
    totals.push({ label: "GST (10%, included)", value: money(tax, currency) });
  }
  totals.push({ label: "Total", value: money(total, currency), emphasis: "total" });
  if (isPaid && typeof source.amount_paid === "number") {
    totals.push({
      label: "Amount paid",
      value: money(source.amount_paid, currency),
      emphasis: "paid",
    });
  }

  const headlineAmount = isPaid ? (source.amount_paid ?? total) : (source.amount_due ?? total);

  return {
    title: "Tax invoice",
    number: source.number?.trim() || source.id?.trim() || "—",
    statusLabel: STATUS_LABELS[status] ?? status,
    statusDetail: isPaid && paidAt ? `Paid ${longDate(paidAt)}` : null,
    issuedOn: issuedAt ? longDate(issuedAt) : "—",
    dueOn: source.due_date ? longDate(source.due_date) : null,
    headline: {
      label: isPaid ? "Amount paid" : "Amount due",
      value: money(headlineAmount, currency),
    },
    from: AURIXA_FROM,
    billTo: {
      name: source.customer_name?.trim() || source.customer_email?.trim() || "—",
      lines: addressLines(source.customer_address),
    },
    lines,
    totals,
    // The invoice's own footer wins — Mission Control sets ours on the Customer
    // and on one-off invoices, so this is normally the same string, but an
    // invoice edited in the Dashboard must print what it actually says.
    footer: (source.footer?.trim() || AURIXA_INVOICE_FOOTER).split("\n"),
    provenance: source.id
      ? `Restates Stripe invoice ${source.id}. Figures as issued by Stripe; nothing on this page is recalculated.`
      : "Figures as issued by Stripe; nothing on this page is recalculated.",
  };
}
