#!/usr/bin/env node
// An unindexed foreign key is a sequential scan waiting to happen.
//
// Postgres indexes the *referenced* side of a foreign key automatically (it has
// to — the primary/unique key is what the constraint points at) and indexes the
// *referencing* side never. Every `... REFERENCES parent(id)` column therefore
// starts life unindexed, and stays that way until somebody notices. The cost is
// invisible while a table is small and then arrives all at once: joins from the
// child to the parent, and every `ON DELETE`/`ON UPDATE` cascade check, scan the
// whole child table.
//
// Grepping cannot answer this reliably. Foreign keys are declared four ways in
// this repository (inline column constraint, table-level constraint,
// `ALTER TABLE ... ADD CONSTRAINT`, and inside `DO $$ ... EXECUTE format(...)`
// loops), and indexes are created with any leading column order, partial `WHERE`
// clauses, or as a by-product of `UNIQUE`/`PRIMARY KEY`. So this parses the
// migrations with a real Postgres grammar and matches on structure: an FK is
// covered when some index, unique constraint, or primary key on the same table
// has the FK's columns as its LEADING columns, in order.
//
// Exceptions live in `FK_INDEX_EXEMPT` below with a reason, so a deliberate
// choice reads as one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "pgsql-ast-parser";

const MIGRATIONS = "supabase/migrations";

// key: "<table>(<col>,<col>)" — deliberately unindexed, with the reason why.
const FK_INDEX_EXEMPT = new Map([
  // e.g. ["some_table(some_col)", "single-row config table; never scanned"],
]);

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** table -> Set of "col,col" leading-column signatures that are indexed */
const indexed = new Map();
/** list of { table, cols, file } */
const foreignKeys = [];

const norm = (n) => (typeof n === "string" ? n : (n?.name ?? "")).toLowerCase();
const key = (table, cols) => `${table}(${cols.join(",")})`;

function addIndex(table, cols) {
  if (!table || cols.length === 0) return;
  const set = indexed.get(table) ?? new Set();
  // Record every leading prefix: an index on (a, b) covers an FK on (a).
  for (let i = 1; i <= cols.length; i++) set.add(cols.slice(0, i).join(","));
  indexed.set(table, set);
}

function addFk(table, cols, file) {
  if (!table || cols.length === 0) return;
  foreignKeys.push({ table, cols, file });
}

function constraintColumns(c, fallbackColumn) {
  const cols = (c.columns ?? []).map(norm).filter(Boolean);
  return cols.length ? cols : fallbackColumn ? [fallbackColumn] : [];
}

function handleConstraint(table, c, fallbackColumn, file) {
  if (!c || !c.type) return;
  if (c.type === "foreign key") addFk(table, constraintColumns(c, fallbackColumn), file);
  else if (c.type === "primary key" || c.type === "unique")
    addIndex(table, constraintColumns(c, fallbackColumn));
  else if (c.type === "reference") addFk(table, fallbackColumn ? [fallbackColumn] : [], file);
}

function handleStatement(st, file) {
  if (!st || typeof st !== "object") return;

  if (st.type === "create table") {
    const table = norm(st.name?.name ?? st.name);
    for (const col of st.columns ?? []) {
      if (col.kind === "like table") continue;
      const colName = norm(col.name);
      for (const c of col.constraints ?? []) handleConstraint(table, c, colName, file);
    }
    for (const c of st.constraints ?? []) handleConstraint(table, c, null, file);
    return;
  }

  if (st.type === "create index") {
    const table = norm(st.table?.name ?? st.table);
    const cols = (st.expressions ?? [])
      .map((e) => (e.expression?.type === "ref" ? norm(e.expression.name) : null))
      .filter(Boolean);
    // A partial index does not reliably cover the constraint's lookups, so it
    // does not count as coverage.
    if (!st.where) addIndex(table, cols);
    return;
  }

  if (st.type === "alter table") {
    const table = norm(st.table?.name ?? st.table);
    const changes = Array.isArray(st.changes) ? st.changes : st.change ? [st.change] : [];
    for (const ch of changes) {
      if (ch?.type === "add constraint") handleConstraint(table, ch.constraint, null, file);
      else if (ch?.type === "add column") {
        const colName = norm(ch.column?.name);
        for (const c of ch.column?.constraints ?? []) handleConstraint(table, c, colName, file);
      }
    }
  }
}

/**
 * Split a migration into top-level statements, respecting dollar-quoted bodies
 * (`$$ … $$`, `$tag$ … $tag$`), single quotes and comments — a naive split on
 * `;` would cut every function body in half.
 */
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const ch = sql[i];
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (buf.trim()) out.push(buf.trim() + ";");
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim() + ";");
  return out;
}

let parseFailures = 0;
for (const f of files) {
  const sql = readFileSync(join(MIGRATIONS, f), "utf8");

  // Indexes created inside a `DO $$ … EXECUTE format(...)` loop are invisible to
  // the parser. Where a migration builds them from a table/column list, it marks
  // that list so the coverage it provides is still counted here.
  for (const block of sql.matchAll(
    /--\s*fk-index-coverage:\s*begin([\s\S]*?)--\s*fk-index-coverage:\s*end/gi,
  )) {
    for (const pair of block[1].matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*\)/gi)) {
      addIndex(pair[1].toLowerCase(), [pair[2].toLowerCase()]);
    }
  }

  // Whole-file parsing fails on the first construct the grammar does not cover
  // (procedural blocks, `CREATE POLICY`, extension DDL), which would silently
  // drop every later statement in that file. So split first and parse each
  // statement on its own: an unparsable one costs only itself.
  for (const stmtSql of splitStatements(sql)) {
    let statements;
    try {
      statements = parse(stmtSql, { locationTracking: false });
    } catch {
      parseFailures++;
      continue;
    }
    for (const st of statements) handleStatement(st, f);
  }
}

const missing = [];
for (const fk of foreignKeys) {
  const sig = fk.cols.join(",");
  if (indexed.get(fk.table)?.has(sig)) continue;
  if (FK_INDEX_EXEMPT.has(key(fk.table, fk.cols))) continue;
  missing.push(fk);
}

// Deduplicate: the same FK is often restated across migrations.
const unique = new Map();
for (const m of missing) unique.set(key(m.table, m.cols), m);

console.log(
  `check:fk-indexes — ${files.length} migrations (${parseFailures} unparsed), ` +
    `${foreignKeys.length} foreign keys, ${unique.size} without a covering index`,
);

if (unique.size > 0) {
  console.error("\nForeign keys with no covering index on the referencing side:\n");
  for (const [k, m] of unique) {
    console.error(`  ${k}   (declared in ${m.file})`);
    console.error(
      `    fix: CREATE INDEX IF NOT EXISTS idx_${m.table}_${m.cols.join("_")} ` +
        `ON public.${m.table} (${m.cols.join(", ")});`,
    );
  }
  console.error(
    "\nAdd the index in a migration, or add an entry to FK_INDEX_EXEMPT in " +
      "scripts/check-fk-indexes.mjs with the reason it is safe.\n",
  );
  process.exit(1);
}
