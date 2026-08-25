# The prime is two things, and one of them had no address

`prime_config` describes the prime. Every path that reads it was correct about
one half and wrong about the other, for as long as the clone pipeline has
existed.

| Half | Question it answers | Where it comes from |
| --- | --- | --- |
| The prime **repo** | which migrations, which edge functions, which config.toml | `prime_config.github_owner` / `github_repo`, fetched over the GitHub API |
| The prime **backend** | which live catalogue to copy, which ledger to stamp from, which buckets, cron jobs and realtime publication to replicate | **nothing — it had no column** |

The missing half was filled by `getPrimeProjectRef()`:

```ts
// Derive the prime project's ref from the server-side Supabase URL.
export function getPrimeProjectRef(): string {
  const url = process.env.SUPABASE_URL;
  ...
}
```

`SUPABASE_URL` is **this deployment's own project** — the database holding
`clones`, `prime_config` and `cascade_events`. It is what `supabaseAdmin`
connects to, what the auth middleware validates against, and what the browser
client uses. There is exactly one, and it is Mission Control's own.

So "replicate from the prime" meant "replicate from Mission Control" at every
one of these call sites:

- `replicateSchemaByIntrospection` — the **default** clone schema strategy. A
  clone would receive Mission Control's admin schema instead of the product's.
- `stampMigrationLedgerFromPrime` — the clone's ledger would record Mission
  Control's migration IDs, which no product migration can ever match.
- `replicateStorageBuckets` — Mission Control's buckets and seed assets.
- `replicateCronJobs` — Mission Control's pg_cron schedule, which would have
  pointed a **clone's** jobs at Mission Control's own `/hooks` endpoints.
- `replicateRealtimePublication` — Mission Control's publication.
- `computeParity`, at all three of its callers — every handoff parity report
  diffed a clone against Mission Control's schema, making each one a large and
  entirely bogus diff.

## Why nothing reported it

A wrong source that is *reachable* produces a confident, complete, wrong
result. Every one of these steps succeeded. The status messages said
"Replicating storage buckets from prime", the parity reports rendered, and the
introspection reconciled — against the wrong prime, which reconciles perfectly
well against itself.

The module's own header describes the prime product accurately (949 migration
files, 853 tracked, 546 tables materialised out of band). The intent was never
in doubt; only the resolution was wrong. That is why reading the code did not
find it and following the data did.

## The rules now

**The prime backend is configuration, not derivation.**
`prime_config.supabase_project_ref` holds it, and `resolvePrimeBackendRef()` is
the only reader. There is no fallback: an unset value throws, naming the
setting. `SUPABASE_URL` is always present, so any fallback silently succeeds
against the wrong database — which is exactly what happened.

**A wrong database is worse than no database.** `resolvePrimeBackendRef()` also
refuses a ref equal to this deployment's own, and
`replicateSchemaByIntrospection` refuses it a second time. The second guard is
not redundant: it is the last point before 500-odd tables are written, and once
they are written a wrong source is indistinguishable from a right one.

**A ledger stamp is not a finishing touch.** `stampMigrationLedgerFromPrime`
throws on an empty prime ledger, and its caller no longer wraps it in
`.catch(() => ({ stamped: 0 }))`. Without the stamp the clone has a schema and
no recorded versions, so `migration-sync` computes the entire corpus as pending
and replays it from migration #1 against objects that already exist. It fails
identically on every retry, and the message blames the migration.

**That state is now named rather than discovered.**
`cloneLedgerState.pure.ts` distinguishes four cases — `fresh` (empty project,
replay), `ok` (behind or at head, replay), `unstamped` (schema present, ledger
empty) and `foreign` (a ledger sharing nothing with the corpus, i.e. stamped
from the wrong project). The last two refuse the sync and name the repair.
Partial overlap is deliberately `ok`: that is what "behind" looks like, and
only zero overlap is evidence of a wrong source.

**The repair is an operator action, never automatic.**
`restampCloneMigrationLedger` records the prime's versions without running
them. It is `on conflict do nothing`, so it is safe to press twice and a no-op
on a healthy clone. It does **not** verify the clone's schema matches — that
claim can only be made by the person repairing a clone they know was
introspected. A clone that is genuinely behind must sync, not stamp.

## What this did NOT affect

Clone backends were never given Mission Control's *migration corpus*.
`applyPrimeMigrations` replays the migrations of the repo named in
`prime_config`, fetched over the GitHub API — it never reads
`supabase/migrations/` from this repository. The corpus defect recorded in
`scripts/check-migration-replay.mjs` is about rebuilding **this** database and
says nothing about clones. Verified empirically: the one live clone backend
carries 533 product tables (`abs_census_cache`, `agency_agreements`, 39 report
tables) and none of `clones`, `prime_config`, `cascade_events`.

## Before this can run

Set `prime_config.supabase_project_ref` to the prime **product's** Supabase
project. Until it is set, clone-backend provisioning and parity refuse with a
message naming the setting — deliberately, rather than proceeding against a ref
that happens to be reachable.
