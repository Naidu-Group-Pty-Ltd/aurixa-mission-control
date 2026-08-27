import { describe, it, expect } from "vitest";
import { scopeCorpusToPrime, assertPrimeLedgerUsable } from "./fleetCorpusScope.pure";

const meta = (id: string, name = `${id}_m.sql`) => ({ id, name });

describe("scopeCorpusToPrime", () => {
  it("offers a clone only what the prime has applied", () => {
    const corpus = [meta("20250101000000"), meta("20250102000000"), meta("20250103000000")];
    const { runnable, withheld } = scopeCorpusToPrime(
      corpus,
      new Set(["20250101000000", "20250103000000"]),
    );
    expect(runnable.map((m) => m.id)).toEqual(["20250101000000", "20250103000000"]);
    expect(withheld.map((m) => m.id)).toEqual(["20250102000000"]);
  });

  it("preserves corpus order, because replay order is filename order", () => {
    const corpus = [meta("20250101000000"), meta("20250102000000"), meta("20250103000000")];
    const { runnable } = scopeCorpusToPrime(corpus, new Set(corpus.map((m) => m.id)));
    expect(runnable.map((m) => m.id)).toEqual([
      "20250101000000",
      "20250102000000",
      "20250103000000",
    ]);
  });

  it("withholds and never drops — every corpus entry lands in exactly one bucket", () => {
    const corpus = Array.from({ length: 50 }, (_, i) => meta(`2025010100${String(i).padStart(4, "0")}`));
    const applied = new Set(corpus.slice(0, 17).map((m) => m.id));
    const { runnable, withheld } = scopeCorpusToPrime(corpus, applied);
    expect(runnable.length + withheld.length).toBe(corpus.length);
    expect(new Set([...runnable, ...withheld].map((m) => m.id)).size).toBe(corpus.length);
  });

  it("an empty prime ledger withholds everything rather than passing everything", () => {
    // The direction of this failure is the whole point. Scoping that degraded
    // to "allow all" on an empty ledger would send a clone every file in the
    // tree — which is exactly the behaviour being removed.
    const corpus = [meta("20250101000000"), meta("20250102000000")];
    const { runnable, withheld } = scopeCorpusToPrime(corpus, new Set());
    expect(runnable).toEqual([]);
    expect(withheld).toHaveLength(2);
  });

  describe("the case that was measured in production", () => {
    // Named files, because this is the specific event the module exists for:
    // the sync applied two rollback_* scripts to a tenant database and put 23
    // permissive USING(true) policies on its client and financial tables.
    const ROLLBACKS = [
      meta("20250124120001", "20250124120001_rollback_client_data_rls_policies.sql"),
      meta("20250124130001", "20250124130001_rollback_financial_data_rls_policies.sql"),
    ];
    const FUTURE_DATED = meta("20260901000000", "20260901000000_aml_integration_completion.sql");
    const REAL = meta("20260820000000", "20260820000000_real_applied_migration.sql");

    // What the prime's ledger actually holds: the real one, none of the rest.
    const primeApplied = new Set([REAL.id]);

    it("withholds the rollback scripts the prime never ran", () => {
      const { runnable, withheld } = scopeCorpusToPrime(
        [...ROLLBACKS, REAL, FUTURE_DATED],
        primeApplied,
      );
      expect(runnable.map((m) => m.id)).toEqual([REAL.id]);
      expect(withheld.map((m) => m.name)).toEqual([
        "20250124120001_rollback_client_data_rls_policies.sql",
        "20250124130001_rollback_financial_data_rls_policies.sql",
        "20260901000000_aml_integration_completion.sql",
      ]);
    });

    it("withholds future-dated work the prime has not taken", () => {
      const { runnable } = scopeCorpusToPrime([FUTURE_DATED], primeApplied);
      expect(runnable).toEqual([]);
    });
  });
});

describe("assertPrimeLedgerUsable", () => {
  it("permits a run when the prime reports applied migrations", () => {
    expect(
      assertPrimeLedgerUsable({ failed: false, appliedCount: 864, primeRef: "dduzbchuswwbefdunfct" }),
    ).toBeNull();
  });

  it("refuses when the ledger read FAILED, and says a failed read is not an empty prime", () => {
    const refusal = assertPrimeLedgerUsable({
      failed: true,
      errorMessage: "503 from the Management API",
      appliedCount: 0,
      primeRef: "dduzbchuswwbefdunfct",
    });
    expect(refusal).toContain("503 from the Management API");
    expect(refusal).toMatch(/not a prime that has applied nothing/);
  });

  it("refuses an EMPTY ledger rather than treating the whole repo as runnable", () => {
    const refusal = assertPrimeLedgerUsable({
      failed: false,
      appliedCount: 0,
      primeRef: "dduzbchuswwbefdunfct",
    });
    expect(refusal).toMatch(/no applied migrations/);
    expect(refusal).toMatch(/rollback scripts/);
  });

  it("names the prime project in every refusal, so an operator knows what to look at", () => {
    for (const input of [
      { failed: true, appliedCount: 0, primeRef: "abcdefghijklmnopqrst" },
      { failed: false, appliedCount: 0, primeRef: "abcdefghijklmnopqrst" },
    ] as const) {
      expect(assertPrimeLedgerUsable(input)).toContain("abcdefghijklmnopqrst");
    }
  });

  it("a failed read is refused even when a count somehow came back non-zero", () => {
    // `failed` outranks the count: a partial result from a failed read is not
    // an authority, and trusting it would sync against a truncated ledger.
    expect(
      assertPrimeLedgerUsable({
        failed: true,
        errorMessage: "connection reset",
        appliedCount: 400,
        primeRef: "dduzbchuswwbefdunfct",
      }),
    ).toMatch(/Refusing to sync/);
  });
});
