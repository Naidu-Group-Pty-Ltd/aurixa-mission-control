#!/usr/bin/env node
// The prime BACKEND must never be derived from this deployment's own URL.
//
// `getPrimeProjectRef()` used to do exactly that — parse `SUPABASE_URL` and
// call the result "the prime". Its doc comment said so plainly, so nobody
// reading it saw a bug. But `SUPABASE_URL` is the project holding `clones`,
// `prime_config` and `cascade_events`: Mission Control's own admin database.
//
// Every replication step that consumed it therefore read the wrong project —
// catalogue introspection (the DEFAULT clone strategy, which would have given
// a clone Mission Control's schema instead of the product's), storage buckets
// and seed assets, the pg_cron schedule (pointing a clone's jobs at Mission
// Control's own /hooks endpoints), the realtime publication, the migration
// ledger stamp, and every handoff parity report.
//
// None of it failed. A wrong source that is reachable produces a confident,
// complete, wrong result — which is why this is a build-time check and not a
// runtime one. The correct source is configuration:
// `prime_config.supabase_project_ref`, read by `resolvePrimeBackendRef()`,
// which refuses an unset value and refuses this deployment's own ref.
//
// Allowed: `ownProjectRef()` in prime-backend.server.ts, which exists so the
// guards can NAME the deployment's own ref in order to refuse it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const ALLOWED = new Set([
  // The one legitimate parse: used only to refuse a ref that equals it.
  "src/server/prime-backend.server.ts",
]);

// A SUPABASE_URL read within a few lines of a project-ref regex is the shape
// this guard exists to catch. Matching the pair rather than either half keeps
// the ordinary `process.env.SUPABASE_URL` reads (building a client, an origin
// allow-list) out of scope.
// The host appears inside a REGEX LITERAL in the code being scanned, so the
// dots arrive escaped: `\.supabase\.co`. Matching a plain `.supabase.` finds
// nothing — which is how the first version of this guard passed a renamed
// reintroduction. Tolerate the backslashes.
const REF_REGEX = /\\?\.supabase\\?\.(?:co|in|net)/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT)) {
  if (ALLOWED.has(file.split("\\").join("/"))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/process\.env\.SUPABASE_URL/.test(line)) return;
    // Look at a small window for a project-ref extraction.
    const window = lines.slice(i, i + 6).join("\n");
    if (REF_REGEX.test(window)) {
      findings.push({ file, line: i + 1, text: line.trim() });
    }
  });
}

// Any reintroduction of the old names is a finding on its own.
for (const file of walk(ROOT)) {
  if (ALLOWED.has(file.split("\\").join("/"))) continue;
  const sql = readFileSync(file, "utf8");
  for (const name of ["getPrimeProjectRef", "tryGetPrimeProjectRef"]) {
    if (new RegExp(`\\b(function|const)\\s+${name}\\b`).test(sql)) {
      findings.push({ file, line: 0, text: `redefines ${name}()` });
    }
  }
}

if (findings.length) {
  console.error("The prime backend ref must come from configuration, not from SUPABASE_URL.\n");
  for (const f of findings) {
    console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.text}`);
  }
  console.error(
    "\nUse resolvePrimeBackendRef(supabase) — it reads prime_config.supabase_project_ref " +
      "and refuses both an unset value and this deployment's own project.",
  );
  process.exit(1);
}

console.log("check:prime-backend-ref — no prime ref derived from SUPABASE_URL");
