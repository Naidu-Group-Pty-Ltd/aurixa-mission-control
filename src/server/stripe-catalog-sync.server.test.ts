import { describe, expect, it } from "vitest";
import { orderRenames, planCatalogSync, type PlanRow } from "./stripe-catalog-sync.server";
import { annualCents, gstComponentCents } from "@/lib/pricing/aurixa-catalog";

// The live catalog as it stands: four plans, of which two are being repurposed.
const LIVE: PlanRow[] = [
  { id: "1", slug: "launch", name: "Launch", price_cents: 74900 },
  { id: "2", slug: "professional", name: "Professional", price_cents: 275000 },
  { id: "3", slug: "growth", name: "Growth", price_cents: 650000 },
  { id: "4", slug: "enterprise", name: "Enterprise", price_cents: 1750000 },
];

describe("orderRenames — the slug collision that would break the cutover", () => {
  it("vacates growth before professional moves into it", () => {
    // Naively renaming professional→growth first hits the live growth row's
    // unique slug index. Growth must become scale first.
    const { ordered, blocked } = orderRenames(
      [
        { from: "professional", to: "growth", name: "Growth" },
        { from: "growth", to: "scale", name: "Scale" },
      ],
      new Set(["launch", "professional", "growth", "enterprise"]),
    );
    expect(blocked).toEqual([]);
    expect(ordered.map((o) => `${o.from}->${o.to}`)).toEqual([
      "growth->scale",
      "professional->growth",
    ]);
  });

  it("ignores a rename that is already where it belongs", () => {
    const { ordered } = orderRenames(
      [{ from: "launch", to: "launch", name: "Launch" }],
      new Set(["launch"]),
    );
    expect(ordered).toEqual([]);
  });

  it("moves straight away when the target slug is free", () => {
    const { ordered } = orderRenames(
      [{ from: "old", to: "brand-new", name: "New" }],
      new Set(["old"]),
    );
    expect(ordered).toHaveLength(1);
  });

  it("reports a genuine cycle instead of half-applying it", () => {
    // a→b and b→a cannot be done without a temporary name. Better to refuse
    // than to leave the catalog in a state nobody planned.
    const { ordered, blocked } = orderRenames(
      [
        { from: "a", to: "b", name: "B" },
        { from: "b", to: "a", name: "A" },
      ],
      new Set(["a", "b"]),
    );
    expect(ordered).toEqual([]);
    expect(blocked).toHaveLength(2);
  });
});

describe("planCatalogSync", () => {
  const plan = planCatalogSync(LIVE);

  it("plans the three tier moves and leaves enterprise alone", () => {
    expect(plan.renames.map((r) => `${r.from}->${r.to}`)).toEqual([
      "growth->scale",
      "professional->growth",
    ]);
    expect(plan.untouched).toEqual(["enterprise"]);
    expect(plan.warnings).toEqual([]);
  });

  it("mints a monthly and an annual price for every tier", () => {
    expect(plan.prices).toHaveLength(6);
    for (const slug of ["launch", "growth", "scale"]) {
      const forTier = plan.prices.filter((p) => p.tierSlug === slug);
      expect(forTier.map((p) => p.interval).sort()).toEqual(["month", "year"]);
    }
  });

  it("prices the tiers at the sheet's without-AML figures", () => {
    const monthly = (slug: string) =>
      plan.prices.find((p) => p.tierSlug === slug && p.interval === "month")!.unitAmount;
    expect(monthly("launch")).toBe(50400);
    expect(monthly("growth")).toBe(86000);
    expect(monthly("scale")).toBe(201500);
  });

  it("discounts the annual price by 10% of twelve months", () => {
    const yearly = (slug: string) =>
      plan.prices.find((p) => p.tierSlug === slug && p.interval === "year")!.unitAmount;
    expect(yearly("launch")).toBe(annualCents(50400));
    expect(yearly("launch")).toBe(544320);
    expect(yearly("scale")).toBe(2176200);
  });

  it("carries the GST contained in each amount, never added to it", () => {
    for (const p of plan.prices) {
      expect(p.gstComponent).toBe(gstComponentCents(p.unitAmount));
      expect(p.gstComponent).toBeLessThan(p.unitAmount);
    }
  });

  it("flags a tier with no row to reuse instead of silently skipping it", () => {
    const withoutProfessional = LIVE.filter((r) => r.slug !== "professional");
    const p = planCatalogSync(withoutProfessional);
    expect(p.missing).toContain("growth");
    expect(p.warnings.join(" ")).toMatch(/no catalog row 'professional'/i);
  });

  it("is stable — planning twice gives the same plan", () => {
    expect(planCatalogSync(LIVE)).toEqual(plan);
  });
});
