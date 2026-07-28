// The top-up ladder, checked against the sheet it was transcribed from.
//
// The sheet publishes four columns per pack and this file stores two of them.
// So every test here is really the same question asked eight times: do the two
// numbers we kept still reproduce the two we threw away? If they ever stop
// doing so, the page is quoting a per-credit rate the customer will not get.
import { describe, expect, it } from "vitest";
import {
  RETIRED_PACK_SLUGS,
  TOPUP_PACKS,
  exGstCents,
  gstComponentCents,
  packBySlug,
  packDiscountFraction,
  packPerCreditCents,
} from "./aurixa-catalog";

/** As the sheet quotes it: cents per credit, two decimals. */
const perCredit = (slug: string) => Math.round(packPerCreditCents(packBySlug(slug)!) * 100) / 100;

/** As the sheet quotes it: a percentage to one decimal. */
const discountPct = (slug: string) =>
  Math.round(packDiscountFraction(packBySlug(slug)!) * 1000) / 10;

describe("the eight packs, exactly as published", () => {
  it.each([
    [1, "topup-250", 250, 2090],
    [2, "topup-500", 500, 3850],
    [3, "topup-1000", 1000, 7150],
    [4, "topup-2500", 2500, 16390],
    [5, "topup-5000", 5000, 30690],
    [6, "topup-7500", 7500, 43890],
    [7, "topup-10000", 10000, 54890],
    [8, "topup-15000", 15000, 71390],
  ])("stage %i sells %s credits for %s cents", (stage, slug, credits, cents) => {
    const pack = packBySlug(slug as string)!;
    expect(pack).toBeDefined();
    expect(pack.stage).toBe(stage);
    expect(pack.credits).toBe(credits);
    expect(pack.priceInclGstCents).toBe(cents);
  });

  it("has eight of them and no more", () => {
    expect(TOPUP_PACKS).toHaveLength(8);
    expect(new Set(TOPUP_PACKS.map((p) => p.slug)).size).toBe(8);
  });

  it("never reuses a slug the ladder replaces", () => {
    // credits-250 and credits-500 carry the same credit counts as stages 1 and
    // 2 at seventy times the price. Reusing either slug would leave the old
    // Stripe price attached to a row now advertising $20.90.
    for (const slug of RETIRED_PACK_SLUGS) expect(packBySlug(slug)).toBeUndefined();
  });
});

describe("price per credit", () => {
  it.each([
    ["topup-250", 8.36],
    ["topup-500", 7.7],
    ["topup-1000", 7.15],
    ["topup-2500", 6.56],
    ["topup-5000", 6.14],
    ["topup-7500", 5.85],
    ["topup-10000", 5.49],
    ["topup-15000", 4.76],
  ])("%s works out to %s cents a credit", (slug, cents) => {
    expect(perCredit(slug as string)).toBe(cents);
  });

  it("gets cheaper at every single step up the ladder", () => {
    // The one property a top-up ladder must have: buying more can never cost
    // more per credit, or a customer is better off buying two smaller packs.
    for (let i = 1; i < TOPUP_PACKS.length; i++) {
      expect(packPerCreditCents(TOPUP_PACKS[i])).toBeLessThan(
        packPerCreditCents(TOPUP_PACKS[i - 1]),
      );
    }
  });

  it("is stored unrounded, because the discount column depends on it", () => {
    // 2,500 credits: 6.556c rounds to 6.56c, and the sheet's 21.6% discount
    // only comes out of the unrounded figure. Rounding here reads 21.5%.
    expect(packPerCreditCents(packBySlug("topup-2500")!)).toBeCloseTo(6.556, 3);
  });
});

describe("discount from the smallest pack", () => {
  it.each([
    ["topup-500", 7.9],
    ["topup-1000", 14.5],
    ["topup-2500", 21.6],
    ["topup-5000", 26.6],
    ["topup-7500", 30.0],
    ["topup-10000", 34.3],
    ["topup-15000", 43.1],
  ])("%s is %s%% cheaper per credit", (slug, pct) => {
    expect(discountPct(slug as string)).toBe(pct);
  });

  it("is nothing at all for the pack it measures against", () => {
    expect(packDiscountFraction(TOPUP_PACKS[0])).toBe(0);
  });

  it("only ever grows", () => {
    for (let i = 1; i < TOPUP_PACKS.length; i++) {
      expect(packDiscountFraction(TOPUP_PACKS[i])).toBeGreaterThan(
        packDiscountFraction(TOPUP_PACKS[i - 1]),
      );
    }
  });
});

describe("GST", () => {
  it("is contained in the price, never added to it", () => {
    // Same direction as the tier prices: the sheet's heading is "incl. GST",
    // so 15,000 credits cost $713.90 and $64.90 of that is tax. Adding 10%
    // instead would bill $785.29.
    for (const pack of TOPUP_PACKS) {
      const gst = gstComponentCents(pack.priceInclGstCents);
      expect(gst).toBeLessThan(pack.priceInclGstCents);
      expect(exGstCents(pack.priceInclGstCents) + gst).toBe(pack.priceInclGstCents);
    }
    expect(gstComponentCents(71390)).toBe(6490);
    expect(gstComponentCents(2090)).toBe(190);
  });
});

describe("the sheet's positioning column", () => {
  it("marks exactly one pack popular and exactly one best value", () => {
    expect(TOPUP_PACKS.filter((p) => p.popular).map((p) => p.slug)).toEqual(["topup-5000"]);
    expect(TOPUP_PACKS.filter((p) => p.bestValue).map((p) => p.slug)).toEqual(["topup-15000"]);
  });

  it("gives every pack a reason to exist", () => {
    for (const pack of TOPUP_PACKS) expect(pack.positioning.trim().length).toBeGreaterThan(0);
  });

  it("numbers the stages 1 to 8 in ladder order", () => {
    expect(TOPUP_PACKS.map((p) => p.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
