#!/usr/bin/env node
// Keep this repository's migration corpus replayable from an empty database.
//
// WHAT THIS PROTECTS, precisely — an earlier version of this comment got it
// wrong and the correction is the useful part.
//
// It does NOT protect clone backends. `applyPrimeMigrations` replays the
// migrations of the repo named in `prime_config` — the prime PRODUCT repo,
// fetched over the GitHub API by `fetchPrimeMigrations` — and never reads
// `supabase/migrations/` from this repository at all. Clone backends receive a
// different corpus entirely, and this check says nothing about it.
//
// What it protects is Mission Control's OWN database, in the one situation
// that matters: rebuilding it. `supabase db reset`, standing up a staging
// copy, restoring after a loss, or any tooling that replays from zero. That
// path was broken — executed against a real PostgreSQL 16 from empty, the
// corpus halted at migration 69 of 192 and produced 75 tables instead of 153.
// It had been in that state since 2026-07-10 and nothing reported it, because
// the live database was built incrementally by applying each migration as it
// was written; a corpus that cannot replay looks identical from there.
//
// Postgres gives `CREATE POLICY` and `CREATE TRIGGER` no `IF NOT EXISTS`, so
// they are the two statements here that cannot be written idempotently by
// accident. Everything else in this corpus (TABLE, INDEX, TYPE, FUNCTION)
// either has the clause or uses OR REPLACE. That makes this check complete for
// the class rather than a sample of it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

const RULES = [
  {
    what: "policy",
    create: /\bcreate\s+policy\s+("(?:[^"]+)"|[A-Za-z_]\w*)\s+on\s+([\w."]+)/gis,
    drop: /\bdrop\s+policy\s+if\s+exists\s+("(?:[^"]+)"|[A-Za-z_]\w*)\s+on\s+([\w."]+)/gis,
    fix: 'DROP POLICY IF EXISTS "<name>" ON <table>;',
  },
  {
    what: "trigger",
    create: /\bcreate\s+trigger\s+([A-Za-z_]\w*)\s+[\s\S]*?\bon\s+([\w."]+)/gis,
    drop: /\bdrop\s+trigger\s+if\s+exists\s+([A-Za-z_]\w*)\s+on\s+([\w."]+)/gis,
    fix: "DROP TRIGGER IF EXISTS <name> ON <table>;",
  },
];

const clean = (s) => s.replace(/"/g, "").trim();
const findings = [];

for (const rule of RULES) {
  const creators = new Map(); // "name|table" -> [file, …]
  const guards = new Map(); // file -> Set("name|table")

  for (const file of files) {
    const sql = readFileSync(join(DIR, file), "utf8");
    const g = new Set();
    for (const m of sql.matchAll(rule.drop)) g.add(`${clean(m[1])}|${clean(m[2])}`);
    guards.set(file, g);
    for (const m of sql.matchAll(rule.create)) {
      const key = `${clean(m[1])}|${clean(m[2])}`;
      if (!creators.has(key)) creators.set(key, []);
      creators.get(key).push(file);
    }
  }

  for (const [key, list] of creators) {
    if (list.length < 2) continue;
    // The first creator is fine on an empty database; every later one has to
    // clear the name first or the replay stops there.
    for (const file of list.slice(1)) {
      if (guards.get(file).has(key)) continue;
      const [name, table] = key.split("|");
      findings.push({
        file,
        what: rule.what,
        name,
        table,
        firstIn: list[0],
        fix: rule.fix.replace("<name>", name).replace("<table>", table),
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Migration corpus is not replayable — these halt a fresh apply:\n");
  for (const f of findings) {
    console.error(`  ${DIR}/${f.file}`);
    console.error(`    re-creates ${f.what} "${f.name}" on ${f.table}`);
    console.error(`    first created in ${f.firstIn}`);
    console.error(`    add before it:  ${f.fix}\n`);
  }
  console.error("A replay halts on the first failure, so a collision here truncates every");
  console.error("rebuild of this database from that point on — `supabase db reset`, a");
  console.error("staging copy, a restore. The live database is built incrementally and");
  console.error("looks fine regardless, which is why this needs a check rather than a\n" +
                "runtime signal.\n");
  process.exit(1);
}

console.log(`check:migration-replay — ${files.length} migrations, no re-creation collisions`);
