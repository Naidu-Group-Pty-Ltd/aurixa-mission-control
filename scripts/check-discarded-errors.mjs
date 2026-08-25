#!/usr/bin/env node
// A ratchet on Supabase writes whose error nobody looks at.
//
// `supabase.from(...).insert(...)` does not throw. It resolves to
// `{ data, error }`, and a call written as a bare statement — or with a
// `.catch(() => {})`, or preceded by `void` — succeeds from the caller's point
// of view no matter what the database said. The failure mode this produces is
// specific and nasty: the row is simply not there, later, with no log line and
// nothing to grep. Audit entries and operator notifications are where it hurts
// most, because the missing row IS the record that something happened.
//
// The repository has helpers for exactly this — `writeAuditLog()` and
// `notifyOperators()` in `src/server/audit.server.ts` — which branch on `error`
// and log. This script counts the remaining unchecked write sites per file and
// holds them to a budget that may only shrink.
//
// It flags a write when the statement:
//   * calls `.insert(`, `.upsert(`, `.update(`, or `.delete(` on a Supabase
//     query chain, AND
//   * its result is discarded: the expression is a statement on its own, is
//     prefixed with `void`, or ends in `.catch(...)` / `.then(...)` with no
//     `error` reference in the surrounding statement.
//
// It does NOT flag a write whose statement text mentions `error` (destructured
// or otherwise), because that is the shape we want.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUDGET = "scripts/discarded-errors-budget.txt";
const ROOT = "src";
const WRITE = /\.(insert|upsert|update|delete)\s*\(/;

function statementsOf(source) {
  // Rough statement segmentation: good enough to decide whether the awaited
  // call's result was bound to anything. Comments are stripped first so a
  // commented-out example never counts.
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1);
  return cleaned.split("\n");
}

function countFile(source) {
  const lines = statementsOf(source);
  let count = 0;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!WRITE.test(line)) continue;
    if (
      !/\bfrom\s*\(|supabase|supabaseAdmin/.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n"))
    )
      continue;

    // Window covering the whole statement: back to the start of the chain and
    // forward to the first line that closes it.
    const start = Math.max(0, i - 4);
    let end = i;
    let depth = 0;
    for (let j = i; j < Math.min(lines.length, i + 12); j++) {
      depth += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length;
      end = j;
      if (depth <= 0 && /[;)]\s*$/.test(lines[j].trim())) break;
    }
    const stmt = lines.slice(start, end + 1).join("\n");

    // Checked shapes: destructured/inspected error, or routed through a helper
    // that checks for us.
    if (/\berror\b/.test(stmt)) continue;
    if (/writeAuditLog|notifyOperators|throwOnError\s*\(/.test(stmt)) continue;
    // Bound to a variable that some later code can inspect.
    if (/(const|let|var)\s+[\w{[][^=]*=\s*(await\s+)?[^=]*$/.test(lines[start])) continue;
    if (/return\s+/.test(stmt)) continue;

    count++;
    hits.push(`${i + 1}: ${lines[i].trim().slice(0, 120)}`);
  }
  return { count, hits };
}

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(e.name) && e.name !== "routeTree.gen.ts") files.push(full);
  }
};
walk(ROOT);

const current = new Map();
for (const f of files) {
  const { count } = countFile(readFileSync(f, "utf8"));
  if (count > 0) current.set(f.replace(/\\/g, "/"), count);
}

const budget = new Map();
try {
  for (const line of readFileSync(BUDGET, "utf8").split("\n")) {
    const m = /^(\S+)\s+(\d+)\s*$/.exec(line.trim());
    if (m) budget.set(m[1], Number(m[2]));
  }
} catch {
  // First run: write the budget and pass, so the ratchet starts from today.
  const out = [...current.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([f, n]) => `${f} ${n}`)
    .join("\n");
  writeFileSync(BUDGET, `${out}\n`);
  console.log(`check:discarded-errors — seeded ${BUDGET} with ${current.size} files`);
  process.exit(0);
}

const failures = [];
for (const [f, n] of current) {
  const allowed = budget.get(f);
  if (allowed === undefined)
    failures.push(`${f}: ${n} unchecked write(s) in a file with no budget`);
  else if (n > allowed) failures.push(`${f}: ${n} unchecked write(s), budget is ${allowed}`);
}

const total = [...current.values()].reduce((a, b) => a + b, 0);
const budgeted = [...budget.values()].reduce((a, b) => a + b, 0);
console.log(
  `check:discarded-errors — ${total} unchecked Supabase writes across ${current.size} files ` +
    `(budget ${budgeted})`,
);

if (failures.length) {
  console.error("\nUnchecked Supabase writes above budget:\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nBranch on `error` from the query, or route the write through " +
      "`writeAuditLog()` / `notifyOperators()` in src/server/audit.server.ts.\n" +
      `Then lower the file's number in ${BUDGET}. The budget only shrinks.\n`,
  );
  process.exit(1);
}
