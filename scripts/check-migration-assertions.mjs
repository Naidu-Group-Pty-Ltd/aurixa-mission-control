#!/usr/bin/env node
// Every NEW migration must say what it did, in a form something can check.
//
// `supabase_migrations.schema_migrations` cannot answer "has this migration
// been applied?" on this deployment: 40 of 211 repo versions appear in it, and
// 103 ledger rows match no repo file at all. Lovable stamps its own apply
// timestamps, so the repo and the ledger are two namespaces that barely
// overlap.
//
// That leaves nothing able to tell an applied migration from an unapplied one —
// which is why 67 files sat in a documented backlog nobody could resolve, and
// why a hand-apply that gets forgotten stays forgotten. An assertion is a claim
// the database itself can be asked about, so the question becomes answerable.
//
// It also catches something no applier can: a migration that RAN and did
// nothing. This corpus contains `DO $$ … EXCEPTION WHEN OTHERS THEN NULL $$`,
// which succeeds having achieved nothing at all.
//
// The 211 files that predate this rule are frozen in
// scripts/migration-assertions-baseline.txt. They are not grandfathered
// forever — the intent is that a file gains an assertion when it is next
// touched — but requiring 211 retrofits before the rule can start is how a
// rule never starts.
//
// The grammar lives in `src/server/migrationAssertions.pure.ts` and is imported
// from there rather than re-implemented here. Node ≥22.18 strips types on
// import, so CI and the runtime drift alarm parse with the SAME code — a rule
// enforced twice from two copies is a rule that eventually disagrees with
// itself, and this repository has paid for that shape before.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let parseAssertions, hasAnyAssertion;
try {
  ({ parseAssertions, hasAnyAssertion } =
    await import("../src/server/migrationAssertions.pure.ts"));
} catch (err) {
  if (err?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    console.error(
      `\n✗ Migration assertions: this guard imports a .ts module directly, which\n` +
        `  needs Node ≥22.18 (type stripping on by default). Running ${process.version}.\n` +
        `  Upgrade Node rather than copying the parser — two copies is the bug\n` +
        `  this import exists to avoid.\n`,
    );
    process.exit(1);
  }
  throw err;
}

const MIGRATIONS = "supabase/migrations";
const BASELINE = "scripts/migration-assertions-baseline.txt";

const baseline = new Set(
  existsSync(BASELINE)
    ? readFileSync(BASELINE, "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter(Boolean)
    : [],
);

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const missing = [];
const malformed = [];
let checked = 0;
let claims = 0;

for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");

  if (!hasAnyAssertion(sql)) {
    // Baseline files may omit; new files may not.
    if (!baseline.has(file)) missing.push(file);
    continue;
  }

  // A malformed claim fails even in the baseline. Freezing "no assertion" is a
  // deliberate debt; freezing a BROKEN one would freeze something that looks
  // like coverage and checks nothing.
  const parsed = parseAssertions(sql);
  if (!parsed.ok) {
    malformed.push(`${file}\n    ${parsed.errors.join("\n    ")}`);
    continue;
  }
  checked += 1;
  claims += parsed.assertions.length;
}

// A baseline entry naming a file that no longer exists is how a frozen list
// rots into a list nobody trusts — and, worse, how a deleted-and-recreated
// migration keeps its exemption.
const stale = [...baseline].filter((f) => !files.includes(f));

const problems = [];

if (missing.length > 0) {
  problems.push(
    `${missing.length} migration(s) added without an @asserts claim:\n` +
      missing.map((f) => `  ${f}`).join("\n") +
      `\n\n  Add a leading comment saying what the migration makes true, e.g.\n` +
      `    -- @asserts table:my_new_table\n` +
      `    -- @asserts column:clone_backends.some_column\n` +
      `    -- @asserts cron:my-job-name\n` +
      `    -- @asserts rows:seeded_table>=17\n\n` +
      `  If it genuinely has no observable effect, say so in words:\n` +
      `    -- @asserts none:comment-only change, creates no object\n\n` +
      `  Do NOT add the file to ${BASELINE} — that list is frozen at the files\n` +
      `  which predate this rule, and growing it defeats the check.`,
  );
}

if (malformed.length > 0) {
  problems.push(
    `${malformed.length} migration(s) carry an @asserts line that cannot be parsed:\n` +
      malformed.map((m) => `  ${m}`).join("\n") +
      `\n\n  A claim nobody can parse looks like coverage in a listing and checks\n` +
      `  nothing at run time. Fix the syntax rather than removing the line.`,
  );
}

if (stale.length > 0) {
  problems.push(
    `${stale.length} baseline entr(y/ies) name a migration that no longer exists:\n` +
      stale.map((f) => `  ${f}`).join("\n") +
      `\n\n  Remove the line from ${BASELINE}.`,
  );
}

if (problems.length > 0) {
  console.error(`\n✗ Migration assertions\n\n${problems.join("\n\n")}\n`);
  process.exit(1);
}

console.log(
  `✓ Migration assertions: ${checked} of ${files.length} migrations carry ${claims} checkable ` +
    `claim(s); ${baseline.size} pre-rule files frozen in the baseline.`,
);
