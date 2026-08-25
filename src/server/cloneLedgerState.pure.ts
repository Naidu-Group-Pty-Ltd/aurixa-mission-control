/**
 * Is this clone's migration ledger in a state that can be synced?
 *
 * `applyPrimeMigrations` computes pending work as `corpus − ledger` and replays
 * what is left, halting on the first failure so nothing runs against a
 * half-applied schema. That is the right behaviour when the ledger is honest.
 *
 * It is the wrong behaviour when the ledger is EMPTY and the schema is NOT.
 * A clone built by catalogue introspection has every table the prime has and,
 * if the stamp did not run, no versions recorded — so the corpus is entirely
 * "pending" and the replay starts at migration #1, which fails on an object
 * that already exists. It fails identically on every retry: the clone is
 * permanently unsyncable, and the surfaced message ("migration X failed:
 * relation Y already exists") points at the migration rather than at the
 * missing ledger.
 *
 * This module names that state so the caller can refuse with the repair
 * instead of attempting the replay. It is deliberately pure — the counts come
 * from the caller, so the rule can be tested without a database.
 */

export type LedgerAssessment =
  | { state: "ok" }
  /** Nothing recorded and nothing built — a genuinely fresh project. Replay. */
  | { state: "fresh" }
  /** Schema present, ledger empty: replay would start at #1 and fail forever. */
  | { state: "unstamped"; reason: string }
  /** Ledger present but disjoint from the corpus — stamped from the wrong source. */
  | { state: "foreign"; reason: string };

export type LedgerInputs = {
  /** Versions recorded on the clone (union of both ledgers). */
  appliedVersions: readonly string[];
  /** Versions the prime corpus declares. */
  corpusVersions: readonly string[];
  /** Tables in the clone's replicated schemas. */
  cloneTableCount: number;
};

/**
 * A clone is only judged `foreign` when it has a ledger AND that ledger shares
 * nothing with the corpus. Partial overlap is normal — it is exactly what a
 * clone that is behind looks like — so overlap of even one version is treated
 * as an honest ledger rather than a wrong one.
 */
export function assessLedgerState(input: LedgerInputs): LedgerAssessment {
  const applied = new Set(input.appliedVersions);
  const corpus = new Set(input.corpusVersions);

  if (applied.size === 0) {
    if (input.cloneTableCount === 0) return { state: "fresh" };
    return {
      state: "unstamped",
      reason:
        `the clone has ${input.cloneTableCount} table(s) but no recorded migration versions, ` +
        `so replaying the ${corpus.size}-migration corpus would start at the first one and ` +
        "fail on objects that already exist",
    };
  }

  if (corpus.size > 0) {
    let overlap = 0;
    for (const v of applied) {
      if (corpus.has(v)) {
        overlap += 1;
        break;
      }
    }
    if (overlap === 0) {
      return {
        state: "foreign",
        reason:
          `the clone records ${applied.size} migration version(s), none of which appear in the ` +
          `${corpus.size}-migration prime corpus — the ledger was stamped from a different project`,
      };
    }
  }

  return { state: "ok" };
}

/** The operator-facing sentence for a state that blocks a sync. */
export function ledgerRepairHint(assessment: LedgerAssessment): string | null {
  switch (assessment.state) {
    case "unstamped":
      return (
        `Migration sync refused: ${assessment.reason}. ` +
        "Run “Re-stamp ledger from prime” on the clone's backend to record the versions its " +
        "schema already contains, then sync."
      );
    case "foreign":
      return (
        `Migration sync refused: ${assessment.reason}. ` +
        "Check prime_config.supabase_project_ref points at the prime PRODUCT's project, then " +
        "re-stamp the ledger from it."
      );
    default:
      return null;
  }
}
