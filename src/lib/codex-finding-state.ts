// Pure state-transition rules for Codex findings across repeated scans.
//
// Extracted from the webhook handler so the rules can be unit tested without
// a database: getting these wrong is silently destructive (an operator's
// dismissal being undone every night, or a regression being filed as a
// brand-new finding with its history lost).

export type FindingState =
  | "open"
  | "triaging"
  | "fix_drafted"
  | "pr_open"
  | "fix_merged"
  | "resolved"
  | "dismissed"
  | "false_positive";

/**
 * States a re-scan must not overwrite: operator verdicts (`dismissed`,
 * `false_positive`, `triaging`) and remediation lifecycle (`fix_drafted`,
 * `pr_open`, `fix_merged`). Re-reporting the same finding is evidence it
 * still exists in the code — which every one of these states already
 * assumes — so downgrading them to `open` only destroys information.
 */
const STICKY_STATES: ReadonlySet<string> = new Set([
  "dismissed",
  "false_positive",
  "triaging",
  "fix_drafted",
  "pr_open",
  "fix_merged",
]);

export type CarryForward = {
  /** State the freshly reported finding should be stored with. */
  state: FindingState;
  /** True when a previously resolved finding has come back. */
  regression: boolean;
};

/**
 * Decide the state for a finding that a scan just reported, given whatever
 * the same fingerprint resolved to previously.
 *
 *  - no history                      → `open`
 *  - resolved                        → `open`, flagged as a regression
 *  - any other recorded state        → preserved as-is
 */
export function carryForwardState(previousState?: string | null): CarryForward {
  if (!previousState) return { state: "open", regression: false };
  if (STICKY_STATES.has(previousState)) {
    return { state: previousState as FindingState, regression: false };
  }
  return { state: "open", regression: previousState === "resolved" };
}

// Lower number wins when the same fingerprint has several historical rows.
// Deliberate verdicts outrank remediation progress, which outranks the
// default states — so the merge is order-independent.
const STATE_PRECEDENCE: Record<string, number> = {
  dismissed: 0,
  false_positive: 0,
  fix_merged: 1,
  pr_open: 2,
  fix_drafted: 3,
  triaging: 4,
  open: 5,
  resolved: 6,
};

/**
 * Pick the state that should represent a fingerprint when history holds
 * more than one row for it (e.g. the same issue seen by several past scans).
 */
export function mostDecisiveState(
  a?: string | null,
  b?: string | null,
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const rankA = STATE_PRECEDENCE[a] ?? 99;
  const rankB = STATE_PRECEDENCE[b] ?? 99;
  return rankA <= rankB ? a : b;
}

/**
 * Earliest of two ISO timestamps, tolerating nulls. Keeps `first_seen_at`
 * meaning "first ever seen" rather than "first seen by this scan".
 */
export function earliestTimestamp(
  a?: string | null,
  b?: string | null,
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

/** Scan kinds that cover the whole tree and may therefore auto-resolve. */
export const FULL_TREE_KINDS: ReadonlySet<string> = new Set([
  "manual",
  "nightly_full",
  "post_merge_revalidate",
]);

/**
 * Whether a scan of this kind is allowed to resolve findings it did not
 * report. Partial scans (`pr_open`, `targeted_path`) only look at a slice of
 * the tree, so the absence of a finding proves nothing about it.
 */
export function canAutoResolve(scanKind: string): boolean {
  return FULL_TREE_KINDS.has(scanKind);
}

export type SeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

/**
 * Count open findings by severity. Deliberately computed from what was
 * actually persisted rather than from the scanner's self-reported summary,
 * which does not know about carried-forward dismissals.
 */
export function countOpenBySeverity(
  findings: Array<{ severity?: string | null; state?: string | null }>,
): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const f of findings) {
    if (f.state !== "open") continue;
    const severity = f.severity as keyof SeverityCounts | undefined;
    if (severity && severity in counts) counts[severity] += 1;
  }
  return counts;
}
