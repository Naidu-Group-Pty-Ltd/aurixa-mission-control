#!/usr/bin/env node
// Fail when the generated Supabase types have fallen behind the migrations.
//
// This is not a style check. `supabase-js` resolves `.from("x")` against the
// `Database` type, and a table the type does not name resolves to `never` —
// so every column read off the result, every insert payload and every filter
// on that table stops being checked, silently. The file still compiles. The
// query still runs. Nothing anywhere says the table is unknown.
//
// Six tables had drifted out of `types.ts` by the time this was written —
// user_invites and the five support/remediation tables — and between them they
// accounted for roughly 120 of the type errors the repository was holding down
// under `@ts-nocheck`, concentrated in the files that own those features.
//
// The remedy is always to regenerate, never to hand-write:
//
//     supabase gen types typescript --project-id <ref> > src/integrations/supabase/types.ts
//
// Enum values are checked too, because `ALTER TYPE … ADD VALUE` is the drift
// that regenerating fixes and nobody remembers to run.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";
const TYPES = "src/integrations/supabase/types.ts";

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

// Strip line comments so a table named only inside prose never counts.
const bare = sql.replace(/--[^\n]*/g, "");

const tables = new Set();
for (const m of bare.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  tables.add(m[1]);
}
for (const m of bare.matchAll(
  /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  tables.delete(m[1]);
}

// Enum name -> the values the migrations have declared for it.
const enums = new Map();
for (const m of bare.matchAll(
  /create\s+type\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+as\s+enum\s*\(([^)]*)\)/gi,
)) {
  const values = [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]);
  enums.set(m[1], new Set(values));
}
for (const m of bare.matchAll(
  /alter\s+type\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']*)'/gi,
)) {
  if (enums.has(m[1])) enums.get(m[1]).add(m[2]);
}

const types = readFileSync(TYPES, "utf8");

// `.from("x")` resolves against Tables and Views alike, and a migration's
// CREATE TABLE may since have been replaced by a view — so a name declared
// anywhere at table depth in the file counts.
const declared = (name) => new RegExp(`^ {6}${name}: \\{$`, "m").test(types);

const missingTables = [...tables].filter((t) => !declared(t)).sort();

const missingEnums = [];
const missingValues = [];
for (const [name, values] of enums) {
  const block = types.match(new RegExp(`^ {6}${name}:([\\s\\S]*?)(?=^ {6}[a-z_]+:|^ {4}\\})`, "m"));
  if (!block) {
    missingEnums.push(name);
    continue;
  }
  const present = new Set([...block[1].matchAll(/"([^"]*)"/g)].map((v) => v[1]));
  for (const v of values) if (!present.has(v)) missingValues.push(`${name} → "${v}"`);
}

// Every `.rpc("name")` the source calls must be a function the types declare.
// An undeclared name is not a compile error while the caller holds an `any`
// client, and there is no runtime signal either — PostgREST answers 404 and
// supabase-js hands back `{ data: null, error }`, which most callers treat as
// "nothing to do". `feedback_pending_forward` existed in SQL, was missing from
// the types, and its retry drain read the 404 as an empty backlog.
const src = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(e.name) && e.name !== "types.ts") src.push(full);
  }
};
walk("src");

// The generator writes short entries inline (`name: { Args: … }`) and long ones
// over several lines, so both forms have to count as declared.
const declaredFns = new Set(
  [...types.matchAll(/^ {6}([a-z_][a-z0-9_]*): \{\s*\n? *Args:/gm)].map((m) => m[1]),
);
const calledFns = new Set();
for (const file of src) {
  // Comments mention `.rpc("name")` when they explain the convention; strip them
  // so prose cannot invent a call site.
  const code = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const m of code.matchAll(/\.rpc\(\s*"([a-z_][a-z0-9_]*)"/g)) calledFns.add(m[1]);
}
const missingFns = [...calledFns].filter((f) => !declaredFns.has(f)).sort();

const problems = [];
if (missingFns.length)
  problems.push(
    `RPCs called from src/ but not declared in ${TYPES}:\n` +
      missingFns.map((t) => `  • ${t}`).join("\n") +
      `\n  Arguments and return shape are unchecked, and a name that does not exist\n` +
      `  at all answers 404 — which reads as an empty result, not as an error.`,
  );
if (missingTables.length)
  problems.push(
    `Tables in migrations but not in ${TYPES}:\n` +
      missingTables.map((t) => `  • ${t}`).join("\n") +
      `\n  Every \`.from("…")\` against these resolves to \`never\`, so nothing about them is typechecked.`,
  );
if (missingEnums.length)
  problems.push(`Enum types missing:\n` + missingEnums.map((t) => `  • ${t}`).join("\n"));
if (missingValues.length)
  problems.push(
    `Enum values missing (usually an \`ALTER TYPE … ADD VALUE\`):\n` +
      missingValues.map((t) => `  • ${t}`).join("\n"),
  );

if (problems.length) {
  console.error("\n✖ Generated Supabase types are behind the migrations.\n");
  console.error(problems.join("\n\n"));
  console.error(
    `\nRegenerate — do not hand-edit ${TYPES}:\n` +
      `  supabase gen types typescript --project-id <ref> > ${TYPES}\n`,
  );
  process.exit(1);
}

console.log(
  `✓ Supabase types cover ${tables.size} tables and ${enums.size} enums from ${MIGRATIONS}, ` +
    `and all ${calledFns.size} RPCs called from src/.`,
);
