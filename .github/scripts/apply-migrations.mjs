/**
 * Applies the migration files a merge ADDED, through the Supabase Management API.
 *
 * ## Why this is not `supabase db push`
 *
 * `supabase_migrations.schema_migrations` in this project does not describe
 * what has been applied, and cannot be made to. Measured on 2026-08-27 against
 * 207 files in `supabase/migrations/`:
 *
 *     35   exact version match in the ledger
 *     105  a ledger row 2-5 seconds off the filename
 *     67   no ledger row within two minutes
 *
 * The 105 are the tell. This project is edited in Lovable as well as in git,
 * and Lovable records a migration under the timestamp at which IT applied the
 * file, not the timestamp in the filename. So the ledger and the repository are
 * two different namespaces describing the same history, and no version-matching
 * reconciliation can join them.
 *
 * The remaining 67 are hand-authored files with round timestamps
 * (`20260609120000`). Some are applied — by an operator running the SQL
 * directly — and some are not, and nothing in the database distinguishes those
 * two cases.
 *
 * `db push` trusts that ledger. Pointed here it would replay ~172 files,
 * including `cron.schedule` calls and seed INSERTs where a second application
 * is not a no-op. So this never asks "what is pending". It asks git "what did
 * this push add", which is a question with an exact answer.
 *
 * ## What it will not do
 *
 * Only files ADDED by the push. A MODIFIED migration is not re-applied: editing
 * an applied migration is a mistake, and running the new text over a database
 * that already has the old one is how you get a schema nobody can reproduce.
 * The pipeline reports it and leaves it alone.
 *
 * A file whose version is already in the ledger is skipped, so a re-run of the
 * same push is a no-op.
 *
 * ## Identity is verified, not configured
 *
 * The Management API token can reach every project in the organisation — this
 * one, the prime product's, and every clone. A wrong `PROJECT_REF` here does
 * not fail; it applies Mission Control's admin schema to somebody's tenant.
 *
 * So the ref is checked twice, and the second check is behavioural. Before any
 * migration is sent, the target is asked whether it holds `clones`,
 * `prime_config` and `cascade_events` — the three tables that exist in Mission
 * Control and in neither the prime nor a clone. A project that cannot answer
 * yes to all three is refused. That is the same rule this codebase applies to
 * the purge and to provider readiness: assert by effect, never by configuration.
 */
import { readFileSync } from 'node:fs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = (process.env.PROJECT_REF || '').trim();
const FILES = (process.env.FILES || '')
  .split(/[\s,]+/)
  .map((f) => f.trim())
  .filter(Boolean);

/** Projects this must never write to, whatever the configuration says. */
const FORBIDDEN_REFS = new Map([
  ['dduzbchuswwbefdunfct', 'the PRIME product backend'],
  ['plisdzywzleljorrphxv', 'the npc-client-dashboard CLONE backend'],
]);

/**
 * Parse, verify and report without sending. The dry run exercises the same
 * selection and the same statement splitting the real run uses, rather than a
 * copy of them in a test that can drift.
 */
const DRY_RUN = process.env.DRY_RUN === '1';

const fail = (title, msg) => {
  console.error(`::error title=${title}::${msg}`);
  process.exit(1);
};

if (!DRY_RUN && !TOKEN) {
  fail('No credential', 'SUPABASE_ACCESS_TOKEN is not set. Add it in Settings → Secrets → Actions.');
}
if (!REF) {
  fail(
    'No target',
    'PROJECT_REF is empty. Set the repository variable SUPABASE_PROJECT_REF to this ' +
      "deployment's own Supabase project. There is deliberately no default: a guessed ref " +
      'would apply Mission Control’s admin schema to whichever project it happened to name.',
  );
}
if (FORBIDDEN_REFS.has(REF)) {
  fail(
    'Refusing the target',
    `PROJECT_REF is ${REF}, which is ${FORBIDDEN_REFS.get(REF)} — not Mission Control. ` +
      'Applying these migrations there would write this control plane’s admin schema over ' +
      'a product database.',
  );
}

/** Statements are sent one at a time; this is the only way in or out. */
async function run(sql, label) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would send ${label} (${Buffer.byteLength(sql)} bytes)`);
    return null;
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`::error title=${label} failed::HTTP ${res.status} — ${text.slice(0, 600)}`);
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Ask the target what it is.
 *
 * `clones`, `prime_config` and `cascade_events` are Mission Control's own
 * tables. The prime product does not have them and neither does a clone, which
 * receives the PRODUCT's schema. All three present is a fingerprint a mistyped
 * ref cannot forge.
 */
async function assertTargetIsMissionControl() {
  if (DRY_RUN) {
    console.log('  [dry-run] would verify the target holds clones/prime_config/cascade_events');
    return;
  }
  const rows = await run(
    `select to_regclass('public.clones') is not null as has_clones,
            to_regclass('public.prime_config') is not null as has_prime_config,
            to_regclass('public.cascade_events') is not null as has_cascade_events;`,
    'identify target',
  );
  const r = Array.isArray(rows) ? rows[0] : null;
  const ok = r && r.has_clones && r.has_prime_config && r.has_cascade_events;
  if (!ok) {
    fail(
      'Target is not Mission Control',
      `Project ${REF} does not hold clones/prime_config/cascade_events, so it is not this ` +
        `control plane. Nothing was applied. Saw: ${JSON.stringify(r)}`,
    );
  }
  console.log(`Target ${REF} identified as Mission Control.`);
}

/** Versions already recorded, so a re-run of the same push applies nothing. */
async function recordedVersions() {
  if (DRY_RUN) return new Set();
  const rows = await run(
    'select version from supabase_migrations.schema_migrations;',
    'read ledger',
  );
  return new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.version)));
}

const versionOf = (file) => file.match(/(\d{14})_/)?.[1] ?? null;
const nameOf = (file) => file.replace(/.*\/\d{14}_/, '').replace(/\.sql$/, '');

// ---------------------------------------------------------------- select
if (FILES.length === 0) {
  console.log('No migration files were added by this push. Nothing to apply.');
  process.exit(0);
}

const malformed = FILES.filter((f) => !versionOf(f));
if (malformed.length > 0) {
  fail(
    'Unversioned migration',
    `These files carry no 14-digit version, so they cannot be recorded and will not be ` +
      `applied: ${malformed.join(', ')}. Rename them <YYYYMMDDHHMMSS>_<name>.sql.`,
  );
}

await assertTargetIsMissionControl();
const already = await recordedVersions();

// Filename order is apply order. Two migrations added in one merge can depend
// on each other, and the timestamp is the only ordering either of them states.
const ordered = [...FILES].sort();

const applied = [];
const skipped = [];

for (const file of ordered) {
  const version = versionOf(file);
  if (already.has(version)) {
    skipped.push({ file, why: 'already in the ledger' });
    console.log(`skip ${file} — version ${version} is already recorded`);
    continue;
  }

  const sql = readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(sql);
  console.log(`\napply ${file} (${(bytes / 1024).toFixed(1)} KB)`);

  // Whole file, one statement. Migrations here are hand-sized; the prime's
  // chunker exists for a 19 MB generated catalogue seed that this repository
  // does not have. If one ever does, the API's own limit will say so loudly
  // rather than this guessing at SQL it does not parse.
  await run(sql, `apply ${file}`);

  await run(
    `insert into supabase_migrations.schema_migrations (version, name)
     select '${version}', '${nameOf(file).replace(/'/g, "''")}'
     where not exists (
       select 1 from supabase_migrations.schema_migrations where version = '${version}'
     );`,
    `record ${version}`,
  );
  applied.push({ file, version });
  console.log(`  applied and recorded ${version}`);
}

// ---------------------------------------------------------------- report
const lines = [
  `### Migrations applied to \`${REF}\``,
  '',
  applied.length
    ? applied.map((a) => `- ✅ \`${a.file}\` (recorded as ${a.version})`).join('\n')
    : '- Nothing to apply.',
];
if (skipped.length) {
  lines.push('', '**Skipped**', ...skipped.map((s) => `- \`${s.file}\` — ${s.why}`));
}
const summary = lines.join('\n');
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
