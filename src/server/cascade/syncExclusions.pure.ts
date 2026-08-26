/**
 * What a cascade is NOT allowed to write into a clone.
 *
 * ## Why this exists
 *
 * The cascade engine copies files out of prime and commits them into a clone.
 * Until now it only ever touched files matching the globs of the modules
 * installed on that clone, so "which files must it leave alone" never had to be
 * answered — a clone simply did not install a module it wanted to diverge on.
 *
 * A MIRROR clone breaks that. `npc-client-dashboard` is the whole prime
 * application with one build flag flipped, so its scope is the entire tree, and
 * inside that tree are a handful of files whose whole purpose is to be
 * different. The worst of them is `src/integrations/supabase/env.ts`: it names
 * the Supabase project this deployment talks to, and its own header records
 * what happened the last time it resolved to prime's — the deployed client
 * dashboard served the PRIME's production database, and signing in there
 * authenticated against real staff accounts.
 *
 * So the rule this module exists for is not stylistic:
 *
 *   **A clone's identity is not a file the cascade owns.**
 *
 * A cascade that overwrites `env.ts` does not fail. It succeeds, reports green,
 * redeploys the clone, and points a customer's dashboard at another tenant's
 * data. Nothing downstream of the commit can tell that apart from a correct
 * sync, which is exactly why the decision has to be made here, before the blob
 * is written, from a list an operator can read.
 *
 * ## Two reasons, both excluded, only one silent
 *
 * `protected` — the clone owns this file outright. Config, identity, the
 * fail-closed workflow guards. Prime's version is never interesting and the
 * divergence is permanent, so a difference is not news.
 *
 * `manual_reconcile` — the clone's version is a deliberate SUPERSET of prime's
 * (`App.tsx` carries the route gates, `clientFacing.ts` hides 46 paths where
 * prime hides 24). Taking prime's version would revert real work; skipping it
 * silently means the clone never learns about a new route. So these are held
 * back from the commit AND named in the pull request, because the failure mode
 * of the quiet version is slow and invisible.
 *
 * ## Fail closed
 *
 * An exclusion set that could not be READ is not an empty exclusion set. If the
 * policy query fails, `partitionCascadePaths` must not be called with `[]` —
 * callers use `requireExclusions`, which throws. The cascade failing loudly is
 * recoverable; a cascade that ran without its guard rails is not.
 *
 * Client-safe: no imports beyond the shared glob compiler, so the operator UI
 * can render the same partition the engine will perform.
 */
import { globToRegex, isSafeRepoPath } from "@/lib/module-globs";

export type ExclusionReason = "protected" | "manual_reconcile";

export type SyncExclusion = {
  pattern: string;
  reason: ExclusionReason;
  note?: string | null;
};

export type HeldPath = {
  path: string;
  pattern: string;
  reason: ExclusionReason;
  note: string | null;
};

export type CascadePartition = {
  /** Paths the cascade may write. */
  write: string[];
  /** Paths withheld, with the rule that withheld each one. */
  held: HeldPath[];
};

export class MissingExclusionPolicyError extends Error {
  constructor(cloneId: string, cause: string) {
    super(
      `Refusing to cascade into clone ${cloneId}: its sync exclusion policy could not be read (${cause}). ` +
        `An unreadable policy is not an empty policy.`,
    );
    this.name = "MissingExclusionPolicyError";
  }
}

/**
 * Fail-closed accessor. `rows` is what the database returned; `error` is
 * whatever it returned alongside. A read that FAILED and a clone that
 * genuinely has no exclusions are different states and only one of them is
 * safe to cascade under.
 *
 * An empty list is allowed — a module-scoped clone legitimately has none — but
 * it has to be an empty list that was actually read.
 */
export function requireExclusions(
  cloneId: string,
  rows: SyncExclusion[] | null | undefined,
  error?: { message: string } | null,
): SyncExclusion[] {
  if (error) throw new MissingExclusionPolicyError(cloneId, error.message);
  if (rows == null) throw new MissingExclusionPolicyError(cloneId, "no rows returned");
  return rows;
}

/**
 * A mirror with no exclusions at all is a configuration accident, not a policy.
 *
 * An empty set is perfectly legitimate for a module-scoped clone — it receives
 * only the globs of what it installed, and nothing it installed is contested.
 * A MIRROR receives the whole tree, so an empty set means "overwrite
 * everything", identity included. That state is reachable by ordinary means:
 * register a mirror and forget to seed it, or delete the rows while tidying.
 *
 * There is no safe default to fall back to, because the right set is a property
 * of the clone. So this refuses, and the refusal names the fix.
 */
export function assertMirrorPolicy(cloneId: string, exclusions: readonly SyncExclusion[]): void {
  if (exclusions.length === 0) {
    throw new MissingExclusionPolicyError(
      cloneId,
      "sync_scope is 'mirror' but clone_sync_exclusions is empty — a whole-tree cascade with no " +
        "exclusions would overwrite this clone's backend identity. Seed it from " +
        "DEFAULT_MIRROR_EXCLUSIONS before cascading",
    );
  }
}

/**
 * Split the paths a cascade would write into those it may write and those it
 * must not, against one clone's exclusion patterns.
 *
 * A path matching several patterns is attributed to the FIRST match in the
 * given order, and `protected` is checked before `manual_reconcile` so a path
 * covered by both reports as the stronger of the two.
 *
 * A path that is not a safe repo path is withheld regardless of the patterns.
 * `listTreeEntries` already filters those out; this is the second line, in the
 * place that decides what gets committed.
 */
export function partitionCascadePaths(
  candidates: readonly string[],
  exclusions: readonly SyncExclusion[],
): CascadePartition {
  const ordered = [
    ...exclusions.filter((e) => e.reason === "protected"),
    ...exclusions.filter((e) => e.reason !== "protected"),
  ];
  const compiled = ordered.map((e) => ({ ...e, rx: globToRegex(e.pattern) }));

  const write: string[] = [];
  const held: HeldPath[] = [];

  for (const path of candidates) {
    if (!isSafeRepoPath(path)) {
      held.push({
        path,
        pattern: "(unsafe path)",
        reason: "protected",
        note: "Refused by isSafeRepoPath",
      });
      continue;
    }
    const hit = compiled.find((e) => e.rx.test(path));
    if (hit) {
      held.push({
        path,
        pattern: hit.pattern,
        reason: hit.reason,
        note: hit.note ?? null,
      });
      continue;
    }
    write.push(path);
  }

  return { write, held };
}

/** The held paths worth telling a human about — see the header. */
export function reportableHeld(held: readonly HeldPath[]): HeldPath[] {
  return held.filter((h) => h.reason === "manual_reconcile");
}

/**
 * The exclusion set a client-facing mirror of this prime needs on day one.
 *
 * Not invented here. Every entry is a divergence that already exists between
 * `npc-property-dashbord` and `npc-client-dashboard` and is written down in the
 * clone's own `docs/CLIENT_FACING_MODE.md` — this is that table, in the one
 * place the cascade can enforce it.
 *
 * Seeded when a mirror is registered, and editable afterwards: it is a starting
 * policy, not a constant. What must not happen is a mirror registered with NO
 * policy, which is why registration seeds and `requireExclusions` refuses to
 * treat an unreadable set as an empty one.
 */
export const DEFAULT_MIRROR_EXCLUSIONS: readonly SyncExclusion[] = [
  // ── Identity. The reason this whole module exists. ────────────────────────
  {
    pattern: "src/integrations/supabase/env.ts",
    reason: "protected",
    note: "Names the Supabase project this deployment talks to. Prime's version points at prime's database.",
  },
  {
    pattern: "supabase/config.toml",
    reason: "protected",
    note: "Carries the clone's own project ref and per-function verify_jwt declarations.",
  },
  {
    pattern: "supabase/.temp/**",
    reason: "protected",
    note: "Tracked upstream and holds the prime's project ref; backendIsolation.spec.ts asserts it stays untracked here.",
  },
  // ── Build and deploy configuration ────────────────────────────────────────
  {
    pattern: "vite.config.ts",
    reason: "protected",
    note: "Pins VITE_CLIENT_FACING and defines __CLIENT_FACING__ for this repository.",
  },
  { pattern: "vercel.json", reason: "protected", note: "This deployment's hosting config." },
  { pattern: ".env.example", reason: "protected", note: "Documents the clone's own variables." },
  { pattern: ".gitignore", reason: "protected", note: "Keeps supabase/.temp untracked here." },
  {
    pattern: ".github/workflows/deploy-supabase-functions.yml",
    reason: "protected",
    note: "Fail-closed guard against deploying into the wrong project.",
  },
  {
    pattern: ".github/workflows/apply-migration.yml",
    reason: "protected",
    note: "Fail-closed guard against applying migrations to the wrong project.",
  },
  {
    pattern: "docs/CLIENT_FACING_MODE.md",
    reason: "protected",
    note: "Describes this repository, not prime.",
  },
  // ── Deliberate supersets: withheld, and reported every time ───────────────
  {
    pattern: "src/App.tsx",
    reason: "manual_reconcile",
    note: "Clone carries RouteExcludedFromBuild and __CLIENT_FACING__ gates prime does not. New upstream routes have to be brought across by hand.",
  },
  {
    pattern: "src/lib/clientFacing.ts",
    reason: "manual_reconcile",
    note: "Clone hides a strict superset of prime's paths.",
  },
  {
    pattern: "src/lib/__tests__/clientFacing.test.ts",
    reason: "manual_reconcile",
    note: "Asserts the clone's hiding decisions, which contradict prime's.",
  },
  {
    pattern: "src/components/call-logs/CleanupTestCalls.tsx",
    reason: "manual_reconcile",
    note: "Clone reads VITE_TEST_CALL_NUMBERS instead of hardcoding staff mobiles.",
  },
];
