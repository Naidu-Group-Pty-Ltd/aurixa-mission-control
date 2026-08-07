/**
 * Render the dark Aurixa tax invoice against a fixture, so the layout can be
 * looked at without issuing a real invoice.
 *
 * A REVIEW artefact. It calls the same `buildInvoiceDocument` and
 * `renderInvoicePdf` the download route calls, with a Stripe-shaped fixture
 * standing in for a live invoice — so what comes out is what a customer would
 * get, minus their name.
 *
 *   bun run scripts/render-invoice-pdf-preview.ts [out.pdf]
 *
 * The logo is read from a local checkout of the storefront repo if one is
 * beside this one, else fetched from the live site, else omitted — the
 * renderer falls back to setting the wordmark in type, which is the same path
 * a fetch failure takes in production.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildInvoiceDocument, type InvoiceSource } from "@/lib/brand/invoiceDocument.pure";
import { AURIXA_LOCKUP_TRANSPARENT, brandAssetUrl } from "@/lib/brand/aurixa-brand";
import { invoicePdfFilename, renderInvoicePdf } from "@/server/invoice-pdf.server";

/** One seat plan and one module, at their real catalog prices. The workspace
 *  is invented: a real customer's name on a mock invoice is how a mock gets
 *  forwarded to them by accident. */
const FIXTURE: InvoiceSource = {
  id: "in_1PreviewOnly",
  number: "9F3C21A0-0007",
  status: "paid",
  currency: "aud",
  created: 1_786_060_800,
  status_transitions: { finalized_at: 1_786_060_800, paid_at: 1_786_061_400 },
  customer_name: "Harbourline Advisory Pty Ltd",
  customer_address: {
    line1: "Level 6, 122 Walker Street",
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
      {
        description: "AML / CTF Compliance module",
        quantity: 1,
        amount: 19_500,
        period: { start: 1_786_060_800, end: 1_788_652_800 },
      },
    ],
  },
};

async function loadLogo(): Promise<Uint8Array | null> {
  const local = resolve(
    import.meta.dirname,
    "../../aurixa-systems/public",
    AURIXA_LOCKUP_TRANSPARENT.path.replace(/^\//, ""),
  );
  if (existsSync(local)) return new Uint8Array(readFileSync(local));
  try {
    const res = await fetch(brandAssetUrl(AURIXA_LOCKUP_TRANSPARENT));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {
    /* offline — the renderer sets the wordmark in type instead */
  }
  return null;
}

const doc = buildInvoiceDocument(FIXTURE);
const logo = await loadLogo();
const out = process.argv[2] ?? invoicePdfFilename(doc);
writeFileSync(out, await renderInvoicePdf(doc, logo));
console.log(
  `${out}  (logo: ${logo ? `${Math.round(logo.byteLength / 1024)} KB` : "not found, type fallback"})`,
);
