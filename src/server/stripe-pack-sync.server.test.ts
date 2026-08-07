import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TAX_CODE_SAAS, TAX_CODE_TOPUP_PACK } from "@/lib/pricing/tax-codes";
import { describe, expect, it } from "vitest";
import { planPackSync, type PackRow } from "./stripe-pack-sync.server";
import { TOPUP_PACKS, gstComponentCents } from "@/lib/pricing/aurixa-catalog";

/** The catalog immediately after the ladder migration: eight rows, all parked. */
const SEEDED: PackRow[] = [
  {
    id: "a",
    slug: "credits-50",
    name: "50 Credit Pack",
    tokens: 50,
    price_cents: 37500,
    is_active: true,
    stripe_price_id: "price_old_50",
  },
  {
    id: "b",
    slug: "credits-100",
    name: "100 Credit Pack",
    tokens: 100,
    price_cents: 67500,
    is_active: true,
    stripe_price_id: "price_old_100",
  },
  {
    id: "c",
    slug: "credits-250",
    name: "250 Credit Pack",
    tokens: 250,
    price_cents: 150000,
    is_active: true,
    stripe_price_id: "price_old_250",
  },
  {
    id: "d",
    slug: "credits-500",
    name: "500 Credit Pack",
    tokens: 500,
    price_cents: 262500,
    is_active: true,
    stripe_price_id: "price_old_500",
  },
  ...TOPUP_PACKS.map((p, i) => ({
    id: `n${i}`,
    slug: p.slug,
    name: p.name,
    tokens: p.credits,
    price_cents: p.priceInclGstCents,
    is_active: false,
    stripe_price_id: null,
  })),
];

/** What the catalog looks like once the cutover has run. */
const CUTOVER: PackRow[] = [
  ...SEEDED.slice(0, 4).map((r) => ({ ...r, is_active: false })),
  ...TOPUP_PACKS.map((p, i) => ({
    id: `n${i}`,
    slug: p.slug,
    name: p.name,
    tokens: p.credits,
    price_cents: p.priceInclGstCents,
    is_active: true,
    stripe_price_id: `price_new_${p.slug}`,
  })),
];

describe("planPackSync", () => {
  const plan = planPackSync(SEEDED);

  it("puts all eight packs on sale", () => {
    expect(plan.packs).toHaveLength(8);
    expect(plan.packs.map((p) => p.slug)).toEqual(TOPUP_PACKS.map((p) => p.slug));
    expect(plan.warnings).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("charges the sheet's tax-inclusive figure and reports the GST inside it", () => {
    for (const op of plan.packs) {
      expect(op.gstComponent).toBe(gstComponentCents(op.unitAmount));
      expect(op.gstComponent).toBeLessThan(op.unitAmount);
    }
    expect(plan.packs[0].unitAmount).toBe(2090);
    expect(plan.packs[7].unitAmount).toBe(71390);
  });

  it("retires exactly the four packs the ladder supersedes", () => {
    expect(plan.retire.sort()).toEqual(["credits-100", "credits-250", "credits-50", "credits-500"]);
  });

  it("does not treat a parked row as already selling", () => {
    // Price matches, but the row is inactive and unlinked — which is precisely
    // the state the migration leaves behind, and precisely the work to do.
    expect(plan.packs.every((p) => !p.alreadyLive)).toBe(true);
  });
});

describe("when the migration has not been applied", () => {
  it("refuses rather than inventing catalog rows", () => {
    const plan = planPackSync(SEEDED.slice(0, 4));
    expect(plan.packs).toEqual([]);
    expect(plan.missing).toHaveLength(8);
    expect(plan.warnings.join(" ")).toMatch(/apply the top-up ladder migration first/i);
  });

  it("names the packs it cannot find", () => {
    const partial = SEEDED.filter((r) => r.slug !== "topup-5000" && r.slug !== "topup-15000");
    const plan = planPackSync(partial);
    expect(plan.missing).toEqual(["topup-5000", "topup-15000"]);
    expect(plan.packs).toHaveLength(6);
  });
});

describe("re-running after a successful cutover", () => {
  const plan = planPackSync(CUTOVER);

  it("has nothing left to retire", () => {
    // Retirement reads live rows, so a pack already off sale is not reported
    // again. Without that, every re-run would claim work it is not doing.
    expect(plan.retire).toEqual([]);
  });

  it("recognises every pack as already selling at the right price", () => {
    expect(plan.packs.every((p) => p.alreadyLive)).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("is stable — planning twice gives the same plan", () => {
    expect(planPackSync(CUTOVER)).toEqual(plan);
  });
});

describe("recovering from a partial cutover", () => {
  // Four packs got prices and went live; the run then failed, so the old packs
  // were deliberately left selling.
  const HALF: PackRow[] = CUTOVER.map((r) =>
    r.slug.startsWith("credits-")
      ? { ...r, is_active: true }
      : ["topup-5000", "topup-7500", "topup-10000", "topup-15000"].includes(r.slug)
        ? { ...r, is_active: false, stripe_price_id: null }
        : r,
  );
  const plan = planPackSync(HALF);

  it("still plans every pack, including the ones already done", () => {
    expect(plan.packs).toHaveLength(8);
    expect(plan.warnings).toEqual([]);
  });

  it("knows which four still need doing", () => {
    const pending = plan.packs.filter((p) => !p.alreadyLive).map((p) => p.slug);
    expect(pending).toEqual(["topup-5000", "topup-7500", "topup-10000", "topup-15000"]);
  });

  it("still has the old packs to retire, because they never came off sale", () => {
    expect(plan.retire).toHaveLength(4);
  });
});

describe("a pack repriced by hand", () => {
  it("is planned back onto the sheet's price", () => {
    const drifted = CUTOVER.map((r) => (r.slug === "topup-2500" ? { ...r, price_cents: 9999 } : r));
    const plan = planPackSync(drifted);
    const op = plan.packs.find((p) => p.slug === "topup-2500")!;
    expect(op.alreadyLive).toBe(false);
    expect(op.unitAmount).toBe(16390);
  });
});

describe("a pack added outside the ladder", () => {
  it("is taken off sale, not left alongside", () => {
    const extra: PackRow = {
      id: "x",
      slug: "credits-mystery",
      name: "Mystery",
      tokens: 42,
      price_cents: 4200,
      is_active: true,
      stripe_price_id: "price_x",
    };
    expect(planPackSync([...CUTOVER, extra]).retire).toEqual(["credits-mystery"]);
  });
});

describe("credit pack tax code", () => {
  it("taxes credit packs at purchase, as the service the credits buy", () => {
    // Operator decision (2026-08-07): tax falls at purchase, not redemption.
    // So a pack is a prepayment for hosted software and carries the same code
    // as the tiers and modules.
    expect(TAX_CODE_TOPUP_PACK).toBe(TAX_CODE_SAAS);
  });

  it("is deliberately NOT the gift-card code", () => {
    // txcd_90020000 models stored value: non-taxable at purchase, with the
    // liability deferred to redemption. That is the opposite of the decision,
    // and picking it by accident would zero-rate every top-up sale.
    expect(TAX_CODE_TOPUP_PACK).not.toBe("txcd_90020000");
  });

  it("sets the code on every path the sync can take, not just creation", () => {
    // A pack resolved through an existing price or through metadata search
    // would otherwise keep whatever code it already carried — which for the
    // four legacy packs was "General — Tangible Goods".
    const src = readFileSync(join(process.cwd(), "src/server/stripe-pack-sync.server.ts"), "utf8");
    const occurrences = src.match(/tax_code:\s*TAX_CODE_TOPUP_PACK/g) ?? [];
    expect(occurrences.length).toBe(3);
  });
});
