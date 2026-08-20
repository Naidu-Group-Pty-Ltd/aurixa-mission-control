#!/usr/bin/env node
// Every `/hooks/*` route must be scheduled, or declared as something else.
//
// A worker nobody calls produces no error anywhere. The endpoint is present, it
// is guarded, it passes typecheck and lint, its tests pass — and the queue it
// drains simply never drains. Nothing in the application can tell you: there is
// no failing request to log, because there is no request.
//
// Six of them were in that state when this check was written —
// api-usage-settle, edge-drain, edge-drift, handoff-observability-poll,
// handoff-parity-refresh and drift-refresh — every one of which opens its own
// file by stating the cron cadence that did not exist. `api-usage-settle`
// closes billing periods and pushes charges to Stripe.
//
// So the rule is that a hook is either scheduled in a migration or written down
// here as driven by something else. Both halves are checked, because an entry
// that goes stale is how the list stops meaning anything.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";
const ROUTES = "src/routes";

// Hooks that are correctly NOT on a timer, and what drives them instead.
const NOT_SCHEDULED = new Map([
  ["github", "GitHub webhook receiver — fires on repository events."],
]);

const hooks = readdirSync(ROUTES)
  .filter((f) => /^hooks\.[a-z0-9-]+\.tsx?$/.test(f))
  .map((f) => f.replace(/^hooks\./, "").replace(/\.tsx?$/, ""))
  .sort();

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

// A hook counts as scheduled when a migration names its path. That covers a
// literal URL and the `v_base || '/hooks/' || j.hook` form, where the hook name
// appears as a bare string in the job table the loop reads.
const scheduled = new Set();
for (const m of sql.matchAll(/\/hooks\/([a-z0-9-]+)/g)) scheduled.add(m[1]);
for (const m of sql.matchAll(/'([a-z0-9-]+)'\s*\)\s*(?:,|\n)/g)) {
  if (hooks.includes(m[1])) scheduled.add(m[1]);
}

const orphans = hooks.filter((h) => !scheduled.has(h) && !NOT_SCHEDULED.has(h));
const staleExemptions = [...NOT_SCHEDULED.keys()].filter((h) => !hooks.includes(h));
const contradictions = [...NOT_SCHEDULED.keys()].filter((h) => scheduled.has(h));

const problems = [];
if (orphans.length)
  problems.push(
    `Hook routes with no schedule:\n` +
      orphans.map((h) => `  • /hooks/${h}`).join("\n") +
      `\n  Nothing calls these, and nothing will report that. Schedule them in a\n` +
      `  migration, or add them to NOT_SCHEDULED in this script with what does\n` +
      `  drive them.`,
  );
if (staleExemptions.length)
  problems.push(
    `Declared in NOT_SCHEDULED but the route is gone:\n` +
      staleExemptions.map((h) => `  • ${h}`).join("\n"),
  );
if (contradictions.length)
  problems.push(
    `Declared as not-scheduled but a migration schedules them:\n` +
      contradictions.map((h) => `  • ${h}`).join("\n"),
  );

if (problems.length) {
  console.error("\n✖ Cron coverage\n");
  console.error(problems.join("\n\n") + "\n");
  process.exit(1);
}

console.log(
  `✓ Cron coverage: ${hooks.length} hook routes — ` +
    `${hooks.length - NOT_SCHEDULED.size} scheduled, ` +
    `${NOT_SCHEDULED.size} declared event-driven.`,
);
