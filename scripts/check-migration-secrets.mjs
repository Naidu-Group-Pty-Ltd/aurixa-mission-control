#!/usr/bin/env node
// Fail CI when a migration carries a credential VALUE.
//
// This exists because one did. `20260820175047` shipped the live CRON_SECRET —
// the bearer token that authenticates every pg_cron call into `/hooks/*` — as a
// string literal, and nothing anywhere reported it. That is the shape of defect
// this repository keeps finding: no runtime signal at all. The migration ran
// correctly, cron kept working, every check stayed green, and the token was
// readable by anyone with repository access.
//
// It is also the shape that cannot be undone by fixing it. A value that has
// been pushed is published; the remedy is rotation, and the only thing a guard
// can do is stop the NEXT one.
//
// The rule this enforces is narrow on purpose: a guard that reports a
// contradiction on correct code is one people learn to silence. It flags a
// literal only when the literal itself looks like a credential AND its
// surroundings say it is one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";

// Words that make a nearby high-entropy literal a credential rather than a
// hostname, a slug or an enum value.
const CONTEXT = /(secret|token|password|passwd|api[_-]?key|apikey|credential|bearer|private[_-]?key|access[_-]?key)/i;

// Calls whose argument is a secret by definition, whatever it looks like.
const SECRET_SINK = /vault\.(create|update)_secret\s*\(\s*'/i;

// Shapes that are high-entropy but never credentials here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^(eyJ[A-Za-z0-9_-]+)\.(eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * A generated credential mixes cases and digits. A slug never does.
 *
 * This is the whole difference between a guard people keep and one they
 * silence: `token-refresh-5min`, `report-financial-summary` and
 * `app.settings.public_app_url` all sit beside the word "token" or "secret",
 * are long, and score high on raw entropy — and none of them is a credential.
 * Requiring upper AND lower AND a digit drops every one of them and keeps the
 * 64-char random string this guard exists for.
 */
/**
 * Stripe object ids are random-looking and public. `price_…` and `prod_…` are
 * quoted in client-side checkout code by design; the secrets carry their own
 * prefixes and are listed separately so a real one is never excused.
 */
const STRIPE_PUBLIC = /^(price|prod|cus|sub|acct|evt|cs|in|pi|seti|txr|tax)_/;
const STRIPE_SECRET = /^(sk|rk|whsec)_/;

function looksGenerated(v) {
  return /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v);
}

/**
 * A Supabase anon key is PUBLIC — it ships in every client bundle and is what
 * RLS is designed to be safe against. A service_role key in the same position
 * bypasses RLS entirely. They are the same shape, so the role has to be read
 * rather than guessed: five anon keys are committed in this corpus on purpose.
 */
function jwtRole(value) {
  const m = JWT.exec(value);
  if (!m) return null;
  try {
    const pad = m[2] + "=".repeat((4 - (m[2].length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, "base64url").toString("utf8")).role ?? "unknown";
  } catch {
    return "unparseable";
  }
}

function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Strip `-- line` comments so prose about a secret never trips the guard. */
function stripComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

const findings = [];
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  const raw = readFileSync(join(DIR, file), "utf8");
  const code = stripComments(raw);
  const lines = code.split("\n");

  lines.forEach((line, idx) => {
    for (const m of line.matchAll(/'([^']{16,})'/g)) {
      const value = m[1];
      if (UUID.test(value)) continue;
      if (/\s/.test(value)) continue;

      // A JWT is judged by its role, not its shape.
      const role = jwtRole(value);
      if (role !== null) {
        if (role !== "anon") {
          findings.push({
            file,
            line: idx + 1,
            preview: value.slice(0, 6) + "…" + value.slice(-4),
            why: `JWT with role="${role}" — only anon keys are safe to commit`,
          });
        }
        continue;
      }

      if (!/^[A-Za-z0-9_\-+/=.]+$/.test(value)) continue;
      if (STRIPE_SECRET.test(value)) {
        findings.push({
          file,
          line: idx + 1,
          preview: value.slice(0, 8) + "…",
          why: "Stripe secret/restricted/webhook key",
        });
        continue;
      }
      if (STRIPE_PUBLIC.test(value)) continue;
      if (!looksGenerated(value)) continue;
      if (entropy(value) < 3.6) continue;

      // Needs a reason to be called a secret: a nearby keyword or a vault sink.
      const context = line + " " + (lines[idx - 1] ?? "");
      if (!CONTEXT.test(context) && !SECRET_SINK.test(line)) continue;
      findings.push({
        file,
        line: idx + 1,
        preview: value.slice(0, 6) + "…" + value.slice(-4),
        why: `${value.length}-char generated-looking literal beside a secret keyword`,
      });
    }
  });
}

if (findings.length > 0) {
  console.error("Credential literal(s) found in migrations:\n");
  for (const f of findings) {
    console.error(`  ${DIR}/${f.file}:${f.line}`);
    console.error(`    ${f.preview} — ${f.why}\n`);
  }
  console.error("A migration is committed, replayed into every clone backend and copied");
  console.error("into forks. Read the value from Vault or a GUC the operator sets out of");
  console.error("band; never write it into the file. If this value was ever pushed,");
  console.error("rotate it — editing the file does not un-publish it.\n");
  process.exit(1);
}

console.log(`check:migration-secrets — ${files.length} migrations scanned, no credential literals`);
