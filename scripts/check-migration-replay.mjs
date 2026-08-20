#!/usr/bin/env node
// Keep the migration corpus replayable from an empty database.
//
// This is not hygiene. `applyPrimeMigrations` (backend-provisioning.server.ts)
// replays this corpus onto every clone backend Mission Control provisions, in
// filename order, and HALTS on the first failure — "schema state beyond this
// point is undefined". So one migration that cannot run twice, or that collides
// with an earlier one, silently truncates every clone's schema from that point
// on. Measured: the corpus halted at migration 69 of 192, and a freshly
// provisioned clone received 75 of 153 tables. Nothing reported it, because a
// halted replay looks exactly like a completed one from outside.
//
// Postgres gives `CREATE POLICY` and `CREATE TRIGGER` no `IF NOT EXISTS`, so
// they are the two statements that cannot be written idempotently by accident.
// Everything else in this corpus (TABLE, INDEX, TYPE, FUNCTION) either has the
// clause or uses OR REPLACE. That makes this check complete for the class, not
// a sample of it.
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
  console.error("applyPrimeMigrations replays this corpus onto every clone backend and");
  console.error("halts on the first failure, so a collision here truncates the schema of");
  console.error("every clone provisioned after it — with no error anywhere.\n");
  process.exit(1);
}

console.log(`check:migration-replay — ${files.length} migrations, no re-creation collisions`);
