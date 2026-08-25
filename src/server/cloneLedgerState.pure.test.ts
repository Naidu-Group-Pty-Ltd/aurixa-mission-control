import { describe, it, expect } from "vitest";
import { assessLedgerState, ledgerRepairHint } from "./cloneLedgerState.pure";

const corpus = ["20250101000000", "20250102000000", "20250103000000"];

describe("assessLedgerState", () => {
  it("calls an empty project with an empty ledger fresh, so replay proceeds", () => {
    expect(
      assessLedgerState({ appliedVersions: [], corpusVersions: corpus, cloneTableCount: 0 }),
    ).toEqual({ state: "fresh" });
  });

  it("calls a populated schema with an empty ledger unstamped", () => {
    const a = assessLedgerState({
      appliedVersions: [],
      corpusVersions: corpus,
      cloneTableCount: 533,
    });
    expect(a.state).toBe("unstamped");
  });

  it("accepts a clone that is merely behind", () => {
    expect(
      assessLedgerState({
        appliedVersions: ["20250101000000"],
        corpusVersions: corpus,
        cloneTableCount: 533,
      }),
    ).toEqual({ state: "ok" });
  });

  it("accepts a clone at the corpus head", () => {
    expect(
      assessLedgerState({
        appliedVersions: corpus,
        corpusVersions: corpus,
        cloneTableCount: 533,
      }),
    ).toEqual({ state: "ok" });
  });

  it("calls a ledger disjoint from the corpus foreign — stamped from the wrong project", () => {
    // The exact shape the SUPABASE_URL defect produced: a clone stamped with
    // Mission Control's own migration IDs, which no product migration matches.
    const a = assessLedgerState({
      appliedVersions: ["20260813133839", "20260814090000"],
      corpusVersions: corpus,
      cloneTableCount: 533,
    });
    expect(a.state).toBe("foreign");
  });

  it("treats a single shared version as an honest ledger, not a foreign one", () => {
    // Partial overlap is what "behind" looks like; only zero overlap is wrong.
    expect(
      assessLedgerState({
        appliedVersions: ["20250103000000", "19990101000000"],
        corpusVersions: corpus,
        cloneTableCount: 533,
      }),
    ).toEqual({ state: "ok" });
  });

  it("does not judge a ledger foreign when the corpus is empty", () => {
    expect(
      assessLedgerState({
        appliedVersions: ["20250101000000"],
        corpusVersions: [],
        cloneTableCount: 533,
      }),
    ).toEqual({ state: "ok" });
  });
});

describe("ledgerRepairHint", () => {
  it("names the repair for a blocked state and stays silent for a healthy one", () => {
    const unstamped = assessLedgerState({
      appliedVersions: [],
      corpusVersions: corpus,
      cloneTableCount: 533,
    });
    expect(ledgerRepairHint(unstamped)).toContain("Re-stamp ledger from prime");
    expect(ledgerRepairHint({ state: "ok" })).toBeNull();
    expect(ledgerRepairHint({ state: "fresh" })).toBeNull();
  });

  it("sends a foreign ledger to the configuration rather than to the repair alone", () => {
    const foreign = assessLedgerState({
      appliedVersions: ["20260813133839"],
      corpusVersions: corpus,
      cloneTableCount: 533,
    });
    expect(ledgerRepairHint(foreign)).toContain("prime_config.supabase_project_ref");
  });
});
