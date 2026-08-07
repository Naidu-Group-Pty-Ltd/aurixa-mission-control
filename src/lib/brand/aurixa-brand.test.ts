import { describe, expect, it } from "vitest";
import {
  AURIXA_BRAND_ASSETS,
  AURIXA_INVOICE_FOOTER,
  AURIXA_INVOICE_RENDERING,
  AURIXA_PALETTE,
  AURIXA_STRIPE_BRANDING,
  DEFAULT_BRAND_ASSET_ORIGIN,
  STRIPE_IMAGE_LIMITS,
  brandAssetUrl,
  contrastRatio,
  readableInkOn,
  relativeLuminance,
} from "./aurixa-brand";

describe("contrast maths", () => {
  it("agrees with the WCAG reference points", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 6);
  });

  it("is order independent and tolerant of a missing hash", () => {
    expect(contrastRatio("#040B16", "#C89B3C")).toBeCloseTo(contrastRatio("#C89B3C", "#040B16"), 9);
    expect(relativeLuminance("040B16")).toBe(relativeLuminance("#040b16"));
  });

  it("rejects anything that is not a 6-digit hex", () => {
    expect(() => relativeLuminance("#fff")).toThrow();
    expect(() => relativeLuminance("rebeccapurple")).toThrow();
  });
});

describe("the Stripe branding contract", () => {
  // The failure this guards against is the whole reason the module exists:
  // Stripe paints backgrounds with the SECONDARY colour and accents with the
  // PRIMARY one. Swapping them produces a light page with near-black accents —
  // valid, applied without complaint, and not dark mode.
  it("puts the dark ground in secondary_color, where Stripe paints backgrounds", () => {
    expect(AURIXA_STRIPE_BRANDING.secondaryColor).toBe(AURIXA_PALETTE.base950);
    expect(AURIXA_STRIPE_BRANDING.primaryColor).toBe(AURIXA_PALETTE.gold);
    expect(relativeLuminance(AURIXA_STRIPE_BRANDING.secondaryColor)).toBeLessThan(
      relativeLuminance(AURIXA_STRIPE_BRANDING.primaryColor),
    );
  });

  it("is genuinely a dark background rather than a dim one", () => {
    // Anything above this stops reading as dark mode and starts reading as a
    // mistake. #040B16 sits at ~0.005.
    expect(relativeLuminance(AURIXA_STRIPE_BRANDING.secondaryColor)).toBeLessThan(0.02);
    expect(contrastRatio(AURIXA_STRIPE_BRANDING.secondaryColor, "#FFFFFF")).toBeGreaterThan(17);
  });

  it("leaves Stripe a readable answer for text on the brand colour", () => {
    // Stripe can only choose black or white over the brand colour. The gold
    // takes black at ~5.9:1; a darker gold would leave neither option passing.
    const ink = readableInkOn(AURIXA_STRIPE_BRANDING.primaryColor);
    expect(ink).toBe("#000000");
    expect(contrastRatio(AURIXA_STRIPE_BRANDING.primaryColor, ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the gold legible on its own ground", () => {
    // Gold on base-950 is what a heading or a button on a dark hosted page
    // amounts to. 3:1 is the WCAG floor for large text and UI components.
    expect(
      contrastRatio(AURIXA_PALETTE.gold, AURIXA_STRIPE_BRANDING.secondaryColor),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(AURIXA_PALETTE.goldLight, AURIXA_STRIPE_BRANDING.secondaryColor),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("uses only 6-digit hex, which is all Stripe accepts", () => {
    for (const value of Object.values(AURIXA_STRIPE_BRANDING)) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
    for (const value of Object.values(AURIXA_PALETTE)) {
      expect(value).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("the brand assets", () => {
  it("declares an icon Stripe will accept", () => {
    const { icon } = AURIXA_BRAND_ASSETS;
    expect(icon.width).toBe(icon.height);
    expect(icon.width).toBeGreaterThanOrEqual(STRIPE_IMAGE_LIMITS.minEdgePx);
    expect(icon.path).toMatch(/\.png$/);
  });

  it("declares a logo that is not square, which is the only reason it exists", () => {
    const { logo } = AURIXA_BRAND_ASSETS;
    expect(logo.width).not.toBe(logo.height);
    expect(Math.min(logo.width, logo.height)).toBeGreaterThanOrEqual(STRIPE_IMAGE_LIMITS.minEdgePx);
  });

  it("uploads both marks under the file purpose Stripe reserves for branding", () => {
    for (const asset of Object.values(AURIXA_BRAND_ASSETS)) {
      expect(asset.purpose).toBe("business_logo");
    }
  });

  it("builds absolute URLs and does not double the slash", () => {
    expect(brandAssetUrl(AURIXA_BRAND_ASSETS.icon)).toBe(
      `${DEFAULT_BRAND_ASSET_ORIGIN}${AURIXA_BRAND_ASSETS.icon.path}`,
    );
    expect(brandAssetUrl(AURIXA_BRAND_ASSETS.logo, "https://staging.example.com/")).toBe(
      `https://staging.example.com${AURIXA_BRAND_ASSETS.logo.path}`,
    );
  });
});

describe("invoice presentation", () => {
  it("shows tax inclusively, because every Aurixa price is tax-inclusive", () => {
    expect(AURIXA_INVOICE_RENDERING.amount_tax_display).toBe("include_inclusive_tax");
  });

  it("keeps the footer to three short lines Stripe can set in small type", () => {
    const lines = AURIXA_INVOICE_FOOTER.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(AURIXA_INVOICE_FOOTER).toContain("aurixasystems.com.au");
    expect(AURIXA_INVOICE_FOOTER).toContain("GST");
  });

  it("carries no registration number", () => {
    // The number on the Stripe account is a nine-digit ACN, not the eleven
    // digits an ABN needs. A padded guess on a tax invoice is the kind of
    // wrong that only surfaces at audit — the Dashboard holds the real value.
    expect(AURIXA_INVOICE_FOOTER).not.toMatch(/\bABN\b/i);
    expect(AURIXA_INVOICE_FOOTER).not.toMatch(/\d[\d\s]{8,}/);
  });
});
