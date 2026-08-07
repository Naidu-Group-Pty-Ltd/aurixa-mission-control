import { describe, expect, it } from "vitest";
import { buildInvoiceDocument, type InvoiceSource } from "./invoiceDocument.pure";
import { AURIXA_INVOICE_FOOTER } from "./aurixa-brand";

/** A paid subscription invoice, shaped as Stripe returns one. */
const PAID: InvoiceSource = {
  id: "in_1Tc9xyz",
  number: "9F3C21A0-0007",
  status: "paid",
  currency: "aud",
  created: 1_786_060_800, // 2026-08-07T00:00:00Z
  status_transitions: { finalized_at: 1_786_060_800, paid_at: 1_786_061_400 },
  customer_name: "Harbourline Advisory Pty Ltd",
  customer_email: "accounts@harbourline.example",
  customer_address: {
    line1: "Level 6, 122 Walker Street",
    line2: null,
    city: "North Sydney",
    state: "NSW",
    postal_code: "2060",
    country: "Australia",
  },
  subtotal: 105_500,
  total: 105_500,
  total_excluding_tax: 95_909,
  amount_due: 0,
  amount_paid: 105_500,
  total_taxes: [{ amount: 9_591 }],
  lines: {
    data: [
      {
        description: "Aurixa Growth — 5–15 seats",
        quantity: 1,
        amount: 86_000,
        period: { start: 1_786_060_800, end: 1_788_652_800 },
      },
      { description: "AML / CTF Compliance module", quantity: 1, amount: 19_500, period: null },
    ],
  },
};

describe("buildInvoiceDocument", () => {
  it("copies the figures Stripe issued", () => {
    const doc = buildInvoiceDocument(PAID);
    expect(doc.totals).toEqual([
      { label: "Subtotal", value: "$1,055.00" },
      { label: "Total excluding GST", value: "$959.09" },
      { label: "GST (10%, included)", value: "$95.91" },
      { label: "Total", value: "$1,055.00", emphasis: "total" },
      { label: "Amount paid", value: "$1,055.00", emphasis: "paid" },
    ]);
    expect(doc.headline).toEqual({ label: "Amount paid", value: "$1,055.00" });
  });

  // The rule that makes a second PDF for one transaction safe at all.
  it("omits the ex-GST line rather than deriving it", () => {
    const { total_excluding_tax: _drop, ...without } = PAID;
    const labels = buildInvoiceDocument(without).totals.map((t) => t.label);
    expect(labels).not.toContain("Total excluding GST");
    // …and it does not quietly reappear as total − tax.
    expect(labels).toEqual(["Subtotal", "GST (10%, included)", "Total", "Amount paid"]);
  });

  it("omits GST when Stripe reported none, and never sums a partial tax list", () => {
    expect(
      buildInvoiceDocument({ ...PAID, total_taxes: null }).totals.map((t) => t.label),
    ).not.toContain("GST (10%, included)");
    expect(
      buildInvoiceDocument({
        ...PAID,
        total_taxes: [{ amount: 500 }, { amount: null }],
      }).totals.map((t) => t.label),
    ).not.toContain("GST (10%, included)");
  });

  it("sums a multi-part tax list, and prefers the invoice's own tax field", () => {
    expect(
      buildInvoiceDocument({ ...PAID, total_taxes: [{ amount: 9_000 }, { amount: 591 }] }).totals,
    ).toContainEqual({ label: "GST (10%, included)", value: "$95.91" });
    expect(buildInvoiceDocument({ ...PAID, tax: 1_234 }).totals).toContainEqual({
      label: "GST (10%, included)",
      value: "$12.34",
    });
  });

  it("refuses to render an invoice with no total", () => {
    expect(() => buildInvoiceDocument({ ...PAID, total: null })).toThrow("invoice_has_no_total");
  });

  it("leads with amount DUE while the invoice is open", () => {
    const open = buildInvoiceDocument({
      ...PAID,
      status: "open",
      amount_due: 105_500,
      amount_paid: 0,
      due_date: 1_786_060_800,
      status_transitions: { finalized_at: 1_786_060_800, paid_at: null },
    });
    expect(open.statusLabel).toBe("Due");
    expect(open.headline).toEqual({ label: "Amount due", value: "$1,055.00" });
    expect(open.statusDetail).toBeNull();
    expect(open.totals.map((t) => t.label)).not.toContain("Amount paid");
    expect(open.dueOn).toBe("7 August 2026");
  });

  it("dates in Australian eastern time regardless of the host clock", () => {
    // 2026-08-06T14:30:00Z is 00:30 on the 7th in Sydney. Formatted in UTC —
    // which is what a Worker's default clock would give — this invoice would
    // be dated the day before it was issued.
    const doc = buildInvoiceDocument({
      ...PAID,
      status_transitions: { finalized_at: 1_786_026_600, paid_at: 1_786_026_600 },
    });
    expect(doc.issuedOn).toBe("7 August 2026");
    expect(doc.statusDetail).toBe("Paid 7 August 2026");
  });

  it("renders a line period as a range, and drops it when absent", () => {
    const doc = buildInvoiceDocument(PAID);
    expect(doc.lines[0].period).toBe("7 Aug – 6 Sept 2026");
    expect(doc.lines[1].period).toBeNull();
  });

  it("leaves quantity blank rather than inventing one", () => {
    const doc = buildInvoiceDocument({
      ...PAID,
      lines: { data: [{ description: "Proration credit", amount: -2_500 }] },
    });
    expect(doc.lines[0].quantity).toBe("");
    expect(doc.lines[0].amount).toBe("-$25.00");
  });

  it("writes the billing address the way an envelope is written", () => {
    expect(buildInvoiceDocument(PAID).billTo).toEqual({
      name: "Harbourline Advisory Pty Ltd",
      lines: ["Level 6, 122 Walker Street", "North Sydney NSW 2060", "Australia"],
    });
  });

  it("falls back to the billing email, then to a dash, for an unnamed customer", () => {
    expect(buildInvoiceDocument({ ...PAID, customer_name: null }).billTo.name).toBe(
      "accounts@harbourline.example",
    );
    expect(
      buildInvoiceDocument({ ...PAID, customer_name: null, customer_email: null }).billTo.name,
    ).toBe("—");
  });

  it("prints the invoice's own footer when it has one, else the brand default", () => {
    expect(buildInvoiceDocument(PAID).footer).toEqual(AURIXA_INVOICE_FOOTER.split("\n"));
    expect(buildInvoiceDocument({ ...PAID, footer: "One line only" }).footer).toEqual([
      "One line only",
    ]);
  });

  it("names the Stripe invoice it restates", () => {
    expect(buildInvoiceDocument(PAID).provenance).toContain("in_1Tc9xyz");
    expect(buildInvoiceDocument(PAID).provenance).toContain("nothing on this page is recalculated");
  });

  it("falls back to the object id when Stripe has not numbered the invoice yet", () => {
    expect(buildInvoiceDocument({ ...PAID, number: null }).number).toBe("in_1Tc9xyz");
  });

  it("respects a non-AUD invoice rather than assuming dollars", () => {
    const doc = buildInvoiceDocument({ ...PAID, currency: "nzd" });
    expect(doc.headline.value).toBe("$1,055.00");
    expect(() => buildInvoiceDocument({ ...PAID, currency: "eur" })).not.toThrow();
    expect(buildInvoiceDocument({ ...PAID, currency: "eur" }).headline.value).toContain("€");
  });
});
