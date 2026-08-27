# Migration effect assertions

Read this before adding a migration, changing `migrationAssertions.pure.ts`,
`migrationDrift.pure.ts`, `migration-drift.server.ts`, or the CI guards that
enforce them.

## The question the ledger cannot answer

`supabase_migrations.schema_migrations` is supposed to say which migrations have
been applied. On this deployment it cannot, and the numbers are not marginal:

| | |
| --- | --- |
| migration files in the repo | 212 |
| repo versions that appear in the ledger | **40** |
| ledger rows that match no repo file | **103** |

Lovable Cloud stamps its own apply timestamps, so the repo and the ledger are
two namespaces that barely overlap. That is why 67 files sat in a documented
backlog nobody could resolve: there was no way to tell an applied migration from
an unapplied one, and so no way to work the backlog down.

There is a second failure the ledger could never catch even if it worked. This
corpus contains `DO $$ ... EXCEPTION WHEN OTHERS THEN NULL $$` blocks. Those
**run**, **succeed**, and achieve nothing. Every applier in the world records
that as applied.

## The rule

Every migration added from `20260828020000` onwards carries at least one
`-- @asserts` comment naming something the database can be asked about.

```sql
-- @asserts table:clone_reference_syncs
-- @asserts column:clone_backends.reference_sync_started_at
-- @asserts rpc:cron_delivery_health
-- @asserts cron:reference-data-sync-hourly
-- @asserts rows:mirror_exclusions>=17
-- @asserts enum:clone_backend_status
-- @asserts none:documentation only, creates no object
```

`none` exists on purpose and requires a reason in words. A migration that
genuinely makes nothing observable must say so, because "asserts nothing" and
"nobody wrote one" have to look different.

The grammar lives in `src/server/migrationAssertions.pure.ts`. It is **imported**
by the CI guard rather than reimplemented in it — Node ≥22.18 strips types on
import, so `scripts/check-migration-assertions.mjs` parses with exactly the code
the runtime alarm parses with. A rule enforced twice from two copies is a rule
that eventually disagrees with itself.

### A malformed claim fails, it is never skipped

A line nobody can parse looks like coverage in a listing and checks nothing at
run time. So a bad claim fails the whole file, including files in the baseline —
freezing "no assertion" is deliberate debt; freezing a broken one would freeze
something that looks like coverage.

### The baseline only shrinks

`scripts/migration-assertions-baseline.txt` freezes the 211 files that predate
the rule. Nothing may be added to it. They are not grandfathered forever — the
intent is that a file gains a claim the next time anyone touches it — but
requiring 211 retrofits before the rule can start is how a rule never starts.

A baseline line naming a file that no longer exists is also a hard failure,
otherwise a migration deleted and recreated under the same name keeps its
exemption.

## How a claim gets answered

`scripts/generate-migration-assertions.mjs` compiles every claim into
`src/server/migrationAssertions.generated.ts`. That indirection is not
decoration: the alarm runs in a Cloudflare Worker, where there is no filesystem
and `supabase/migrations` is not part of the bundle. `npm run
migrations:assertions:check` fails CI when the module is stale, because a
generated file allowed to drift keeps reporting on a corpus that has moved —
and reports it healthy.

`/hooks/migration-drift` runs hourly (`migration-drift-hourly`, `17 * * * *`)
and resolves the claims against the live schema.

| claim | channel |
| --- | --- |
| `table`, `column` | `GET /rest/v1/<t>?select=...&limit=0` — 200 present, `PGRST205` / `42703` absent |
| `rows` | the same GET with `Prefer: count=exact`, read off `content-range` |
| `rpc` | the PostgREST schema description at `GET /rest/v1/` (service-role only) |
| `cron` | `public.cron_delivery_health()`, which already reaches `cron.job` |
| `enum` | none — `pg_type` is outside the two exposed schemas |

**An `rpc` claim is answered from the schema description and never by calling
the function.** Probing a function by invoking it is how a checker fires a
webhook, drains a queue, or charges a card to find out whether something exists.

## Five verdicts, not two

A pass/fail alarm is a useless alarm. Three distinct things are not failure and
none of them is success:

- **`error`** — the probe did not complete. *A read that FAILED is not an object
  that is ABSENT.* Reading `42703` as an empty result cost this platform twelve
  handlers reporting "Case not found" about a case the operator had open
  (`docs/aml/CASE_TENANT_COLUMN.md`). The same conflation here would report a
  migration as never applied because of a 502, and send somebody to re-run SQL.
- **`unassertable`** — nothing can answer. `enum` claims are this. Saying "I
  could not check this" is the point; a checker that drops what it cannot see
  reports coverage it does not have.
- **`not_applicable`** — a `none:` claim. Valid to have written, and evidence of
  nothing.

Only `unsatisfied` raises an operator notification, and only the **first** time
a claim enters that state. An alarm that also fires for "could not reach the
database", or that re-fires hourly on a finding somebody has already seen, is
one people mute — and then it is not an alarm for anything.

`checked` counts satisfied plus unsatisfied only. Letting coverage rise by
adding claims nothing can see is how a green number stops meaning anything.

## What this does and does not do

It does **not** remove the hand-apply step. It makes forgetting impossible,
which is the actual harm, and it answers the backlog on day one.

It adds **no privilege**: no database function, no grant, no DDL for any API
role. `docs/MIGRATION_AUTOMATION_OPTIONS.md` records why that matters —
this database's default ACL grants `EXECUTE` on every new `public` function to
`anon` and `authenticated` (77 of 145 functions today), so the explicit `REVOKE`
is the only thing between such a function and the browser bundle, and this
repository writes that `REVOKE` wrong 71% of the time.

## Things that bite

**A deferred claim is not a verdict.** The worker runs to a wall-clock budget
and a per-run target cap, ordering never-checked claims first. A claim it did
not reach is left untouched in the table — writing `unassertable` over
yesterday's `unsatisfied` would clear an open alarm by running out of budget.

**The budget can never refuse the first probe.** A check that can is a worker
that ticks forever and never advances, which from the outside looks exactly like
a healthy schedule.

**A claim's target is deduplicated, its threshold is not.** `rows:t>=17` and
`rows:t>=3` are one `COUNT` and two judgements. Probe count stays proportional
to the schema rather than to the corpus.

**A failed count is never reported as zero.** "Holds 0 rows" would send somebody
looking for a seed script for a table that was never created.

**Rows outlive their claims, so the worker prunes them.** An edited claim or a
renamed migration leaves a row behind, and an alarm nobody can clear is one
people learn to ignore.

## Operator surface

`/health` carries the **Migration effects** card: which claims are present,
missing, unanswered, uncheckable, and how many have never been checked at all.
That last count is read from the compiled corpus rather than from the table,
because a claim with no row is the interesting empty case — the worker has not
reached it, or has not run at all. Reporting only what the table holds would
make an alarm that has never run look like an alarm with nothing to report.
