/**
 * What a clone is allowed to be sent: the prime's REPO, narrowed to what the
 * prime's own DATABASE has actually applied.
 *
 * ## Why this exists
 *
 * The fleet sync's corpus used to be every `.sql` file under
 * `supabase/migrations/` in the prime repo. That reads like the obvious
 * definition and it is the wrong one, because a repository is a record of
 * everything anyone ever wrote, not of what is true of the running system.
 * Measured on this prime: 906 distinct versions in the repo, 864 in the
 * database's ledger. The 42-version gap is not drift to be closed — it is
 * files the prime deliberately never ran.
 *
 * Pushing that gap at a clone does not bring the clone level with the prime.
 * It takes the clone PAST the prime, into states no one has ever run in
 * production, one tenant database at a time and with nobody watching.
 *
 * ## What it cost, measured
 *
 * The first run that got far enough to try reached
 * `20250124120001_rollback_client_data_rls_policies.sql` and
 * `20250124130001_rollback_financial_data_rls_policies.sql` — two files whose
 * stated purpose is to UNDO a security fix — and applied both. 23 permissive
 * `USING (true) WITH CHECK (true)` policies, every one granted to `public`,
 * appeared on a tenant's client and financial tables: `client_files`,
 * `client_notes`, `cash_flow_analyses`, `portfolio_reviews` and six more. The
 * prime has none of them. Nothing was exposed only because that clone happens
 * to hold no rows yet.
 *
 * Those two files even carry a header asserting they are "harmless in practice
 * — clone backends are built by catalog introspection and have this version
 * stamped in their ledger, so it is never replayed". That was an assumption
 * about a caller, written in the callee, and it stopped being true the moment
 * a clone was stamped from the prime's ledger rather than from the repo. A
 * migration must be safe to replay or unreachable by construction; a comment
 * predicting that nobody will call it is neither.
 *
 * ## The rule
 *
 * **A clone never runs a migration the prime itself has not run.** The prime's
 * ledger is the authority on what the product's schema IS; the repo is the
 * authority on what each version SAYS. A version needs both to reach a tenant.
 *
 * This also disposes, without naming them one by one, of the 52 future-dated
 * files, the two rollback scripts, and anything a contributor leaves in the
 * tree that production never took.
 */

export type CorpusMeta = { id: string; name: string };

export type CorpusScope<T extends CorpusMeta> = {
  /** Versions the prime has applied — the only ones a clone may be sent. */
  runnable: T[];
  /**
   * In the repo, absent from the prime's ledger. Counted and named rather than
   * quietly filtered: "962 files, 4 applied" with no account of the other 958
   * is the shape of report that hides exactly this class of defect.
   */
  withheld: T[];
};

export function scopeCorpusToPrime<T extends CorpusMeta>(
  metas: readonly T[],
  primeApplied: ReadonlySet<string>,
): CorpusScope<T> {
  const runnable: T[] = [];
  const withheld: T[] = [];
  for (const m of metas) {
    if (primeApplied.has(m.id)) runnable.push(m);
    else withheld.push(m);
  }
  return { runnable, withheld };
}

/**
 * Is the prime's ledger usable as an authority at all?
 *
 * Returns the operator-facing refusal, or null when the run may proceed.
 *
 * Both refusals exist because the fallback is catastrophic in the same
 * direction. If a failed or empty read degraded to "use the whole repo", then
 * a transient fault on the prime would be indistinguishable from a prime that
 * has applied nothing — and both would answer by sending a clone every file in
 * the tree, which is the exact behaviour this module was written to stop. A
 * fleet sync that does nothing this tick costs half an hour. One that runs a
 * rollback script against a tenant costs a great deal more.
 */
export function assertPrimeLedgerUsable(input: {
  failed: boolean;
  errorMessage?: string | null;
  appliedCount: number;
  primeRef: string;
}): string | null {
  if (input.failed) {
    return (
      `Could not read the prime backend's migration ledger (${input.primeRef}): ` +
      `${input.errorMessage ?? "unknown error"}. Refusing to sync — a ledger that could ` +
      "not be read is not a prime that has applied nothing, and the fallback would be to " +
      "send clones every file in the repo."
    );
  }
  if (input.appliedCount === 0) {
    return (
      `The prime backend (${input.primeRef}) reports no applied migrations. Refusing to ` +
      "sync: with no authority for what the prime has actually run, every repo file — " +
      "including rollback scripts and future-dated work — would qualify to run on a tenant."
    );
  }
  return null;
}
