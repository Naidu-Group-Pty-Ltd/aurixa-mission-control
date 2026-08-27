#!/usr/bin/env node
// Two ways a migration can merge and never apply, both silent.
//
// `.github/workflows/apply-migrations.yml` applies the files a push ADDED and
// records each one's 14-digit version in `supabase_migrations.schema_migrations`.
// The version is the only identity a migration has in that table, which gives
// the pipeline exactly two failure modes worth catching before merge:
//
// 1. NO VERSION. A file the version regex cannot read cannot be recorded, so
//    the workflow refuses it. Caught here instead, where the fix is a rename
//    rather than a red deploy.
//
// 2. A DUPLICATE VERSION. The recording statement is
//    `insert … where not exists (… where version = …)`, so the second file
//    carrying a version is applied and then recorded as if it were the first —
//    and on any later replay it is skipped entirely, because the version is
//    already there. Two files, one identity, and the one that loses is chosen
//    by filename sort order. Nothing anywhere reports it.
//
// Deliberately static. Whether a migration has been APPLIED is a question only
// the database can answer, and this repository's ledger cannot answer it
// honestly — see the workflow header for the measurement. This checks the
// property that has to hold for the pipeline to work at all.
import { readdirSync } from "node:fs";

const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

const unversioned = [];
const byVersion = new Map();

for (const f of files) {
  const m = /^(\d{14})_(.+)\.sql$/.exec(f);
  if (!m) {
    unversioned.push(f);
    continue;
  }
  const [, version] = m;
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(f);
}

const duplicates = [...byVersion.entries()].filter(([, fs]) => fs.length > 1);

let failed = false;

if (unversioned.length > 0) {
  failed = true;
  console.error("✖ Migration files with no 14-digit version:\n");
  for (const f of unversioned) console.error(`  • ${DIR}/${f}`);
  console.error(
    "\n  These cannot be recorded in schema_migrations, so the apply-on-merge\n" +
      "  workflow refuses them. Rename to <YYYYMMDDHHMMSS>_<name>.sql.\n",
  );
}

if (duplicates.length > 0) {
  failed = true;
  console.error("✖ Migration versions used by more than one file:\n");
  for (const [version, fs] of duplicates) {
    console.error(`  • ${version}`);
    for (const f of fs) console.error(`      ${DIR}/${f}`);
  }
  console.error(
    "\n  The ledger records a version once. The second file would apply and then\n" +
      "  be indistinguishable from the first, and a replay would skip it entirely.\n" +
      "  Give each migration its own timestamp.\n",
  );
}

if (failed) process.exit(1);

console.log(
  `check:migration-pipeline — ${files.length} migrations, every version 14 digits and unique.`,
);
