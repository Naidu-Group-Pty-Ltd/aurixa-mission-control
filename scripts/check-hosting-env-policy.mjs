#!/usr/bin/env node
// Two failures that produce no runtime signal, on the deployment path.
//
// 1. A SECRET GIVEN A PUBLIC NAME.
//
//    Vite inlines every `VITE_`-prefixed variable into the client bundle at
//    build time. Marking it "encrypted" on the hosting provider protects it at
//    rest and not at all in the artefact — the value is a string literal in the
//    JavaScript every visitor downloads. Give the Supabase SERVICE-ROLE key a
//    `VITE_` name and the build succeeds, the deployment goes live, and a key
//    that bypasses every RLS policy on a customer's database is served to the
//    public. Nothing fails. Nothing logs.
//
//    `envPolicy.pure.ts` throws at runtime, which covers everything that goes
//    through `buildCloneEnv`. This covers the other half: a literal somebody
//    writes into a component, a script, or a second env builder that never
//    imports the policy.
//
// 2. A STATUS THE COLUMN WILL REFUSE.
//
//    `clone_deployments.status` has a CHECK constraint and the worker's state
//    machine lives in TypeScript. When they drift, the update fails with
//    `violates check constraint` — and this codebase has a long history of
//    discarding the error from a Supabase call, which turns a refused write into
//    a row that silently never advances. Same class as a table missing from the
//    generated types.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_"];
const SECRET_FRAGMENTS = [
  "SERVICE_ROLE",
  "SERVICE_KEY",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "ACCESS_TOKEN",
  "API_TOKEN",
  "CLIENT_SECRET",
  "WEBHOOK_SECRET",
  "DB_PASS",
  "DATABASE_URL",
  "CONNECTION_STRING",
];

// The policy module names these fragments in order to REFUSE them, and its test
// file spells them out to prove the refusal. Both are the rule, not a breach.
const EXEMPT_FILES = new Set([
  "src/server/hosting/envPolicy.pure.ts",
  "src/server/hosting/envPolicy.test.ts",
]);

const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(path);
      continue;
    }
    if (!/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) continue;
    if (EXEMPT_FILES.has(path)) continue;
    const src = readFileSync(path, "utf8");
    // Whole identifiers only: a prefix followed by name characters.
    for (const m of src.matchAll(/\b((?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_)[A-Z0-9_]+)\b/g)) {
      const name = m[1];
      const fragment = SECRET_FRAGMENTS.find((f) => name.includes(f));
      if (!fragment) continue;
      const line = src.slice(0, m.index).split("\n").length;
      failures.push(
        `${path}:${line}  ${name} — public prefix carrying "${fragment}". ` +
          `A value that grants authority cannot have a name the bundler inlines.`,
      );
    }
  }
}

walk("src");
if (PUBLIC_PREFIXES.length === 0) throw new Error("unreachable");

// ── Status parity ──────────────────────────────────────────────────────────
const MIGRATIONS = "supabase/migrations";
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, "");

// Scoped to the clone_deployments table body. Searching the whole migration
// corpus for `status ... check (status in (...))` finds the FIRST such column in
// any table — which was clone_edge_config, whose states are waitlisted/pending_ns
// /active/drifted. A parity check that silently compares the wrong two lists is
// worse than none: it fails loudly on correct code and passes on the drift it
// exists to catch.
const tableMatch = sql.match(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.clone_deployments\s*\(([\s\S]*?)\n\);/i,
);
const checkMatch = tableMatch
  ? tableMatch[1].match(/status\s+text\s+not\s+null[^,]*?check\s*\(status\s+in\s*\(([^)]*)\)/i)
  : null;
if (!checkMatch) {
  failures.push(
    "supabase/migrations  could not find the clone_deployments.status CHECK constraint. " +
      "If the column was renamed or the constraint reshaped, update this check with it — " +
      "a parity check that cannot find its subject silently stops checking.",
  );
} else {
  const dbStatuses = new Set([...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const tsSrc = readFileSync("src/server/hosting/deploymentState.pure.ts", "utf8");
  const tsMatch = tsSrc.match(/DEPLOYMENT_STATUSES\s*=\s*\[([^\]]*)\]/);
  const tsStatuses = new Set(
    tsMatch ? [...tsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [],
  );

  for (const s of tsStatuses) {
    if (!dbStatuses.has(s)) {
      failures.push(
        `deploymentState.pure.ts declares status "${s}" that clone_deployments.status refuses. ` +
          `The update fails with "violates check constraint" and the row never advances.`,
      );
    }
  }
  for (const s of dbStatuses) {
    if (!tsStatuses.has(s)) {
      failures.push(
        `clone_deployments.status accepts "${s}" that deploymentState.pure.ts does not declare. ` +
          `A row in that state is claimable by nothing and readable as nothing.`,
      );
    }
  }
}

// 3. A SUBDOMAIN STATUS THE COLUMN WILL REFUSE.
//
//    Same class as (2) and it has already bitten once on this path:
//    `awaiting_deployment` was written by three call sites before the CHECK
//    constraint knew about it. Every one of those call sites discards the error
//    from the update, so the write failed and the clone simply stayed in its
//    previous state — a subdomain that never progresses, with nothing logged
//    anywhere and no failed request to find.
//
//    The constraint is amended by a later migration rather than living in the
//    CREATE TABLE, so this reads the LAST definition in the corpus. Reading the
//    first would compare against a list that was correct eight months ago.
{
  const constraintDefs = [
    ...sql.matchAll(
      /clones_subdomain_status_check\s*\n?\s*check\s*\(\s*subdomain_status\s+is\s+null\s+or\s+subdomain_status\s+in\s*\(([^)]*)\)/gi,
    ),
  ];
  if (constraintDefs.length === 0) {
    failures.push(
      "supabase/migrations  could not find the clones_subdomain_status_check constraint. " +
        "A parity check that cannot find its subject silently stops checking.",
    );
  } else {
    const allowed = new Set(
      [...constraintDefs[constraintDefs.length - 1][1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    // Every literal the application assigns to the column, wherever it lives.
    const written = new Map();
    const collect = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const st = statSync(path);
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === ".git") continue;
          collect(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const src = readFileSync(path, "utf8");
        // The ternary form first: `ready ? "queued" : "pending_platform"` also
        // matches the plain pattern on its first branch, so running the simple
        // one first would record only half of it.
        for (const m of src.matchAll(
          /subdomain_status:\s*[^,\n]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g,
        )) {
          if (!written.has(m[1])) written.set(m[1], path);
          if (!written.has(m[2])) written.set(m[2], path);
        }
        for (const m of src.matchAll(/subdomain_status:\s*"([^"]+)"/g)) {
          if (!written.has(m[1])) written.set(m[1], path);
        }
      }
    };
    collect("src");
    for (const [value, file] of written) {
      if (!allowed.has(value)) {
        failures.push(
          `${file}  writes clones.subdomain_status = "${value}", which the CHECK constraint ` +
            `refuses. The update fails with "violates check constraint", the error is discarded, ` +
            `and the clone silently keeps its previous status.`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error("\n✗ Hosting policy check failed:\n");
  for (const f of failures) console.error("  " + f);
  console.error("");
  process.exit(1);
}

console.log(
  "✓ No secret carries a public env prefix, and the deployment state machine matches the column.",
);
