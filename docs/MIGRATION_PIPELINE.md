# Migrations merged through a pull request never reached the database

Mission Control is edited in two places — this repository, and Lovable. Lovable
applies the migrations it authors. Nothing applied the ones that arrive here
through a pull request. They merged, they shipped in the repo, and the database
never saw them.

Measured on 2026-08-27, two examples that had both merged and neither existed:

| migration | what it was for | what its absence cost |
| --- | --- | --- |
| `20260826070000_seed_mirror_exclusions` | the mirror cascade's exclusion policy | the cascade could still revert a clone's backend identity — the lead-magnet embed would go back to posting leads into the PRIME's database |
| `20260827030000_schedule_allowed_origins_reconcile` | the `ALLOWED_ORIGINS` reconciler's cron job | a worker that shipped correctly, deployed correctly, and was never once called |

Nothing reported either. **A migration that never runs looks exactly like one
that ran and did nothing.**

## Why `supabase db push` is not the fix

The obvious answer is to let the Supabase CLI apply what the ledger says is
pending. It cannot work here, and the reason is worth stating precisely because
it is not obvious from looking at either side alone.

`supabase_migrations.schema_migrations` and `supabase/migrations/` are **two
different namespaces describing the same history.** Lovable records a migration
under the timestamp at which *it* applied the file, not the timestamp in the
filename. Against 207 files:

```
 35   exact version match in the ledger
105   a ledger row 2–5 seconds off the filename   <- same migration, Lovable's clock
 67   no ledger row within two minutes
```

The 105 are the tell. `20260419215311` in the repo is `20260419215308` in the
ledger — the same migration, three seconds apart, and no version-matching
reconciliation can join them.

The remaining 67 are hand-authored files with round timestamps
(`20260609120000`). Some are applied, by an operator running the SQL directly;
some are not; and **nothing in the database distinguishes those two cases.**

So `db push` pointed here would replay ~172 files, including `cron.schedule`
calls and seed `INSERT`s where a second application is not a no-op. The prime
repository reached the same conclusion independently — see the header of its
`.github/workflows/apply-migration.yml`, which measured its own ledger
under-reporting "by roughly two orders of magnitude" and settled on applying one
named file per dispatch.

## What runs instead

`.github/workflows/apply-migrations.yml`, on push to `main`.

It never asks the ledger what is pending. It asks **git what this push added** —
a question with an exact answer:

```
git diff --name-only --diff-filter=A <before> <after> -- 'supabase/migrations/*.sql'
```

Then, in filename order, it applies each file through the Management API and
records its version. Everything else about the corpus is left alone.

Four rules carry it.

**Only ADDED files.** A modified migration is reported as a warning and never
re-applied. Editing an applied migration is the mistake; running the new text
over a database that already has the old one is the damage.

**Filename order is apply order.** Two migrations added in one merge can depend
on each other, and the timestamp is the only ordering either of them states.

**A version already in the ledger is skipped**, so re-running a push applies
nothing.

**Identity is verified, not configured.** The Management API token reaches every
project in the organisation — this one, the prime product's, and every clone. A
wrong `PROJECT_REF` does not fail; it writes this control plane's admin schema
onto somebody's tenant. So the ref is checked twice: against a refusal list, and
then *behaviourally* — the target is asked whether it holds `clones`,
`prime_config` and `cascade_events`, the three tables Mission Control has and
neither the prime nor a clone does. Verified against both:

```
Mission Control (fgpvagejkaeqedcwvbte)  -> true,  true,  true
clone           (plisdzywzleljorrphxv)  -> false, false, false
```

That is the same rule this codebase applies to the retention purge and to
provider readiness: assert by effect, never by configuration.

## What it needs

| setting | where | value |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Settings → Secrets → Actions | a Supabase Management API token |
| `SUPABASE_PROJECT_REF` | Settings → Variables → Actions | this deployment's own project ref |

There is deliberately **no default** for the ref. The prime's workflow falls back
to a literal, which is safe in exactly one repository and is the defect its
clones have to strip out. Here an empty ref refuses.

Without the secret the workflow fails loudly on the first merge that touches a
migration — which is the correct failure, and the opposite of the silence this
replaces.

## Ordering against the deploy

This runs on push to `main`; the application itself is published from Lovable.
Migrations therefore land **before or without** the code that uses them, which is
the safe order for the additive migrations this repo writes: a column that
exists before its reader is inert, a column that arrives after is a `42703`.

A migration that REMOVES something a live deployment still reads has to be
staged by hand, across two merges.

## The 67, and what was done about them

They are not reconciled, and deliberately so. "Not in the ledger" does not mean
"not applied" — several were applied by an operator running the SQL directly,
including `20260826000000_schedule_the_engine.sql`, whose cron jobs are live and
serving. Marking them applied would freeze a guess; re-applying them would
replay `cron.schedule` and seed data. Both are worse than leaving a known, named
backlog.

Two exceptions were recorded, because their state is not a guess — they were
applied by hand on 2026-08-27, verified by their effects (17 exclusion rows;
`allowed-origins-reconcile-15min` active in `cron.job`), and then written into
the ledger so the pipeline will not offer them again:

```
20260826070000  seed_mirror_exclusions
20260827030000  schedule_allowed_origins_reconcile
```

## The guard

`npm run check:migration-pipeline` (in CI) fails on the two ways a migration can
merge and never apply, both silent:

- **no 14-digit version** — cannot be recorded, so the workflow refuses it;
- **a duplicate version** — the ledger records a version once, so the second
  file applies and is then indistinguishable from the first, and a replay skips
  it entirely. Which file loses is decided by filename sort order.

It is deliberately static. Whether a migration has been *applied* is a question
only the database can answer, and this project's ledger cannot answer it
honestly — which is the whole reason this document exists.


---

# The fleet: how a clone's DATABASE gets the prime's migrations

Everything above is about **Mission Control's own** schema — one project, and a
GitHub Actions workflow is the right shape for it because a red ✗ on the merge
commit is the loudest signal available.

The fleet is a different problem, and it was the bigger one.

## The gap

When the prime gains a migration, the cascade copies the **file** into every
clone's repository automatically. Nothing applied it to the clone's
**database**.

`fleetMigrationSync` has existed and worked the whole time. Its only caller was
a button on an admin page. So a fleet stayed in step with the prime exactly as
often as somebody remembered to press it — the same shape as every other defect
this programme has turned up: a capability that ships, reports green, and is
never invoked.

That is the ceiling on how many clones this platform can carry. One clone is a
click. Ten is a chore nobody does on the day it matters. The schema drifts, the
clone's edge functions start naming columns it does not have, and the symptom
arrives as PostgREST `42703`s inside a tenant's application rather than as
anything anyone here would recognise as a missed migration.

## Why Mission Control drives it, and not each clone's CI

The obvious alternative is to put the apply-on-merge workflow in every clone
repository too. It does not scale, for three concrete reasons:

- **N copies of the most dangerous credential.** The Management API token
  reaches every project in the organisation. Per-repo CI means it is configured
  in N repositories, each with its own project ref, and each ref is a chance to
  name the wrong tenant.
- **Clone repositories are mirrors.** The cascade overwrites them.
  `apply-migration.yml` is already in `DEFAULT_MIRROR_EXCLUSIONS` for exactly
  that reason, so a workflow living there is a file the cascade must be told to
  leave alone — one more thing to remember per clone.
- **Only Mission Control knows the fleet.** A clone's repository does not know
  which Supabase project it belongs to. `clone_backends` does.

Mission Control already holds one token that reaches every project, the project
ref for every clone, an idempotent applier (`applyPrimeMigrations`, which unions
both ledgers on the clone and skips what is applied), and a worker system. The
scalable answer is to use them.

| | Mission Control's own schema | the fleet |
| --- | --- | --- |
| targets | 1 project | N projects |
| driver | GitHub Actions on merge | `/hooks/fleet-migration-sync`, every 30 min |
| credential | one repo secret | the token Mission Control already has |
| failure is visible as | a red check on the commit | an operator notification, per clone |

## What the worker does

`runFleetMigrationSync` — one engine, two callers. The admin button and the cron
job both go through it, so they can never become two implementations of "sync
the fleet".

Each run:

1. **Reclaims stale claims.** `worker_started_at` is the claim, and reusing it is
   safe rather than lucky: the backend-provisioning drain claims `pending` and
   reclaims `pending`/`provisioning`/`migrating`/`seeding_admin`. It never looks
   at a `ready` row, which is the only status this touches.
2. **Counts what is not eligible**, before taking a batch.
3. **Takes a bounded slice** — five clones, ordered by how far behind they are,
   nulls first. A fleet-wide loop in one invocation is the shape that timed out
   the first mirror cascade at exactly 60,000 ms.
4. **Reads the prime's migrations once**, not per clone.
5. Per clone: **claim → apply → record → release**. The claim filter carries
   `worker_started_at is null`, so two overlapping runs cannot both take the same
   clone. pg_cron does not serialise its own job, and applying one migration
   twice concurrently is how a clone gets marked `failed` by a duplicate-object
   error it never really had.

## A clone falling out of the fleet is now loud

When a migration fails on a clone, its backend goes to `failed` — which takes it
out of the eligible set, so the next run will not see it. That is the right
behaviour and the wrong silence: without something saying so, the clone simply
stops receiving schema changes and nothing anywhere reports it.

Two things make it visible now. An operator notification names the clone, the
migration and the consequence in plain terms. And every run reports `excluded` —
the count of backends outside the eligible query — so "5 processed" can never be
read as "the fleet is in step" while three clones sit outside it.

## Three reads that must not be misread as emptiness

- a candidate list that could not be read → the run reports an error, never
  "0 clones, nothing to do";
- a claim that **errored** → recorded as a failure, never treated as a lost
  race. Conflating those is what left the screening consumer's claim looking
  like contention for months while it had never once succeeded;
- a clone that threw before any verdict → the claim is released and the status
  is left alone, because guessing a schema verdict is worse than retrying.
