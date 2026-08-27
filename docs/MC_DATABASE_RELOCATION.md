# Moving Mission Control off Lovable Cloud

Status: **planned, not started.** Two prerequisites are unresolved and both are
outside this repository. Read this before touching
`.github/workflows/apply-migrations.yml`, `.github/scripts/apply-migrations.mjs`,
or anything that assumes Mission Control's database can be addressed by the
Supabase Management API.

## Why this came up

Every migration merged into `main` has to be applied to Mission Control's
database **by hand**. The workflow built to do it automatically (PR #73) has
failed on every run since it was created:

```
Added: supabase/migrations/20260827090000_clone_reference_syncs.sql
##[error]SUPABASE_ACCESS_TOKEN is not set.
```

That message is misleading. Adding the secret would not fix it, because the
workflow rests on a premise nobody checked: **that Mission Control's own
database is a Supabase project this account can address.** It is not.

Measured, not assumed:

```
list_projects (this account's Supabase auth) → 4 projects
  moeyytuduycrvvncdtme   Aurixa Systems
  erxksncxitczkrluvsgb   Lazarus
  dduzbchuswwbefdunfct   NPC Property Dashboard        ← the prime
  plisdzywzleljorrphxv   aurixa-clone-npc-client-…     ← the clone

get_project('fgpvagejkaeqedcwvbte')
  → "You do not have permission to perform this action"
```

`fgpvagejkaeqedcwvbte` is Mission Control's database. It is a **Lovable Cloud**
project, living in Lovable's Supabase organisation. `moeyytuduycrvvncdtme`
("Aurixa Systems") is *not* it — it has no `clones`, no `prime_config`, no
`cascade_events`, and a 12-row migration ledger.

This is also why every operation against Mission Control's database in this
repository's tooling goes through Lovable rather than through Supabase.

## The two prerequisites

Neither can be resolved from inside this repository.

### 1. A direct Postgres connection to `fgpvagejkaeqedcwvbte`

The database is **632 MB**. Nothing that reads rows into an agent's or an
operator's memory can move it; this needs `pg_dump` against a real connection
string. Lovable's **Cloud → Database** panel is the only place that could
expose one.

If Lovable does not expose a connection string or a database password, this
plan cannot proceed as written and the fallback is a schema-only rebuild plus a
selective data copy of the tables that matter — which loses the audit history.

### 2. Somewhere for the application to point

**This is the prerequisite most likely to be missed.** Lovable reserves the
`SUPABASE_` environment-variable prefix for itself — the error that surfaced
this whole question was Lovable refusing to let an operator create a secret
named `SUPABASE_ACCESS_TOKEN`, "reserved for internal Lovable-managed secrets".

Lovable owns `SUPABASE_URL` and the keys for a Cloud project. So a Lovable Cloud
app very likely **cannot be pointed at a foreign Supabase project**, which means
moving the database implies moving the hosting too:

> **Relocating Mission Control's database is not a database task. It is moving
> Mission Control off Lovable.**

That is not necessarily bad news. This repository already contains the hosting
provider layer it would need — `src/server/hosting/` with a Vercel provider, an
env policy and a DNS target — because that is exactly what was built to deploy
the clones. Mission Control would become the first tenant of its own hosting
system, which is a good test of it and a bad thing to discover halfway through.

## Inventory (measured, 2026-08-27)

| | |
| --- | --- |
| database size | **632 MB** |
| tables (`public`) | 173 (219 across all schemas) |
| functions | 145 |
| enums | 55 |
| RLS policies | 342 |
| cron jobs | 32 |
| auth users | **3** |
| storage buckets / objects | 4 / **0** |
| extensions | citext, pg_cron, pg_net, pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp |
| vault secrets | `cron_secret`, `public_app_url`, `storefront_catalog_sync_url`, `storefront_catalog_sync_token` |
| edge functions in repo | 1 |
| migrations in repo | 209 |

Size is concentrated, which matters for the cutover window:

| table | rows | size |
| --- | --- | --- |
| `codex_findings` | 168,389 | **177 MB** |
| `module_backend_artifacts` | 34,794 | 24 MB |
| `audit_log` | 18,901 | 6 MB |
| everything else | — | ~25 MB |

`codex_findings` alone is 28% of the database and is security-scan output with
a natural retention story. Pruning it before the cutover is the single biggest
lever on downtime, and it is reversible in a way the cutover is not.

## The three things that will bite

**Auth users do not move with a schema dump.** Only 3 accounts, so the cheap
answer is to recreate them and have each operator reset their password. Trying
to copy `auth.users` hashes across projects is possible and is not worth the
risk for three rows.

**Vault secrets are encrypted with a project-scoped key.** They do not survive a
dump — `vault.decrypted_secrets` is a view. All four must be re-created by hand
on the new project *before* the cron jobs are scheduled, or every job 401s.
`cron_secret` in particular must keep its exact current value, because the
deployed application checks it: guessing it breaks all 32 jobs at once, which is
the failure this repository has already had.

**The 32 cron jobs must be re-created, not restored.** They live in
`cron.job`, they embed the vault read in their command, and they point at
Mission Control's public URL. Re-running the repository's scheduling migrations
against the new project is the way to get them, not a dump.

## Staged plan

Each stage ends in a verification that is asserted **by effect**, never by
configuration. No stage is destructive until Stage 6.

1. **Resolve prerequisite 1.** Obtain a connection string from Lovable. If none
   exists, stop and re-plan — do not start a partial move.
2. **Resolve prerequisite 2.** Establish whether Lovable can point this project
   at an external Supabase. If it cannot, this becomes a hosting migration and
   the plan needs a Vercel deployment stage inserted here.
3. **Prune.** Apply retention to `codex_findings` and
   `module_backend_artifacts`. Verify: database size re-measured.
4. **Provision the target** in org `nchuigmqbfcdhdgplrxq`. Enable the eight
   extensions. Verify: `pg_extension` matches the list above.
5. **Dry-run the move.** `pg_dump` → restore into the target. Recreate the four
   vault secrets and the three operators. Re-run the scheduling migrations.
   Verify by effect: table count, row counts per table against the source,
   `pg_policies` fingerprint matched by md5 the way clone/prime parity already
   is, and one `net.http_post` to a hook returning 200.
6. **Cut over.** Freeze writes, final incremental dump, repoint the application,
   swap DNS. This is the only irreversible stage.
7. **Re-enable the pipeline.** Set the repository secret
   `SUPABASE_ACCESS_TOKEN` and the repository **variable**
   `SUPABASE_PROJECT_REF` (it is read as `vars.`, not `secrets.`) to the new
   ref. Add the old Lovable ref to `FORBIDDEN_REFS` in
   `.github/scripts/apply-migrations.mjs`. Verify by effect: merge a trivial
   migration and watch it land without a hand-apply.

## Rollback

Until Stage 6 the old database is untouched and rollback is "stop". After Stage
6 it is repointing the application back and replaying anything written in the
gap — which is why Stage 5 must have been rehearsed end to end, and why the
write freeze in Stage 6 is not optional.

## Until then

Migrations merged to `main` are applied by hand against
`mcp__Lovable__query_database`, and the version is recorded in
`supabase_migrations.schema_migrations` afterwards. The workflow's error message
should be changed to say so rather than asking for a secret that cannot help —
see `docs/MIGRATION_PIPELINE.md`.
