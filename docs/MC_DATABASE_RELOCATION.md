# Moving Mission Control off Lovable Cloud

Status: **planned, not started.** One prerequisite remains and it is outside
this repository. Read this before touching
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

That message was misleading. Adding the secret would not have fixed it, because
the workflow rests on a premise nobody checked: **that Mission Control's own
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

## The move does not need a connection string

The obvious plan — get a Postgres URL from Lovable and `pg_dump` — is not
available. Lovable's **Cloud → Database** panel exposes a table browser, an RLS
viewer and a Backups button, and no connection string or database password.

It is also not necessary, because **Mission Control can already provision and
write to Supabase projects in this account's own organisation.** It holds
`SB_MGMT_API_TOKEN` and `SB_ORG_ID`, and it is what created
`plisdzywzleljorrphxv` in org `nchuigmqbfcdhdgplrxq`. The machinery to relocate
itself already exists and is already exercised in production:

| need | what already does it |
| --- | --- |
| create the target project | `provisionCloneBackend` |
| replicate 173 tables, 145 functions, 55 enums, 342 policies | catalogue introspection (`schema-introspection.server.ts`) |
| run arbitrary SQL on either project | `runSqlOnProject` |
| copy table data, budgeted and resumed on a keyset cursor | `reference-data.server.ts` |
| stamp the migration ledger on the target | `stampMigrationLedgerFromPrime` |

So the shape is: **Mission Control provisions its own new backend and copies
itself into it**, the same way it builds a clone — except the allow-list does
not apply, because source and target are the same tenant.

That is a far better route than a dump. It reuses code that is tested, it is
resumable by construction, and nothing has to pass through an operator's
machine.

## The prerequisite that remains

**Somewhere for the application to point.**

Lovable reserves the `SUPABASE_` environment-variable prefix for itself — the
error that surfaced this whole question was Lovable refusing to let an operator
create a secret named `SUPABASE_ACCESS_TOKEN`, "reserved for internal
Lovable-managed secrets". Lovable owns `SUPABASE_URL` and the keys for a Cloud
project.

So a Lovable Cloud app very likely **cannot be pointed at a foreign Supabase
project**, which means moving the database implies moving the hosting:

> **Relocating Mission Control's database is not a database task. It is moving
> Mission Control off Lovable.**

That is survivable. This repository already contains the hosting provider layer
it would need — `src/server/hosting/` with a Vercel provider, an env policy and
a DNS target — because that is exactly what was built to deploy the clones.
Mission Control would become the first tenant of its own hosting system, which
is a good test of it and a bad thing to discover halfway through.

**Open question for Lovable:** can a project be pointed at an external Supabase,
or is leaving Lovable Cloud the only way to stop it managing the database? The
answer decides whether Stage 5 below is "repoint" or "redeploy".

## Do not plan from Lovable's table browser

Its row counts are read **through RLS as the signed-in user**, so they are what
that session may see, not what the table holds:

| table | Lovable UI | actual |
| --- | --- | --- |
| `audit_log` | 407 | **21,090** |
| `codex_findings` | — | **176,424** |

A screen full of "0 rows" is not an empty database. Count with
`mcp__Lovable__query_database`, which runs privileged.

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
| `codex_findings` | 176,424 | **178 MB** |
| `module_backend_artifacts` | 34,794 | 24 MB |
| `audit_log` | 21,090 | 6 MB |
| everything else | — | ~25 MB |

`codex_findings` alone is 28% of the database and is security-scan output with
a natural retention story. Pruning it before the cutover is the single biggest
lever on how long the copy takes, and it is reversible in a way the cutover is
not.

## The three things that will bite

**Auth users do not come with a schema copy.** Only 3 accounts, so the cheap
answer is to recreate them and have each operator reset their password. Copying
`auth.users` hashes across projects is possible and is not worth the risk for
three rows.

**Vault secrets are encrypted with a project-scoped key.** They cannot be
copied — `vault.decrypted_secrets` is a view over an encrypted store. All four
must be re-created by hand on the new project *before* the cron jobs are
scheduled, or every job 401s. `cron_secret` in particular must keep its exact
current value, because the deployed application checks it: guessing it breaks
all 32 jobs at once, which is a failure this platform has already had.

**The 32 cron jobs must be re-created, not copied.** They live in `cron.job`,
they embed the vault read in their command, and they point at Mission Control's
public URL. Re-running the repository's scheduling migrations against the new
project is the way to get them.

## Staged plan

Each stage ends in a verification asserted **by effect**, never by
configuration. Nothing is destructive until Stage 5.

1. **Settle the hosting question.** Ask Lovable whether a project can point at
   an external Supabase. If not, insert a Vercel deployment stage before
   Stage 5 and treat this as a hosting migration.
2. **Prune.** Apply retention to `codex_findings` and
   `module_backend_artifacts`. Verify: size re-measured.
3. **Provision the target** in org `nchuigmqbfcdhdgplrxq` via the existing
   provisioning path, pointed at Mission Control instead of a clone. Enable the
   eight extensions. Verify: `pg_extension` matches the list above, and the
   behavioural identity probe (`clones` / `prime_config` / `cascade_events`)
   answers true.
4. **Copy, rehearsed.** Copy every table with the reference-data copier's shape
   — budgeted, keyset cursor, resumed — with no allow-list, because this is the
   same tenant. Recreate the four vault secrets and the three operators. Re-run
   the scheduling migrations. Verify by effect: per-table row counts matched
   against the source, an md5 `pg_policies` fingerprint matched the way
   clone/prime parity already is, and one `net.http_post` to a hook returning
   200.
5. **Cut over.** Freeze writes, run a final incremental copy, repoint or
   redeploy the application, swap DNS. This is the only irreversible stage.
6. **Re-enable the pipeline.** Set the repository secret
   `SUPABASE_ACCESS_TOKEN` and the repository **variable**
   `SUPABASE_PROJECT_REF` (it is read as `vars.`, not `secrets.`) to the new
   ref. Add the old Lovable ref `fgpvagejkaeqedcwvbte` to `FORBIDDEN_REFS` in
   `.github/scripts/apply-migrations.mjs`. Verify by effect: merge a trivial
   migration and watch it land without a hand-apply.

## Rollback

Until Stage 5 the old database is untouched and rollback is "stop". After Stage
5 it is repointing the application back and replaying anything written in the
gap — which is why Stage 4 must have been rehearsed end to end, and why the
write freeze in Stage 5 is not optional.

## Until then

Migrations merged to `main` are applied by hand against
`mcp__Lovable__query_database`, and the version is recorded in
`supabase_migrations.schema_migrations` afterwards. The workflow says so rather
than asking for a secret that cannot help — see `docs/MIGRATION_PIPELINE.md`.
