import { describe, it, expect } from "vitest";
import { tierRank, classifyChange } from "./entitlement-modules.server";

describe("tierRank", () => {
  it("orders the tier ladder", () => {
    expect(tierRank("launch")).toBeLessThan(tierRank("growth"));
    expect(tierRank("growth")).toBeLessThan(tierRank("scale"));
  });

  it("returns -1 for anything off the ladder", () => {
    expect(tierRank("enterprise")).toBe(-1);
    expect(tierRank(null)).toBe(-1);
    expect(tierRank(undefined)).toBe(-1);
  });
});

describe("classifyChange", () => {
  it("calls a first reconciliation initial", () => {
    expect(classifyChange(null, "growth")).toBe("initial");
  });

  it("detects movement up and down the ladder", () => {
    expect(classifyChange("launch", "growth")).toBe("upgrade");
    expect(classifyChange("launch", "scale")).toBe("upgrade");
    expect(classifyChange("scale", "growth")).toBe("downgrade");
    expect(classifyChange("scale", "launch")).toBe("downgrade");
  });

  it("calls a same-tier change lateral", () => {
    expect(classifyChange("growth", "growth")).toBe("lateral");
  });

  it("refuses to call an off-ladder move an upgrade", () => {
    // Treating an unknown plan as an upgrade would install modules nobody
    // bought, so anything we cannot rank is lateral.
    expect(classifyChange("legacy-pro", "scale")).toBe("lateral");
    expect(classifyChange("launch", "custom-enterprise")).toBe("lateral");
  });
});
