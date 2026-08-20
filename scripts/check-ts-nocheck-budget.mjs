#!/usr/bin/env node
// A ratchet on `@ts-nocheck`, not a ban.
//
// This repository had 164 files carrying a bare `// @ts-nocheck`, hiding 1,038
// type errors — 50 of those files in `src/server`. They were also 161 of the
// 162 lint errors, so `npm run lint` exited 1 and no pull request could pass
// CI. Most of it came from one tsconfig flag (see the note beside
// `strictNullChecks`) and from six tables missing out of the generated Supabase
// types; between them they accounted for around 900 of the errors, and eight
// runtime-fatal defects were sitting underneath.
//
// What is left is real work on real files. The rule is simply that the list
// only ever shrinks: a file may be REMOVED from the budget by fixing its
// errors, and nothing may be added. A new file needing `@ts-nocheck` is a
// signal to fix the types instead, which is exactly the decision that produced
// the 164.
//
// Every entry also carries its own reason at the top of the file — how many
// errors and of what kind — so removing one is a scoped, estimable job rather
// than an open-ended offer.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BUDGET = "scripts/ts-nocheck-budget.txt";

const allowed = new Set(
  readFileSync(BUDGET, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean),
);

const found = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(e.name) && e.name !== "routeTree.gen.ts") {
      // Only the directive itself counts. Prose that merely mentions
      // `@ts-nocheck` while explaining why a file does NOT use one is not a
      // suppression, and TypeScript only honours it above the first statement.
      const first = readFileSync(full, "utf8").split("\n", 1)[0];
      if (/^\/\/ @ts-nocheck( |$)/.test(first)) found.add(full);
    }
  }
};
walk("src");

const added = [...found].filter((f) => !allowed.has(f)).sort();
const fixed = [...allowed].filter((f) => !found.has(f)).sort();

if (added.length) {
  console.error(
    `\n✖ ${added.length} new file(s) suppress typechecking with @ts-nocheck:\n` +
      added.map((f) => `  • ${f}`).join("\n") +
      `\n\nThe budget only goes down. Fix the types rather than adding to it —\n` +
      `a whole-file suppression hides every unrelated error in that file too,\n` +
      `which is how the previous 164 accumulated.\n`,
  );
  process.exit(1);
}

if (fixed.length) {
  console.error(
    `\n✖ ${fixed.length} file(s) no longer need @ts-nocheck. Remove them from ${BUDGET}:\n` +
      fixed.map((f) => `  • ${f}`).join("\n") +
      `\n\n(This is good news — the check just wants the ledger to match.)\n`,
  );
  process.exit(1);
}

console.log(`✓ @ts-nocheck budget holds at ${found.size} file(s); none added.`);
