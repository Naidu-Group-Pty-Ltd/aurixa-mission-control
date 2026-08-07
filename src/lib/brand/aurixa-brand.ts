/**
 * The Aurixa Systems brand, as Stripe consumes it.
 *
 * NOT to be confused with `src/server/branding/` — that is the white-label
 * engine that cascades a *clone's* brand to a tenant. This module is the
 * opposite direction and a much smaller thing: our own identity, in the exact
 * shape Stripe's account branding takes, so that every customer-facing surface
 * Stripe renders on our behalf (receipts, invoice PDFs, the hosted invoice
 * page, Checkout, Payment Links, the customer portal, and the emails that
 * carry them) reads as Aurixa rather than as an unstyled Stripe default.
 *
 * Values are lifted verbatim from the marketing site's design tokens
 * (`aurixa-systems/src/index.css`, the `@theme` block). They are duplicated
 * here rather than imported because the two are separate deployments — the
 * test in `aurixa-brand.test.ts` is what stops them drifting silently.
 *
 * ── Why the dark colour is the *secondary* one ──────────────────────────────
 * Stripe gives exactly two colours, and they are not interchangeable:
 *
 *   Brand colour  (primary_color)   accents, buttons and headings. Rendered on
 *                                   emails, the customer portal, the hosted
 *                                   invoice page and invoice PDFs.
 *   Accent colour (secondary_color) the BACKGROUND of emails and hosted pages,
 *                                   and of Checkout and Payment Links.
 *
 * So a dark-mode Aurixa is: gold as the brand colour, and the site's own page
 * ground as the accent colour. Putting the dark value in `primary_color`
 * instead would paint near-black text on a near-white page and lose the dark
 * treatment entirely — the mistake is easy to make and invisible until a real
 * receipt lands in somebody's inbox.
 *
 * The invoice PDF is the one surface that stays light: it is a document meant
 * to be printed and filed, Stripe gives no control over its paper, and a
 * dark-flooded A4 page is a wasted cartridge. It picks up the brand colour and
 * the logo, which is what carries the identity there.
 */

/** The marketing site's `@theme` tokens, as literal hex. */
export const AURIXA_PALETTE = {
  /** `--color-base-950`. The page ground on every Aurixa surface. */
  base950: "#040B16",
  /** `--color-base-900`. One step up; the glow behind the symbol. */
  base900: "#0B162C",
  /** `--color-prism-magenta` — the deep gold that the logo is drawn in. */
  gold: "#C89B3C",
  /** `--color-prism-gold`. The lighter gold, for text on dark grounds. */
  goldLight: "#F5D17A",
  /** `--color-prism-cyan`. The interactive/secondary accent. */
  cyan: "#00A8B5",
  textPrimary: "#FFFFFF",
  textSecondary: "#9CA3AF",
} as const;

/**
 * What `account.settings.branding` should hold.
 *
 * `icon` and `logo` are Stripe File ids, minted at apply time from the PNGs
 * below — they are not knowable ahead of time and so are not part of this
 * constant.
 */
export const AURIXA_STRIPE_BRANDING = {
  /** Accents, buttons and headings. */
  primaryColor: AURIXA_PALETTE.gold,
  /** Backgrounds — this is the value that makes the surfaces dark. */
  secondaryColor: AURIXA_PALETTE.base950,
} as const;

export type BrandAssetKind = "icon" | "logo";

export type BrandAssetSpec = {
  kind: BrandAssetKind;
  /** Path under the marketing site's public root. */
  path: string;
  /** What Stripe stores it as. Both marks use the same file purpose. */
  purpose: "business_logo";
  /** Recorded so a swapped file is caught before it reaches Stripe. */
  width: number;
  height: number;
};

/**
 * The two marks Stripe takes, built by
 * `aurixa-systems/scripts/build-stripe-brand-assets.py`.
 *
 * Both are rendered ON the `base950` ground rather than shipped transparent.
 * Stripe places them on surfaces we do not control — a white invoice PDF, a
 * white card on the hosted invoice page, a dark email body — and the gold mark
 * on white is the weak case at roughly 2.5:1. A self-contained dark tile reads
 * identically everywhere and keeps the dark identity on the surfaces Stripe
 * insists on painting light.
 */
export const AURIXA_BRAND_ASSETS: Readonly<Record<BrandAssetKind, BrandAssetSpec>> = {
  // Square. Used almost everywhere: emails, Checkout, the portal header, the
  // hosted invoice page and invoice PDFs.
  icon: {
    kind: "icon",
    path: "/brand/stripe/aurixa-stripe-icon-dark-512.png",
    purpose: "business_logo",
    width: 512,
    height: 512,
  },
  // Non-square. Overrides the icon on Checkout and on invoice PDFs, which are
  // the two places with room for the full lockup.
  logo: {
    kind: "logo",
    path: "/brand/stripe/aurixa-stripe-logo-dark.png",
    purpose: "business_logo",
    width: 1600,
    height: 604,
  },
};

/** Where the assets are served from when nothing overrides it. */
export const DEFAULT_BRAND_ASSET_ORIGIN = "https://aurixasystems.com.au";

/** Absolute URL for a brand asset on a given origin. */
export function brandAssetUrl(asset: BrandAssetSpec, origin = DEFAULT_BRAND_ASSET_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}${asset.path}`;
}

/** Stripe's stated limits for a branding image. Asserted before upload. */
export const STRIPE_IMAGE_LIMITS = {
  minEdgePx: 128,
  maxBytes: 512 * 1024,
  /** Stripe accepts only these two. */
  contentTypes: ["image/png", "image/jpeg"] as const,
} as const;

/**
 * The footer printed on every invoice PDF and hosted invoice page.
 *
 * This is branding in the sense that matters to somebody holding a tax
 * invoice: who issued it, in what currency, and where to ask about it. Stripe
 * has an account-level default footer, but it is Dashboard-only — setting it
 * on the Customer (and on one-off invoices) is the only way to get it from
 * code, which is why it lives here.
 *
 * No registration number appears here on purpose. Stripe already prints the
 * account's registered business details from Business settings, and the number
 * on the Stripe account (695 868 243) is nine digits — an ACN, not the
 * eleven-digit ABN a tax invoice needs. Typing a padded guess onto every
 * customer's tax invoice is the kind of wrong that only surfaces at audit, so
 * the line is left to the Dashboard, which has the real value.
 *
 * Kept short: Stripe renders the footer in small type at the bottom of the PDF
 * and does not paginate it.
 */
export const AURIXA_INVOICE_FOOTER = [
  "Aurixa System Pty Ltd · aurixasystems.com.au",
  "All amounts are in AUD and include GST.",
  "Questions about this invoice: admin@aurixasystems.com.au",
].join("\n");

/**
 * `invoice_settings.rendering_options` for every Customer and one-off invoice.
 *
 * `exclude_tax` would print line items ex-GST, which contradicts the entire
 * catalog: every Aurixa price is tax-INCLUSIVE, and the pricing page leads with
 * the inclusive figure. `include_inclusive_tax` is the setting that makes the
 * PDF agree with what the customer was quoted.
 */
export const AURIXA_INVOICE_RENDERING = {
  amount_tax_display: "include_inclusive_tax",
} as const;

// ── Contrast ────────────────────────────────────────────────────────────────
// Stripe picks readable text over whichever colours it is given, but it can
// only pick between black and white — it cannot rescue a pair that has no
// readable answer. These are here so a future palette edit fails a test rather
// than shipping an unreadable receipt.

/** sRGB relative luminance, per WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The better of black or white on top of `hex` — the same choice Stripe makes,
 * reproduced so the preview card can show an operator what a button will
 * actually look like before anything is applied.
 */
export function readableInkOn(hex: string): "#000000" | "#FFFFFF" {
  return contrastRatio(hex, "#000000") >= contrastRatio(hex, "#FFFFFF") ? "#000000" : "#FFFFFF";
}
