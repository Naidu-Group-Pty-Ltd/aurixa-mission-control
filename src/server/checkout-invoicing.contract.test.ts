import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The purchase → invoice → receipt contract, pinned against the source.
 *
 * Every one of these invariants is a line that, if quietly deleted, produces a
 * checkout that still works and still takes money — while silently issuing an
 * invalid tax invoice, or no invoice, or no receipt. None of them fails loudly,
 * and none is covered by a unit test, because they are arguments to a Stripe
 * call that only a real Stripe round-trip exercises.
 *
 * Asserting against the source text is the cheap half of the guarantee: it
 * cannot prove Stripe behaves, but it does prove nobody removed the parameter
 * that makes Stripe behave. The expensive half needs a sandbox account.
 */
const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

const checkout = read("src/server/checkout.server.ts");
const invoices = read("src/server/invoices.server.ts");
const settlement = read("src/server/api-usage-settlement.server.ts");

describe("checkout issues a real invoice", () => {
  it("enables invoice_creation on one-time purchases", () => {
    // Without this a topup or setup package produces a PaymentIntent and
    // nothing else: no invoice number, no hosted page, no PDF, nothing on the
    // Invoices ledger for the customer to download.
    expect(checkout).toMatch(/invoice_creation:\s*\{\s*enabled:\s*true/);
  });

  it("carries the metadata contract onto the invoice itself", () => {
    // `upsertInvoiceRecord` resolves tenant/clone from invoice metadata. Drop
    // this and every one-time invoice mirrors in unattributed.
    expect(checkout).toMatch(/invoice_creation:[\s\S]{0,80}invoice_data:\s*\{\s*metadata/);
  });

  it("propagates metadata onto subscriptions so cycle invoices stay attributed", () => {
    expect(checkout).toMatch(/subscription_data:\s*\{\s*metadata/);
  });
});

describe("checkout issues a receipt to the human who paid", () => {
  it("sets receipt_email from the buyer's own contact", () => {
    // The Customer's email is the organisation's billing inbox and may belong
    // to somebody else entirely; without receipt_email the person who actually
    // paid never receives their receipt.
    expect(checkout).toMatch(/receipt_email:\s*receiptEmail/);
  });
});

describe("checkout produces a VALID tax invoice", () => {
  it("enables automatic tax", () => {
    expect(checkout).toMatch(/automatic_tax:\s*\{\s*enabled:\s*true\s*\}/);
  });

  it("collects a full billing address, not just country and postcode", () => {
    // Stripe Tax needs it to be accurate and an invoice needs it to be valid.
    expect(checkout).toMatch(/billing_address_collection:\s*"required"/);
  });

  it("writes the confirmed address back onto the Customer", () => {
    // Without the write-back the Customer stays blank, automatic_tax keeps
    // failing its address check, and every future purchase re-asks.
    expect(checkout).toMatch(/customer_update:\s*\{\s*address:\s*"auto"\s*\}/);
  });

  it("offers ABN capture", () => {
    expect(checkout).toMatch(/tax_id_collection:\s*\{\s*enabled:\s*true\s*\}/);
  });

  it("raises a warning when a sale completes with tax calculation dropped", () => {
    // The degradation ladder deliberately trades correctness for the sale —
    // that is the right call, but an invoice issued with no GST must not be
    // discoverable only by reading server logs.
    expect(checkout).toMatch(/kind:\s*"checkout_degraded"/);
    expect(checkout).toMatch(/Checkout completed WITHOUT tax calculation/);
  });
});

describe("invoices are mirrored back for the customer to retrieve", () => {
  it("keys the mirror on the Stripe invoice id so replays are idempotent", () => {
    expect(invoices).toMatch(/stripe_invoice_id/);
  });

  it("prefers invoice metadata over subscription metadata when resolving scope", () => {
    expect(invoices).toMatch(/invoiceMetadata/);
  });
});

describe("a metered API-usage charge reaches a bill, not just an invoice item", () => {
  it("decides between riding a subscription cycle and raising an invoice", () => {
    // An invoice item with no invoice is never collected, and never errors.
    expect(settlement).toMatch(/planCollection/);
  });

  it("sweeps the pending item onto the invoice it raises", () => {
    // Without this Stripe raises an empty invoice and leaves the item pending
    // — the exact failure the standalone path exists to prevent.
    expect(settlement).toMatch(/pending_invoice_items_behavior:\s*"include"/);
  });

  it("finalises, because a draft invoice is not a bill", () => {
    // Finalising assigns the number, mints the hosted page and PDF, and lets
    // Stripe collect and send the receipt.
    expect(settlement).toMatch(/finalizeInvoice/);
  });

  it("keys both Stripe writes on the charge id so a retried cron cannot double-bill", () => {
    expect(settlement).toMatch(/idempotencyKey:\s*`api-usage-charge-\$\{chargeId\}`/);
    expect(settlement).toMatch(/idempotencyKey:\s*`api-usage-invoice-\$\{chargeId\}`/);
  });
});
