import { describe, expect, it } from "vitest";
import {
  ANNUAL_DISCOUNT,
  AML_MODULE_SLUG,
  MODULES,
  TIERS,
  annualCents,
  annualPerMonthCents,
  exGstCents,
  gstComponentCents,
  moduleBySlug,
  tierBySlug,
  tierIncludesModule,
  tierPriceCents,
  upgradesFor,
} from "./aurixa-catalog";
import { SUB_MODULE_MATRIX, enabledSubModules, tierEnablesSubModule } from "./sub-module-matrix";

const $ = (dollars: number) => Math.round(dollars * 100);

describe("GST is derived from the price, never added to it", () => {
  it("splits a tax-inclusive total into base + GST", () => {
    // $699.00 incl = $635.45 + $63.55. Adding 10% instead would bill $768.90,
    // which is the mistake this whole direction-of-travel exists to prevent.
    expect(gstComponentCents($(699))).toBe($(63.55));
    expect(exGstCents($(699))).toBe($(635.45));
  });

  it("always reconciles: base + GST is exactly the price charged", () => {
    for (const cents of [$(49), $(59), $(504), $(699), $(860), $(1055), $(2015), $(2210), 1, 0]) {
      expect(exGstCents(cents) + gstComponentCents(cents)).toBe(cents);
    }
  });

  it("never exceeds one eleventh of the total", () => {
    for (const cents of [$(504), $(860), $(2015), $(375)]) {
      expect(gstComponentCents(cents)).toBeLessThanOrEqual(Math.ceil(cents / 11));
    }
  });
});

describe("headline tier prices match the signed-off sheet", () => {
  // The sheet publishes two figures per tier. Both must fall out of the model.
  const expected = [
    { slug: "launch", without: $(504), with: $(699), seats: [1, 4] },
    { slug: "growth", without: $(860), with: $(1055), seats: [5, 15] },
    { slug: "scale", without: $(2015), with: $(2210), seats: [16, 30] },
  ];

  for (const e of expected) {
    it(`${e.slug}: $${e.without / 100} without AML/CTF, $${e.with / 100} with`, () => {
      const tier = tierBySlug(e.slug)!;
      expect(tierPriceCents(tier)).toBe(e.without);
      expect(tierPriceCents(tier, { withAml: true })).toBe(e.with);
      expect([tier.seatMin, tier.seatMax]).toEqual(e.seats);
    });
  }

  it("the with/without gap is the AML/CTF module price on every tier", () => {
    const aml = moduleBySlug(AML_MODULE_SLUG)!;
    expect(aml.monthlyInclGstCents).toBe($(195));
    for (const tier of TIERS) {
      expect(tierPriceCents(tier, { withAml: true }) - tierPriceCents(tier)).toBe(
        aml.monthlyInclGstCents,
      );
    }
  });

  it("seat bands are contiguous and non-overlapping", () => {
    const sorted = [...TIERS].sort((a, b) => a.seatMin - b.seatMin);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].seatMin).toBe(sorted[i - 1].seatMax + 1);
    }
  });
});

describe("annual billing takes 10% off twelve months", () => {
  it("is 10%", () => {
    expect(ANNUAL_DISCOUNT).toBe(0.1);
  });

  it("lands on exact cents for every tier", () => {
    expect(annualCents($(504))).toBe($(5443.2));
    expect(annualCents($(860))).toBe($(9288));
    expect(annualCents($(2015))).toBe($(21762));
  });

  it("is cheaper than paying monthly, by exactly a tenth", () => {
    for (const tier of TIERS) {
      const monthly12 = tier.monthlyInclGstCents * 12;
      const annual = tierPriceCents(tier, { period: "annual" });
      expect(monthly12 - annual).toBe(Math.round(monthly12 * 0.1));
    }
  });

  it("applies to the AML-inclusive price too", () => {
    const launch = tierBySlug("launch")!;
    expect(tierPriceCents(launch, { period: "annual", withAml: true })).toBe(annualCents($(699)));
  });

  it("reports a sensible per-month equivalent", () => {
    expect(annualPerMonthCents($(504))).toBe($(453.6));
  });

  it("stays tax-inclusive, so GST still divides out of the annual total", () => {
    const annual = annualCents($(504));
    expect(exGstCents(annual) + gstComponentCents(annual)).toBe(annual);
  });
});

describe("module catalogue", () => {
  it("carries all 23 priced modules from the sheet", () => {
    expect(MODULES).toHaveLength(23);
    expect(MODULES.every((m) => m.monthlyInclGstCents > 0)).toBe(true);
  });

  it("has unique slugs", () => {
    expect(new Set(MODULES.map((m) => m.slug)).size).toBe(MODULES.length);
  });

  it("spot-checks prices against the sheet", () => {
    expect(moduleBySlug("market-updates")!.monthlyInclGstCents).toBe($(59));
    expect(moduleBySlug("aurixa-agent")!.monthlyInclGstCents).toBe($(375));
    expect(moduleBySlug("client-forms")!.monthlyInclGstCents).toBe($(49));
    expect(moduleBySlug("finance-portal")!.monthlyInclGstCents).toBe($(225));
  });

  it("only ever references tiers that exist", () => {
    const slugs = new Set(TIERS.map((t) => t.slug));
    for (const m of MODULES) {
      for (const t of m.includedIn) expect(slugs.has(t)).toBe(true);
    }
  });

  it("includes with Growth exactly what the sheet introduces at Growth", () => {
    const added = MODULES.filter(
      (m) => m.includedIn.includes("growth") && !m.includedIn.includes("launch"),
    ).map((m) => m.slug);
    expect(added.sort()).toEqual(
      ["cashflow-comparisons", "deal-pipeline", "market-updates", "report-comparisons"].sort(),
    );
  });

  it("keeps AML/CTF an add-on on every tier — it is what the gap is made of", () => {
    expect(moduleBySlug(AML_MODULE_SLUG)!.includedIn).toEqual([]);
    for (const tier of TIERS) expect(tierIncludesModule(tier.slug, AML_MODULE_SLUG)).toBe(false);
  });

  it("offers fewer upgrades the higher the tier", () => {
    expect(upgradesFor("launch").length).toBeGreaterThan(upgradesFor("growth").length);
    expect(upgradesFor("growth").length).toBeGreaterThan(upgradesFor("scale").length);
  });
});

describe("sub-module entitlement matrix", () => {
  it("covers all 34 sub-modules", () => {
    expect(SUB_MODULE_MATRIX).toHaveLength(34);
    expect(new Set(SUB_MODULE_MATRIX.map((r) => r.key)).size).toBe(34);
  });

  it("never takes away what a lower tier had", () => {
    // A customer upgrading must not silently lose a capability.
    for (const row of SUB_MODULE_MATRIX) {
      if (row.launch) expect(row.growth).toBe(true);
      if (row.growth) expect(row.scale).toBe(true);
    }
  });

  it("matches the sheet at the boundaries", () => {
    expect(tierEnablesSubModule("launch", "generated-reports.comparisons")).toBe(false);
    expect(tierEnablesSubModule("growth", "generated-reports.comparisons")).toBe(true);
    expect(tierEnablesSubModule("growth", "clients.borrowing-capacity")).toBe(false);
    expect(tierEnablesSubModule("scale", "clients.borrowing-capacity")).toBe(true);
  });

  it("leaves Emails and Lenders off on every tier", () => {
    for (const tier of ["launch", "growth", "scale"]) {
      expect(tierEnablesSubModule(tier, "clients.emails")).toBe(false);
      expect(tierEnablesSubModule(tier, "clients.lenders")).toBe(false);
    }
  });

  it("denies unknown keys and unknown tiers rather than defaulting open", () => {
    expect(tierEnablesSubModule("scale", "clients.not-a-thing")).toBe(false);
    expect(tierEnablesSubModule("enterprise", "clients.review")).toBe(false);
  });

  it("grows monotonically across tiers", () => {
    expect(enabledSubModules("launch").length).toBe(20);
    expect(enabledSubModules("growth").length).toBe(23);
    expect(enabledSubModules("scale").length).toBe(32);
  });
});
