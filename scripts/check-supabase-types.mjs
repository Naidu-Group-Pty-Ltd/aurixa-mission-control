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

const problems = [];
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
  `✓ Supabase types cover ${tables.size} tables and ${enums.size} enums declared in ${MIGRATIONS}.`,
);
