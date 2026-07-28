import { describe, expect, it } from "vitest";
import {
  diffCostEdits,
  indexVersion,
  MAX_CREDIT_COST,
  validateCostEdits,
} from "./report-cost-index.server";

const current = [
  { slug: "report.investment.compass", credit_cost: 12 },
  { slug: "report.investment.snapshot", credit_cost: 4 },
  { slug: "report.chart-analysis", credit_cost: 2 },
];

describe("validateCostEdits", () => {
  it("accepts a well-formed edit and returns only what actually changed", () => {
    const result = validateCostEdits(current, [
      { slug: "report.investment.compass", credit_cost: 15 },
      { slug: "report.chart-analysis", credit_cost: 2 }, // unchanged
    ]);
    expect(result.ok).toBe(true);
    expect(result.edits).toEqual([{ slug: "report.investment.compass", credit_cost: 15 }]);
  });

  it("rejects an unknown slug rather than silently ignoring it", () => {
    // A typo must not look like a successful reprice.
    const result = validateCostEdits(current, [{ slug: "report.does-not-exist", credit_cost: 5 }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown_report");
  });

  it("rejects duplicate slugs in one batch", () => {
    const result = validateCostEdits(current, [
      { slug: "report.chart-analysis", credit_cost: 3 },
      { slug: "report.chart-analysis", credit_cost: 9 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate_report");
  });

  it("rejects non-integer, non-finite and out-of-range costs", () => {
    for (const bad of [2.5, NaN, Infinity, -1, MAX_CREDIT_COST + 1]) {
      const result = validateCostEdits(current, [
        { slug: "report.chart-analysis", credit_cost: bad as number },
      ]);
      expect(result.ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it("rejects a non-numeric cost", () => {
    const result = validateCostEdits(current, [
      { slug: "report.chart-analysis", credit_cost: "3" as unknown as number },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid_cost");
  });

  it("allows zero — a free report is a legitimate price", () => {
    const result = validateCostEdits(current, [{ slug: "report.chart-analysis", credit_cost: 0 }]);
    expect(result.ok).toBe(true);
    expect(result.edits).toEqual([{ slug: "report.chart-analysis", credit_cost: 0 }]);
  });

  it("rejects an empty or non-array batch", () => {
    expect(validateCostEdits(current, []).ok).toBe(false);
    expect(validateCostEdits(current, undefined).ok).toBe(false);
    expect(validateCostEdits(current, null).ok).toBe(false);
    expect(validateCostEdits(current, { slug: "x" }).ok).toBe(false);
  });

  it("rejects a batch where nothing moves, so no empty revision is recorded", () => {
    const result = validateCostEdits(current, [
      { slug: "report.investment.compass", credit_cost: 12 },
      { slug: "report.chart-analysis", credit_cost: 2 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_changes");
  });

  it("rejects a missing or blank slug", () => {
    expect(validateCostEdits(current, [{ credit_cost: 3 } as never]).error).toBe("missing_slug");
    expect(validateCostEdits(current, [{ slug: "   ", credit_cost: 3 }]).error).toBe(
      "missing_slug",
    );
  });
});

describe("diffCostEdits", () => {
  it("reports from/to for each change, sorted and without no-ops", () => {
    expect(
      diffCostEdits(current, [
        { slug: "report.chart-analysis", credit_cost: 3 },
        { slug: "report.investment.compass", credit_cost: 12 },
        { slug: "report.investment.snapshot", credit_cost: 6 },
      ]),
    ).toEqual([
      { slug: "report.chart-analysis", from: 2, to: 3 },
      { slug: "report.investment.snapshot", from: 4, to: 6 },
    ]);
  });

  it("treats an unknown slug as coming from 0", () => {
    expect(diffCostEdits(current, [{ slug: "brand.new", credit_cost: 7 }])).toEqual([
      { slug: "brand.new", from: 0, to: 7 },
    ]);
  });
});

describe("indexVersion", () => {
  it("is the most recent updated_at, so any edit moves it", () => {
    expect(
      indexVersion([
        { updated_at: "2026-07-01T00:00:00.000Z" },
        { updated_at: "2026-07-28T12:00:00.000Z" },
        { updated_at: "2026-03-01T00:00:00.000Z" },
      ]),
    ).toBe("2026-07-28T12:00:00.000Z");
  });

  it("is stable regardless of row order", () => {
    const rows = [
      { updated_at: "2026-01-01T00:00:00.000Z" },
      { updated_at: "2026-06-01T00:00:00.000Z" },
    ];
    expect(indexVersion(rows)).toBe(indexVersion([...rows].reverse()));
  });

  it("is empty for no rows, and ignores unparseable timestamps", () => {
    expect(indexVersion([])).toBe("");
    expect(indexVersion([{ updated_at: "not-a-date" }])).toBe("");
    expect(
      indexVersion([{ updated_at: "not-a-date" }, { updated_at: "2026-05-01T00:00:00.000Z" }]),
    ).toBe("2026-05-01T00:00:00.000Z");
  });
});
