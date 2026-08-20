# Cloning pipeline — gaps found by cloning a prime by hand

August 2026. `npc-property-dashbord` was cloned to `npc-client-dashboard`
manually, end to end: repository, schema, edge functions, secrets. This
records what that exercise found when measured against the pipeline in
`src/server/backend-provisioning.server.ts`.

Everything below is evidence, not review. Counts come from the two live
projects (`dduzbchuswwbefdunfct`, `plisdzywzleljorrphxv`); line references are
to this repository.

**The headline: the pipeline cannot currently clone this prime at all**, and
several of the checks that would have caught that measure the wrong thing.
The parts it does cover it covers well — cron rewriting, storage seed assets,
auth policy, realtime membership and the `_shared` bundling are all sound.

---

## 1 · BLOCKING — the only schema path is a migration replay that cannot run

`applyPrimeMigrations` (`backend-provisioning.server.ts:1145`) replays
`supabase/migrations/**` from the prime's repository in filename order, and
`provisionCloneBackend:2094` throws on the first failure. That is the correct
posture. The problem is that the first failure is **migration #1**:

```
ERROR: 42P01: relation "client_activities" does not exist
```

The prime's migration history does not construct the prime's schema. It
assumes base tables that no migration in the repository creates —
`DROP POLICY IF EXISTS … ON client_activities` guards the policy, not the
table. The ledger and the repository have also drifted apart: **949 migration
files on disk against 853 tracked**, and **546 live tables materialised out of
band**.

So no clone of this prime can ever reach step 5. Every attempt burns a
Supabase project slot and halts.

**A replay of a repo's migrations is not a clone of a database.** It
reproduces the history someone wrote down, not the schema that exists. The
gap is not a bug in the replay; it is that the replay is the *only* path.

### What worked instead

Introspecting the prime's live catalog over the Management API and applying
generated DDL to the clone, in dependency order, reconciling each stage:

| Stage | Result |
| --- | --- |
| enum types | 94 / 94 |
| tables | 641 / 641, column signature md5-identical |
| functions | 491 / 491 (three passes — see §7) |
| constraints | 2,560 / 2,560, name-set md5-identical |
| indexes | 2,136 / 2,136 |
| views / matviews | 13 / 1 |
| triggers | 472 / 472 |
| RLS policies | 1,149 / 1,149 |
| storage buckets | 32 / 32, 0 objects |

Total DDL moved: **1.58 MB**. The whole transfer takes minutes and needs only
the Management API — no database password, no open Postgres port.

**Recommendation.** Add a catalog-introspection path and prefer it; keep the
migration replay for module migrations and for priming the ledger. The clone's
`supabase_migrations.schema_migrations` can be stamped with the prime's
applied list afterwards so future incremental migrations still apply.

---

## 2 · SECURITY — per-deployment identity secrets are copied verbatim

`extractSecretNames` (`prime-backend.server.ts:245`) correctly drops
`SUPABASE_*`. But `INTERNAL_EDGE_SECRET` and `CSRF_TOKEN_PEPPER` are ordinary
`Deno.env.get()` names, so they are shelled like any vendor key, and
`syncCloneSecrets` (`backend-provisioning.server.ts:1574`) writes whatever
value it inherits. **Nothing in the repository regenerates them** — a grep for
either name outside test files returns nothing.

`INTERNAL_EDGE_SECRET` is what the prime's cron jobs sign internal function
invocations with. Copying it means a request signed for one deployment is
valid on every other one, in both directions. `CSRF_TOKEN_PEPPER` has the same
shape: tokens become interchangeable across tenants.

These are **identities, not credentials**. A vendor API key is shared on
purpose — that is the forwarded-key billing model. A signing secret is the
opposite: its value is that only one deployment holds it.

**Recommendation.** Classify shelled secrets three ways rather than two:

| Class | Action |
| --- | --- |
| platform (`SUPABASE_*`) | never copy — already correct |
| **identity** (`INTERNAL_EDGE_SECRET`, `CSRF_TOKEN_PEPPER`, anything `*_SECRET`/`*_PEPPER` signing local tokens) | **generate fresh per clone** |
| deployment config (`ALLOWED_ORIGINS`, `APP_URL`, `APP_BASE_URL`) | derive from the clone's own origins — copying names the prime's domain |
| vendor credentials | inherit — current behaviour |

The manual clone generated 32 random bytes for each identity secret and
verified the values differed from the prime's before finishing.

---

## 3 · SECURITY — the clone repository is left primed to deploy into the prime

The repository is created with `createFork` / `createUsingTemplate`
(`clone-provisioning.functions.ts:118,130`) — a byte copy. Nothing rewrites it
afterwards. Three artefacts therefore arrive naming the **prime's** project:

| Artefact | Effect |
| --- | --- |
| `supabase/config.toml` → `project_id` | `rotate-internal-edge-secret` and `aml-sanctions-refresh` (a **daily cron**) resolve their target by reading this line |
| `.github/workflows/deploy-supabase-functions.yml` (×2) and `apply-migration.yml` | `${{ vars.SUPABASE_PROJECT_REF \|\| '<prime ref>' }}` — and the deploy workflow runs on **every push to `main`** |
| `supabase/.temp/linked-project.json` | checked in, holds `{"ref":"<prime>"}`; any bare `supabase …` command resolves from it whatever `config.toml` says |

`SUPABASE_PROJECT_REF` appears **nowhere** in this repository, so the variable
that would override the default is never set on a clone. `linked-project`
appears nowhere either.

What stops this today is that Mission Control pushes only Codex secrets
(`github-secrets.server.ts:258`) — `SUPABASE_ACCESS_TOKEN` is never written to
a clone repo. So the workflows fail loudly instead of acting. On the manual
clone the run of 19 Aug 10:18 UTC shows `TOKEN:` empty → *"nothing was
deployed"*, exit 1.

**That is protection by absent credential, not by correct configuration.**
Adding that token — the obvious step when wiring a clone to deploy its own
functions — is by itself enough to point a clone's edge-function deploys and
migrations at the prime's production.

**Recommendation.** After the repo is created, and before it is handed over:
set `SUPABASE_PROJECT_REF` as a repo **variable** to the clone's ref, rewrite
`config.toml`'s `project_id`, delete `supabase/.temp/`, and rewrite the
workflow defaults to fail closed. There is no safe default for "which
project": an unset variable is a question, not a licence to guess.

---

## 4 · The parity engine measures tables but not what holds them together

`handoff-parity.server.ts` snapshots tables and columns, RLS, policies,
functions, extensions, buckets, cron, edge-function slugs, secret names, auth
config, realtime membership, grants, enums and triggers. That is a lot, and
most of it is right.

It captures **no indexes, no constraints, no materialized views and no
sequences** — grep for `pg_indexes`, `pg_constraint`, `relkind='m'` returns
zero hits.

Those are not details. The half-built clone had **2 constraints against the
prime's 2,560, and 2 indexes against 2,136** — no primary keys, no foreign
keys, no uniqueness — while every table and column matched. Parity would have
reported that clone as sound.

One materialized view (`pdf_import_cost_daily`) is likewise invisible: it is
`relkind='m'`, so every table query misses it, and the index that belongs to
it fails to create with a message about a relation that "does not exist".

**Recommendation.** Add constraints (by `conname` per table), indexes (by
`indexname`), matviews and sequences to the snapshot. Compare constraint and
column **sets by hash**, not counts — an md5 over the sorted set catches a
rename that a count cannot.

---

## 5 · Parity is never run by provisioning

`handoff-parity` is reachable only from `handoffs.functions.ts` and
`hooks.handoff-parity-refresh.tsx`. `provisionCloneBackend` never calls it.

So the pipeline's definition of success is that **every step it ran reported
success** — not that the result matches the prime. That is exactly the mistake
the manual clone made: it applied 528 tables with zero failures and reported
done, while the prime had 641. Reconciling the two numbers was one query, and
nothing ran it.

**Recommendation.** Run parity as the last step of provisioning and record the
result on the backend row. A clone that provisions "successfully" with unmet
parity should be visibly incomplete, not green.

---

## 6 · `REQUIRED_EXTENSIONS` names an extension that does not exist

`backend-provisioning.server.ts:955`:

```ts
export const REQUIRED_EXTENSIONS = ["pgcrypto","pg_net","pg_cron","pg_graphql","vault"];
```

Checked against a live project:

```
pgcrypto => AVAILABLE   pg_net => AVAILABLE   pg_cron => AVAILABLE
pg_graphql => AVAILABLE  vault => DOES NOT EXIST
```

It is `supabase_vault`. `enforceRequiredExtensions` is non-fatal per
extension, so this records a failure and provisioning continues — leaving a
clone with no vault, which is what the cron auth and the secret-decryption
helpers read.

The list is also missing three extensions the prime actually uses:
**`vector`**, `uuid-ossp` and `pg_stat_statements`. `vector` is the one that
bites: `agent_semantic_memories` and `document_chunks` carry embedding
columns, and a migration creating one fails outright without it. It also
brings 118 functions of its own, which will read as a function-parity
difference until it is installed.

**Recommendation.** Fix the spelling and derive the list from the prime's
`pg_extension` rather than hard-coding it. A hard-coded list drifts silently;
the prime already knows the answer.

---

## 7 · Three things the DDL path has to do that a single pass does not

Found while applying 1.58 MB of generated DDL. Each produced a wrong result
that looked like a right one.

**`create table if not exists` does not repair an existing table.** After a
failed first attempt left 528 tables behind, the re-run skipped every one of
them and two kept a stale column set. Table counts matched while columns did
not. Reconcile columns by hash, and prefer `alter table … add column if not
exists` for tables that already exist.

**`LANGUAGE sql` functions are validated at creation.** One that calls another
fails if the callee is not there yet, and dependency order is not knowable
from the catalog. It took **three passes to converge: 12 failures, then 1,
then 0**. Any function stage must repeat until the failure count stops
falling, and only then report failure.

**`pg_indexes` counts constraint-backed indexes too.** Creating every row it
returns double-creates whatever the constraints already made. Filter to
indexes with no `pg_constraint.conindid`, and reconcile against the unfiltered
count.

---

## 8 · The prime's URL survives in two places cron rewriting does not reach

`rewriteCronCommand` (`:863`) rewrites prime hosts to the clone host in
`cron.job.command`, and re-schedules every job after replay. That is right,
and it is the part of this problem the pipeline already understood.

Two other places hold the same URL:

**Function bodies.** Four functions on the prime name it — `bootstrap_cron_vault`,
`dispatch_web_push_on_notification`, `dispatch_web_push_for_portal_notification`,
`invoke_pdf_parse_recover_stuck_jobs`. Each reads
`vault.decrypted_secrets` for `supabase_url` first and falls back to a
hardcoded prime URL **when the vault is empty — which is exactly a fresh
clone's state**. `bootstrap_cron_vault` is worse than a fallback: it *seeds*
the vault with the prime's URL literally, so calling it on a clone points that
clone at the prime permanently. No `prosrc` rewriting exists in the
provisioning path (`pg_proc` appears only in `handoff-parity`).

**The vault itself.** Nothing seeds the clone's own `supabase_url`. Until
something does, every one of those four falls through to the prime.

**Also:** 22 of the prime's migration files embed the prime's **anon JWT
inline** in `net.http_post` Authorization headers, across 15 endpoints
(`migration-dispatcher` ×12, `send-web-push` ×6, …). `rewriteCronCommand`
rewrites the host but not the key, so a rewritten job posts to the clone
carrying a token for the prime. Rewrite the key alongside the host, or resolve
both from the vault.

**Recommendation.** After schema replication: seed `vault.create_secret(<clone
url>, 'supabase_url', …)`, then rewrite any `pg_proc` body still containing
the prime ref and re-create it. The manual clone did both and finished with
**zero functions naming the prime**, verified by query.

---

## 9 · Smaller things worth knowing

- **Cloudflare fronts the Management API and rejects `python-urllib`'s
  User-Agent** with 403 `error code 1010`. Anything scripted against it needs a
  browser-or-curl UA. (Not a problem for this repository, which uses `fetch`.)
- **The Supabase CLI cannot deploy edge functions from behind an egress
  proxy** — `supabase functions deploy` returns `FunctionsApiTransportError`
  while the same multipart POST to `/v1/projects/{ref}/functions/deploy`
  returns 201. Worth knowing before anyone replaces the API call with the CLI.
- **The prime runs 9 edge functions that are not in its repository**, three of
  which (`manage-partner-agreements`, `finance-portal-agreements`,
  `agreement-centre-render`) that repo's own docs record as deliberately
  deleted; the rest are `-tmp`/`-diag`/`-probe` leftovers. Building the
  snapshot from the repository rather than from the prime's deployed list is
  **correct** and already what this pipeline does — worth stating so nobody
  "fixes" it toward the live list.
- **`groupFunctionPaths` ships the whole `_shared/**` tree with every bundle.**
  That is more robust than resolving each function's imports: a resolver keyed
  on `from` silently misses a bare `import './x.ts'`, which cost one function
  its bundle in the manual clone. Keep it. The cost is upload volume — 423
  functions over ~19 MB of shared source.
- **Region and Postgres version are not matched.** The manual clone landed in
  `ap-southeast-2` on PG 17.6 against a prime in `ap-southeast-1` on PG 17.4.
  Neither broke anything, but the pooler hostname is region-specific
  (`aws-1-ap-southeast-1…`), and a wrong-region guess returns
  `ENOTFOUND tenant/user`, which reads like a credential problem and is not.

---

## Suggested order

1. **§1 catalog introspection** — nothing else matters while no clone can be
   provisioned.
2. **§2 identity secrets** and **§3 repo re-targeting** — both are live
   cross-tenant exposure, and both are small.
3. **§6 extension list** — one spelling fix plus deriving the list.
4. **§4 + §5 parity** — add the missing object classes, then gate provisioning
   on it. These two together are what turn "every step succeeded" into "the
   result matches".
5. **§8 vault and function bodies**, **§7 convergence rules** — needed for the
   introspection path in §1 to be correct.
