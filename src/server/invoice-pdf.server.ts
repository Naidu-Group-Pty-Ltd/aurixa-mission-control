/**
 * The dark Aurixa tax invoice, as an actual PDF.
 *
 * Stripe's invoice PDF is white and cannot be made otherwise — its branding
 * controls stop at the logo and the brand colour, and invoice rendering
 * templates carry only the memo, footer, custom fields and line grouping. So
 * the dark document is one we render, from figures Stripe issued.
 *
 * Stripe's PDF remains the system of record and is still linked everywhere it
 * was. This is a second *presentation* of the same invoice, which is only safe
 * because `invoiceDocument.pure.ts` copies every figure and derives none, and
 * because the page names the Stripe invoice it restates.
 *
 * ── Choices worth knowing about ─────────────────────────────────────────────
 *
 * **Helvetica, not Inter.** Inter is the brand's sans, but embedding it means
 * carrying font bytes in a Cloudflare Worker bundle for every request that is
 * not a PDF. Helvetica is one of the PDF standard 14: no bytes, no fontkit, and
 * every reader on earth has it. The identity here is carried by the ground, the
 * gold and the lockup.
 *
 * **The ink is painted, not assumed.** A dark PDF prints dark only if the
 * reader is asked to print backgrounds; on paper this page is meant to be read
 * on screen. That is a real trade and it is why Stripe's white PDF is kept.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getStripe } from "@/server/stripe.server";
import {
  AURIXA_LOCKUP_TRANSPARENT,
  AURIXA_PALETTE,
  DEFAULT_BRAND_ASSET_ORIGIN,
  brandAssetUrl,
} from "@/lib/brand/aurixa-brand";
import { buildInvoiceDocument, type InvoiceDocument } from "@/lib/brand/invoiceDocument.pure";

/** #RRGGBB → pdf-lib's 0..1 rgb triple. */
function hex(value: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`not a 6-digit hex colour: ${value}`);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const INK = {
  ground: hex(AURIXA_PALETTE.base950),
  gold: hex(AURIXA_PALETTE.gold),
  goldLight: hex(AURIXA_PALETTE.goldLight),
  primary: hex("#E8EDF5"),
  muted: hex("#8A97AB"),
  faint: hex("#4A566B"),
};

// A4 in points, and a margin wide enough that a duplex print does not lose the
// left column to the binding edge.
const PAGE = { width: 595.28, height: 841.89 };
const M = 46;
const RIGHT = PAGE.width - M;

type Ctx = { page: PDFPage; regular: PDFFont; bold: PDFFont };

function text(
  ctx: Ctx,
  value: string,
  opts: { x: number; y: number; size: number; bold?: boolean; color?: ReturnType<typeof rgb> },
) {
  ctx.page.drawText(value, {
    x: opts.x,
    y: opts.y,
    size: opts.size,
    font: opts.bold ? ctx.bold : ctx.regular,
    color: opts.color ?? INK.primary,
  });
}

/** Right-aligned. Amount columns must line up on the decimal, not the start. */
function textRight(
  ctx: Ctx,
  value: string,
  opts: { right: number; y: number; size: number; bold?: boolean; color?: ReturnType<typeof rgb> },
) {
  const font = opts.bold ? ctx.bold : ctx.regular;
  text(ctx, value, { ...opts, x: opts.right - font.widthOfTextAtSize(value, opts.size) });
}

/** Letter-spaced small caps, the way every label on the brand is set. */
function label(
  ctx: Ctx,
  value: string,
  opts: { x?: number; right?: number; y: number; color?: ReturnType<typeof rgb> },
) {
  const spaced = value.toUpperCase().split("").join(" ");
  const common = { y: opts.y, size: 6.5, bold: true, color: opts.color ?? INK.muted };
  if (opts.right !== undefined) textRight(ctx, spaced, { ...common, right: opts.right });
  else text(ctx, spaced, { ...common, x: opts.x ?? M });
}

function rule(
  ctx: Ctx,
  y: number,
  opts: { color?: ReturnType<typeof rgb>; thickness?: number } = {},
) {
  ctx.page.drawRectangle({
    x: M,
    y,
    width: RIGHT - M,
    height: opts.thickness ?? 0.6,
    color: opts.color ?? INK.faint,
  });
}

/**
 * Render the document. `logo` is the dark lockup PNG; when it is absent the
 * wordmark is set in type instead, because a missing asset must not cost the
 * customer their invoice.
 */
export async function renderInvoicePdf(
  doc: InvoiceDocument,
  logo?: Uint8Array | null,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${doc.title} ${doc.number} — Aurixa Systems`);
  pdf.setAuthor("Aurixa System Pty Ltd");
  pdf.setProducer("Aurixa Mission Control");
  pdf.setCreator("Aurixa Mission Control");

  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const ctx: Ctx = {
    page,
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  // The ground. Full bleed, so there is no white margin on screen.
  page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: INK.ground });

  let y = PAGE.height - M;

  // ── Masthead ──────────────────────────────────────────────────────────────
  if (logo?.byteLength) {
    const image = await pdf.embedPng(logo);
    const width = 168;
    const height = (image.height / image.width) * width;
    y -= height;
    page.drawImage(image, { x: M, y, width, height });
  } else {
    y -= 24;
    text(ctx, "AURIXA", { x: M, y, size: 20, bold: true, color: INK.gold });
    text(ctx, "SYSTEMS", { x: M + 92, y: y + 3, size: 8, bold: true, color: INK.goldLight });
  }

  const mastheadTop = PAGE.height - M;
  textRight(ctx, doc.title.toUpperCase(), {
    right: RIGHT,
    y: mastheadTop - 16,
    size: 17,
    bold: true,
    color: INK.goldLight,
  });
  textRight(ctx, `#${doc.number}`, {
    right: RIGHT,
    y: mastheadTop - 30,
    size: 8.5,
    color: INK.muted,
  });
  textRight(ctx, doc.statusLabel.toUpperCase(), {
    right: RIGHT,
    y: mastheadTop - 45,
    size: 7,
    bold: true,
    color: INK.gold,
  });

  y -= 22;
  rule(ctx, y, { color: INK.gold, thickness: 1.6 });

  // ── Parties ───────────────────────────────────────────────────────────────
  y -= 26;
  const columnTwo = M + (RIGHT - M) / 2;
  label(ctx, "From", { x: M, y });
  label(ctx, "Bill to", { x: columnTwo, y });
  y -= 14;
  text(ctx, doc.from.name, { x: M, y, size: 10, bold: true });
  text(ctx, doc.billTo.name, { x: columnTwo, y, size: 10, bold: true });

  const rows = Math.max(doc.from.lines.length, doc.billTo.lines.length);
  for (let i = 0; i < rows; i++) {
    const lineY = y - 13 - i * 12;
    if (doc.from.lines[i])
      text(ctx, doc.from.lines[i], { x: M, y: lineY, size: 9, color: INK.muted });
    if (doc.billTo.lines[i])
      text(ctx, doc.billTo.lines[i], { x: columnTwo, y: lineY, size: 9, color: INK.muted });
  }
  y -= 13 + rows * 12;

  // ── Dates and the headline figure ─────────────────────────────────────────
  y -= 22;
  label(ctx, "Date of issue", { x: M, y });
  if (doc.dueOn) label(ctx, "Date due", { x: columnTwo, y });
  label(ctx, doc.headline.label, { right: RIGHT, y });
  y -= 15;
  text(ctx, doc.issuedOn, { x: M, y, size: 10 });
  if (doc.dueOn) text(ctx, doc.dueOn, { x: columnTwo, y, size: 10 });
  textRight(ctx, doc.headline.value, {
    right: RIGHT,
    y: y - 3,
    size: 17,
    bold: true,
    color: INK.goldLight,
  });
  if (doc.statusDetail) {
    textRight(ctx, doc.statusDetail, { right: RIGHT, y: y - 16, size: 8, color: INK.muted });
    y -= 13;
  }

  // ── Line items ────────────────────────────────────────────────────────────
  y -= 34;
  const QTY_RIGHT = RIGHT - 108;
  label(ctx, "Description", { x: M, y });
  label(ctx, "Qty", { right: QTY_RIGHT, y });
  label(ctx, "Amount", { right: RIGHT, y });
  y -= 8;
  rule(ctx, y, { color: INK.gold, thickness: 1 });

  for (const line of doc.lines) {
    y -= 20;
    // Long descriptions are trimmed rather than wrapped: this document is one
    // page by contract, and a silently paginated tax invoice is worse than a
    // shortened description on a page that also carries the Stripe id.
    text(ctx, clip(ctx, line.description, QTY_RIGHT - M - 14, 9.5), { x: M, y, size: 9.5 });
    if (line.quantity)
      textRight(ctx, line.quantity, { right: QTY_RIGHT, y, size: 9.5, color: INK.muted });
    if (line.amount) textRight(ctx, line.amount, { right: RIGHT, y, size: 9.5 });
    if (line.period) {
      y -= 10;
      text(ctx, line.period, { x: M, y, size: 8, color: INK.muted });
    }
    y -= 9;
    rule(ctx, y, { color: hex("#1B2436") });
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  y -= 20;
  const totalsLeft = RIGHT - 210;
  for (const total of doc.totals) {
    const emphasised = total.emphasis !== undefined;
    if (total.emphasis === "total") {
      y -= 4;
      ctx.page.drawRectangle({
        x: totalsLeft,
        y: y + 12,
        width: RIGHT - totalsLeft,
        height: 0.6,
        color: INK.faint,
      });
      y -= 6;
    }
    text(ctx, total.label, {
      x: totalsLeft,
      y,
      size: emphasised ? 10 : 9,
      bold: emphasised,
      color: emphasised ? INK.primary : INK.muted,
    });
    textRight(ctx, total.value, {
      right: RIGHT,
      y,
      size: emphasised ? 10 : 9,
      bold: emphasised,
      color: total.emphasis === "paid" ? INK.goldLight : INK.primary,
    });
    y -= 16;
  }

  // ── Foot ──────────────────────────────────────────────────────────────────
  // Pinned to the bottom rather than flowed, so a one-line invoice and a
  // six-line one put the footer in the same place.
  let footY = M + 10 + doc.footer.length * 11;
  rule(ctx, footY + 12, { color: hex("#1B2436") });
  for (const line of doc.footer) {
    text(ctx, line, { x: M, y: footY, size: 7.5, color: INK.muted });
    footY -= 11;
  }
  text(ctx, doc.provenance, { x: M, y: M - 4, size: 6.5, color: INK.faint });

  return pdf.save();
}

/** Trim to fit `width`, with an ellipsis, measuring in the real font. */
function clip(ctx: Ctx, value: string, width: number, size: number): string {
  if (ctx.regular.widthOfTextAtSize(value, size) <= width) return value;
  let out = value;
  while (out.length > 1 && ctx.regular.widthOfTextAtSize(`${out}…`, size) > width) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/**
 * The lockup, or null — a fetch failure must not cost a customer their invoice.
 *
 * The TRANSPARENT variant, not the tile Stripe gets: this page's ground is ours,
 * and compositing the opaque tile onto it leaves a visible box edge where the
 * tile's glow stops against the page.
 */
async function loadLogo(): Promise<Uint8Array | null> {
  const origin = process.env.AURIXA_BRAND_ASSET_ORIGIN?.trim() || DEFAULT_BRAND_ASSET_ORIGIN;
  try {
    const res = await fetch(brandAssetUrl(AURIXA_LOCKUP_TRANSPARENT, origin));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Fetch a Stripe invoice and render it.
 *
 * Read live from Stripe rather than from the `invoices` mirror: the mirror
 * carries totals but not line items or the billing address, and a tax invoice
 * assembled from a partial copy is exactly the divergence this whole approach
 * is trying to avoid. The mirror's job here is authorisation, not content.
 */
export async function renderStripeInvoicePdf(stripeInvoiceId: string): Promise<Uint8Array> {
  const invoice = await getStripe().invoices.retrieve(stripeInvoiceId, {
    expand: ["lines"],
  });
  const [doc, logo] = [buildInvoiceDocument(invoice), await loadLogo()];
  return renderInvoicePdf(doc, logo);
}

/** `Aurixa-tax-invoice-<number>.pdf`, safe for a Content-Disposition header. */
export function invoicePdfFilename(doc: InvoiceDocument): string {
  const slug = doc.number.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `Aurixa-tax-invoice-${slug || "invoice"}.pdf`;
}
