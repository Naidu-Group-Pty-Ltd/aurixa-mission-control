#!/usr/bin/env node
// A scheduled job must not be able to send an empty credential.
//
// `deployment-drain-1min` shipped with its Authorization header built as
// `'Bearer ' || COALESCE(current_setting('app.settings.cron_secret', true), '')`
// and baked into the job command with format(%L). The GUC is unset on the live
// deployment — every other job reads `vault.decrypted_secrets` — so the header
// was the literal string `Bearer `, a well-formed request the endpoint answers
// 401. It ran every minute for as long as it existed and never once
// authenticated: 208 refusals in three hours, measured from
// `net._http_response`, while `cron.job_run_details` reported every run as
// succeeded, because queueing the HTTP call IS the success it reports.
//
// Two rules, both about the same idea — a missing credential must fail, never
// degrade into a valid-looking wrong one:
//
//   1. No COALESCE(..., '') around a secret used in an Authorization header.
//   2. A cron command that sends Authorization must read the secret from the
//      vault, and must read it INSIDE the command so each run picks up a
//      rotation instead of replaying whatever was true at install time.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Only the EFFECTIVE scheduling of a job matters. Migrations are a history:
// several of these job names were first installed with this exact defect and
// rescheduled correctly by a later migration, and on a replay from zero the
// last writer wins. Flagging the superseded ones would fail CI on a corpus
// whose end state is correct — and a guard that reports a contradiction on
// correct code is one people learn to silence.
const lastSchedule = new Map(); // jobname -> { file, body }
const rawFindings = [];

for (const file of files) {
  const sql = readFileSync(join(DIR, file), "utf8");
  // Comments explain the defect; they are not the defect.
  const code = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  // A secret coalesced to the empty string next to a Bearer header, anywhere.
  for (const m of code.matchAll(/'Bearer\s*'\s*\|\|\s*(?:COALESCE|coalesce)\([^)]*,\s*''\s*\)/g)) {
    rawFindings.push({
      file,
      scope: "any",
      why: "Bearer built with COALESCE(..., '') — a missing secret becomes an empty one",
      snippet: m[0].replace(/\s+/g, " ").slice(0, 100),
    });
  }

  // A literally empty bearer written straight into a header object.
  for (const m of code.matchAll(/"Authorization"\s*:\s*"Bearer\s*"/gi)) {
    rawFindings.push({
      file,
      scope: "any",
      why: "Authorization header is a literal empty Bearer",
      snippet: m[0],
    });
  }

  // Record the last scheduling of each job name.
  for (const m of code.matchAll(/cron\.schedule\s*\(\s*'([^']+)'([\s\S]*?)\)\s*;/g)) {
    lastSchedule.set(m[1], { file, body: m[2] });
  }
}

const findings = [];

// The COALESCE / empty-bearer rules apply to whichever migration STILL
// determines a job's command. A superseded one is history.
const effectiveFiles = new Set([...lastSchedule.values()].map((v) => v.file));
for (const f of rawFindings) {
  if (effectiveFiles.has(f.file)) findings.push(f);
}

for (const [jobname, { file, body }] of lastSchedule) {
  if (!/Authorization/i.test(body)) continue;
  if (/vault\.decrypted_secrets/i.test(body)) continue;
  findings.push({
    file,
    why: `the effective scheduling of '${jobname}' sends Authorization without reading vault.decrypted_secrets`,
    snippet: body.replace(/\s+/g, " ").slice(0, 100),
  });
}

if (findings.length) {
  console.error("Scheduled jobs must not be able to send an empty credential.\n");
  for (const f of findings) {
    console.error(`  ${f.file}\n    ${f.why}\n    ${f.snippet}\n`);
  }
  console.error(
    "Build the header inside the command as:\n" +
      "  'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)",
  );
  process.exit(1);
}

console.log(`check:cron-auth — ${files.length} migrations, no job can send an empty credential`);
