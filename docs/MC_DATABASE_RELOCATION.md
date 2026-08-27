# Moving Mission Control off Lovable Cloud

Status: **researched, decision pending.** The blocker this document previously
named has been resolved by research — connecting your own Supabase is
officially supported and the application stays hosted on Lovable. What remains
is a decision, not an unknown.

Read this before touching `.github/workflows/apply-migrations.yml`,
`.github/scripts/apply-migrations.mjs`, or anything that assumes Mission
Control's database can be addressed by the Supabase Management API.

## Why this came up

Every migration merged into `main` has to be applied to Mission Control's
database **by hand**. The workflow built to do it automatically (PR #73) has
failed on every run since it was created, and its original message —
"SUPABASE_ACCESS_TOKEN is not set" — was misleading. Adding the secret could
not have helped.

Measured here:

```
list_projects (this account's Supabase auth) → 4 projects
  moeyytuduycrvvncdtme   Aurixa Systems
  erxksncxitczkrluvsgb   Lazarus
  dduzbchuswwbefdunfct   NPC Property Dashboard        ← the prime
  plisdzywzleljorrphxv   aurixa-clone-npc-client-…     ← the clone

get_project('fgpvagejkaeqedcwvbte')
  → "You do not have permission to perform this action"
```

Confirmed verbatim by Supabase's own documentation on identifying a Lovable
backend:

> You won't see this project in your Supabase Dashboard, and you won't have
> access to service role keys or direct database URLs.

`fgpvagejkaeqedcwvbte` is Mission Control's database, and it is a Lovable Cloud
project in Lovable's Supabase organisation. `moeyytuduycrvvncdtme` ("Aurixa
Systems") is *not* it — no `clones`, no `prime_config`, no `cascade_events`, a
12-row ledger.

## What the status quo costs

**52 migrations were added to this repository in August 2026 alone** — roughly
two a day. Every one is a hand-apply against `mcp__Lovable__query_database`
plus a manual ledger stamp. The cost is not the minutes; it is that a step a
person has to remember is a step that eventually gets forgotten, and a clone
fleet whose control plane has silently drifted from its migrations is the
failure this platform has spent the week removing everywhere else.

## CORRECTION: this is not a hosting migration

An earlier revision of this document concluded that because Lovable reserves
the `SUPABASE_` environment-variable prefix, a Lovable-hosted app "very likely
cannot be pointed at a foreign Supabase project", and therefore that moving the
database implied moving the hosting.

**That was wrong.** Lovable's own documentation describes connecting your own
Supabase project as a supported feature, with the app still hosted on Lovable:

> Link your organization (workspace admins only): Connectors → Supabase, then
> authorize your Supabase organization. In the editor, open More → Cloud, select
> your Supabase project, and confirm.

The reserved prefix is a consequence of Lovable managing the Cloud backend, not
a barrier to replacing it. Once your own Supabase is connected, Lovable's docs
state that authentication settings, edge functions and secrets all live in your
Supabase project.

`src/server/hosting/` remains available if leaving Lovable is ever wanted for
other reasons. It is not required for this.

## The supported path

Lovable added export/pause/remove in July 2026.

**Export** — Cloud → Overview → Advanced settings → Export project data.

> The export includes your full database, both structure and data.

It **excludes** storage-bucket files, edge-function code, and project secrets.
Storage is exported separately from Cloud → Storage. Exports are **limited to
5 GB, one per 24 hours** — this database is 632 MB, comfortably inside that.

**Remove** — Cloud → Overview → Advanced settings → Remove Lovable Cloud.

> Removing Lovable Cloud permanently deletes your Cloud instance and cannot be
> undone.

**Cloud and your own Supabase cannot coexist.** Cloud must be removed before
the project can be pointed at your own Supabase, and Lovable is explicit that
there is "no automatic migration between the built-in backend (Cloud) and your
own Supabase project, in either direction."

So the order is **export → build the target → verify → remove → connect**, and
the verification has to be complete *before* the irreversible step, because
after it there is nothing to fall back to.

## An unresolved conflict about passwords

Lovable's Advanced-settings documentation says user passwords "are not exported
in usable form." A widely-cited third-party migration guide claims the opposite
— that the export is a `pg_dump` and therefore carries `auth.users` bcrypt
hashes intact.

**Not worth resolving.** There are **3 auth users**. Plan for a password reset
for all three and treat surviving hashes as a bonus. Assuming hashes survive,
and finding out after the irreversible step that they did not, is the expensive
order to be wrong in.

## Inventory (measured, 2026-08-27)

| | |
| --- | --- |
| database size | **632 MB** (export limit is 5 GB) |
| tables (`public`) | 173 (219 across all schemas) |
| functions / enums / policies | 145 / 55 / 342 |
| cron jobs | **32** |
| auth users | **3** |
| storage buckets / objects | 4 / **0** |
| extensions | citext, pg_cron, pg_net, pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp |
| vault secrets | `cron_secret`, `public_app_url`, `storefront_catalog_sync_url`, `storefront_catalog_sync_token` |
| encrypted rows (`CREDENTIALS_ENC_KEY`) | 1 `clone_backend_secrets`, 1 `clone_api_keys` |
| new Supabase project cost | **$10/month** (org `Xenochrome 3`, Pro) |

Size is concentrated, which matters for how long the copy takes:

| table | rows | size |
| --- | --- | --- |
| `codex_findings` | 176,424 | **178 MB** |
| `module_backend_artifacts` | 34,794 | 24 MB |
| `audit_log` | 21,090 | 6 MB |
| everything else | — | ~25 MB |

`codex_findings` is 28% of the database and is security-scan output with a
natural retention story. Pruning it first is the biggest lever, and reversible
in a way the cutover is not.

## Do not plan from Lovable's table browser

Its row counts are read **through RLS as the signed-in user**:

| table | Lovable UI | actual |
| --- | --- | --- |
| `audit_log` | 407 | **21,090** |

A screen full of "0 rows" is not an empty database. Count with
`mcp__Lovable__query_database`, which runs privileged.

## What will bite

**Secrets do not export — and one of them is load-bearing.** Every secret must
be re-entered by hand. `CREDENTIALS_ENC_KEY` must be carried over **exactly**:
`crypto.server.ts` encrypts stored credentials with it, and a changed key makes
existing ciphertext undecryptable. Only 2 rows are encrypted today, so the
blast radius is small *now* and grows with every clone.

**`cron_secret` must keep its exact value.** The deployed application checks
it; guessing breaks all 32 jobs at once, which this platform has already had
happen.

**Vault secrets are project-scoped.** `vault.decrypted_secrets` is a view over
an encrypted store — all four must be recreated on the new project *before* the
cron jobs are scheduled, or every job 401s.

**The 32 cron jobs must be recreated, not restored**, and they embed Mission
Control's public URL. Re-run the repository's scheduling migrations.

**Lovable regenerates the Supabase clients.** `src/integrations/supabase/client.ts`
and `client.server.ts` both carry "This file is automatically generated. Do not
edit it directly." Connecting your own Supabase rewrites them, and a documented
trap in this exact migration is that doing so can break SSR. Diff both after
connecting, before assuming the app is fine.

**`VITE_SUPABASE_URL` is baked at build time** and `.env` is tracked in git
(publishable values only). Repointing the browser is a rebuild plus a repo
change, not a settings toggle.

## Staged plan

Nothing is destructive until Stage 5. Each stage ends in a verification
asserted **by effect**.

1. **Prune.** Retention on `codex_findings` and `module_backend_artifacts`.
   Verify: size re-measured.
2. **Provision the target** in org `nchuigmqbfcdhdgplrxq` ($10/mo). Enable the
   eight extensions. Verify: `pg_extension` matches.
3. **Load it.** Either restore Lovable's export, or have Mission Control copy
   itself using the machinery it already has — `provisionCloneBackend` for the
   schema, `runSqlOnProject` for either side, and the reference-data copier's
   budgeted keyset-cursor shape for the rows, minus the allow-list because
   source and target are the same tenant.
4. **Verify against the source, hard.** Per-table row counts; an md5
   `pg_policies` fingerprint matched the way clone/prime parity already is; the
   four vault secrets recreated; the three operators able to actually log in;
   one `net.http_post` to a hook returning 200. **This gate must pass before
   Stage 5**, because Stage 5 destroys the fallback.
5. **Remove Lovable Cloud and connect your own Supabase.** Irreversible.
6. **Repair what did not travel.** Re-enter every secret (`CREDENTIALS_ENC_KEY`
   byte-for-byte), re-run the scheduling migrations for the 32 cron jobs, diff
   the regenerated `client.ts` / `client.server.ts`, rebuild so the baked
   `VITE_SUPABASE_URL` points at the new project.
7. **Re-enable the pipeline.** Repository secret `SUPABASE_ACCESS_TOKEN` and
   repository **variable** `SUPABASE_PROJECT_REF` (read as `vars.`, not
   `secrets.`) set to the new ref. Add `fgpvagejkaeqedcwvbte` to
   `FORBIDDEN_REFS`. Verify by effect: merge a trivial migration and watch it
   land with no hand-apply.

## Rollback

Until Stage 5 the old database is untouched and rollback is "stop". After Stage
5 there is no rollback — the Cloud instance is deleted. That asymmetry is the
whole reason Stage 4 exists.

## Until then

Migrations merged to `main` are applied by hand against
`mcp__Lovable__query_database` and recorded in
`supabase_migrations.schema_migrations`. The workflow says so rather than
asking for a secret that cannot help.

## Sources

- Supabase — [Identifying Lovable backend: Lovable Cloud or Supabase](https://supabase.com/docs/guides/troubleshooting/identify-lovable-cloud-or-supabase-backend)
- Lovable — [Connect to Supabase](https://docs.lovable.dev/integrations/supabase)
- Lovable — [Advanced settings](https://docs.lovable.dev/features/advanced-settings)
- Third-party, unverified — [lovable-cloud-to-supabase-migration](https://github.com/CarolMonroe22/lovable-cloud-to-supabase-migration) (source of the password-hash claim that contradicts Lovable's own docs, and of several of the traps above; treat as leads to verify, not authority)
