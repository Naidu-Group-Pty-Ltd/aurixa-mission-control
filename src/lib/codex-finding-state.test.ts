import { describe, expect, it } from "vitest";
import {
  canAutoResolve,
  carryForwardState,
  countOpenBySeverity,
  earliestTimestamp,
  emptySeverityCounts,
  mostDecisiveState,
} from "@/lib/codex-finding-state";

describe("carryForwardState", () => {
  it("opens a finding with no history", () => {
    expect(carryForwardState(null)).toEqual({ state: "open", regression: false });
    expect(carryForwardState(undefined)).toEqual({ state: "open", regression: false });
  });

  it("preserves operator verdicts across re-scans", () => {
    // The bug this guards: a nightly scan re-reporting the same finding used
    // to reset it to `open`, undoing every dismissal an operator had made.
    expect(carryForwardState("dismissed")).toEqual({
      state: "dismissed",
      regression: false,
    });
    expect(carryForwardState("false_positive")).toEqual({
      state: "false_positive",
      regression: false,
    });
  });

  it("flags a resolved finding that came back as a regression", () => {
    expect(carryForwardState("resolved")).toEqual({ state: "open", regression: true });
  });

  it("preserves in-flight triage and remediation states", () => {
    // Re-reporting a finding that already has a draft fix PR must not throw
    // away the link back to that remediation by resetting it to `open`.
    for (const state of ["triaging", "fix_drafted", "pr_open", "fix_merged"]) {
      expect(carryForwardState(state)).toEqual({ state, regression: false });
    }
  });

  it("only ever reopens a finding that was previously resolved", () => {
    const reopened = ["resolved"];
    for (const state of [
      "triaging",
      "fix_drafted",
      "pr_open",
      "fix_merged",
      "dismissed",
      "false_positive",
    ]) {
      expect(reopened).not.toContain(state);
      expect(carryForwardState(state).state).toBe(state);
    }
  });
});

describe("mostDecisiveState", () => {
  it("is order-independent", () => {
    // History rows arrive in arbitrary order; the merged verdict must not
    // depend on which row the database happened to return first.
    expect(mostDecisiveState("dismissed", "resolved")).toBe("dismissed");
    expect(mostDecisiveState("resolved", "dismissed")).toBe("dismissed");
    expect(mostDecisiveState("open", "pr_open")).toBe("pr_open");
    expect(mostDecisiveState("pr_open", "open")).toBe("pr_open");
  });

  it("ranks operator verdicts above remediation progress above defaults", () => {
    expect(mostDecisiveState("false_positive", "fix_merged")).toBe("false_positive");
    expect(mostDecisiveState("fix_merged", "triaging")).toBe("fix_merged");
    expect(mostDecisiveState("triaging", "open")).toBe("triaging");
    expect(mostDecisiveState("open", "resolved")).toBe("open");
  });

  it("tolerates missing values and unknown states", () => {
    expect(mostDecisiveState(null, "open")).toBe("open");
    expect(mostDecisiveState("open", null)).toBe("open");
    expect(mostDecisiveState(null, null)).toBeNull();
    expect(mostDecisiveState("open", "who_knows")).toBe("open");
  });
});

describe("earliestTimestamp", () => {
  it("returns the earlier of two timestamps", () => {
    expect(earliestTimestamp("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z")).toBe(
      "2026-07-01T00:00:00Z",
    );
    expect(earliestTimestamp("2026-07-03T00:00:00Z", "2026-07-02T00:00:00Z")).toBe(
      "2026-07-02T00:00:00Z",
    );
  });

  it("tolerates missing values", () => {
    expect(earliestTimestamp(null, "2026-07-02T00:00:00Z")).toBe("2026-07-02T00:00:00Z");
    expect(earliestTimestamp("2026-07-02T00:00:00Z", null)).toBe("2026-07-02T00:00:00Z");
    expect(earliestTimestamp(null, null)).toBeNull();
  });
});

describe("canAutoResolve", () => {
  it("allows full-tree scans to resolve findings they no longer report", () => {
    expect(canAutoResolve("manual")).toBe(true);
    expect(canAutoResolve("nightly_full")).toBe(true);
    expect(canAutoResolve("post_merge_revalidate")).toBe(true);
  });

  it("never lets a partial scan resolve findings outside its scope", () => {
    // A PR scan only looks at the diff; absence of a finding proves nothing
    // about the rest of the tree, so auto-resolving here would wipe the
    // entire backlog on every pull request.
    expect(canAutoResolve("pr_open")).toBe(false);
    expect(canAutoResolve("targeted_path")).toBe(false);
    expect(canAutoResolve("something_new")).toBe(false);
  });
});

describe("countOpenBySeverity", () => {
  it("counts only open findings", () => {
    const counts = countOpenBySeverity([
      { severity: "critical", state: "open" },
      { severity: "critical", state: "dismissed" },
      { severity: "high", state: "open" },
      { severity: "high", state: "open" },
      { severity: "low", state: "resolved" },
    ]);
    expect(counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0, info: 0 });
  });

  it("ignores unknown severities instead of inventing buckets", () => {
    const counts = countOpenBySeverity([
      { severity: "catastrophic", state: "open" },
      { severity: null, state: "open" },
    ]);
    expect(counts).toEqual(emptySeverityCounts());
  });

  it("returns zeroes for an empty scan", () => {
    expect(countOpenBySeverity([])).toEqual(emptySeverityCounts());
  });
});
