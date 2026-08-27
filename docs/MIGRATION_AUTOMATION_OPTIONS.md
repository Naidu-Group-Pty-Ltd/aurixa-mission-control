# Automating migrations against a Lovable Cloud database

Read this before proposing any mechanism that applies Mission Control's own
migrations. It records what was measured on 2026-08-27, what was tried, and why
the obvious design is rejected.

**Outcome: A and B were both built.** A is `docs/MIGRATION_ASSERTIONS.md` —
every migration declares a checkable effect and an hourly worker resolves it.
B is `docs/MIGRATION_QUEUE.md` — the queue and the `postgres`-owned drain.
C stays rejected for the reasons below. D was not needed.

## The problem, correctly sized

Migrations merged to `main` are applied to Mission Control's database by hand.
But the load is **not** 210 files:

| | |
| --- | --- |
| migrations in the repo | 210 |
| **Lovable-authored (UUID-named)** — Lovable applies these itself | **138** |
| **descriptively named — arrive by PR, nothing applies them** | **72** |

So the hand-apply load is **72 files, about 30/month, and it started in July
2026**. Roughly one a day, not two. Still worth fixing; smaller than it looked.

## The literal "Postgres option" does not exist

`psql` / `DATABASE_URL` from CI was the preferred plan. It is unavailable, and
this is settled by primary sources, not inference:

- Supabase's own docs, on identifying a Lovable backend: *"You won't see this
  project in your Supabase Dashboard, and you won't have access to service role
  keys or **direct database URLs**."*
- Lovable's Cloud → Database panel exposes a table browser, an RLS viewer and
  Backups. No connection string, no password.
- `get_project('fgpvagejkaeqedcwvbte')` with this account's PAT → **403**.

Every other automatable channel was probed and is blocked:

| candidate | verdict | evidence |
| --- | --- | --- |
| Supabase Management API | **BLOCKED** | 403 on this project |
| Extra PostgREST schemas (`cron`, `vault`) | **BLOCKED** | `PGRST106 — Only the following schemas are exposed: public, graphql_public` |
| Pre-existing DDL/`exec_sql` function | **BLOCKED** | none exists; the only dynamic-SQL definer is `cron_delivery_health`, read-only |
| Platform SQL endpoint on the project host | **BLOCKED** | `/pg/query`, `/database/query`, `/pg-meta/query`, `/sql` → 404 |
| Injected connection string under another name | **BLOCKED** | server reads only `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; no `DATABASE_URL`/`PG*` anywhere |
| Edge function reading `SUPABASE_DB_URL` | **BLOCKED for CI** | Lovable owns edge-function deploys for Cloud projects |
| pg_cron + pg_net self-poller | viable, **rejected** | works (`net.http_get` to GitHub raw → 200), but `EXECUTE`s repo text **as `postgres`**: repo write access becomes DB superuser-equivalent RCE |

## The obvious design — and why it is rejected

**Proposal:** a hand-applied `SECURITY DEFINER` function in `public` taking
migration SQL, `EXECUTE`ing it and stamping the ledger; `GRANT EXECUTE` to
`service_role`; driven by a cron-secret-gated `/hooks/*` route.

The SQL mechanics are sound. Verified on the live PostgreSQL 17.6:

- multi-statement `EXECUTE` works — a payload with a nested `DO $f$` and a
  `$fn$` function body applied fully (`rows=2, sum=3, fn=nested-ok`);
- `ALTER TYPE … ADD VALUE` inside a definer function **succeeds** (only
  *using* the value before commit fails, and the corpus never does);
- **0 of 210** files contain a statement that cannot run in a transaction.

It is rejected anyway, on three findings that were **empirically reproduced**.

### 1. The 8-second ceiling cannot be escaped, and every check for it lies

`authenticator` carries `statement_timeout=8s, lock_timeout=8s` (measured).
`service_role` has no override, so every PostgREST call inherits it.

The natural fix — `SET statement_timeout` in the function's `proconfig` — does
not work. `statement_timeout` is armed when the top-level statement begins and a
GUC change mid-statement does not re-arm it. Confirmed here: a definer function
with `SET statement_timeout='1s'` ran `pg_sleep(3)` to completion (`NOT_KILLED`),
proving the timer is not re-armed — so raising it cannot work either.

`current_setting('statement_timeout')` **inside** the function reports the new
value. Every way of verifying the fix from inside reports success. Only a
genuinely slow migration reveals it.

**117 of 210 migrations** do a top-level `CREATE INDEX` or `UPDATE public.…`
backfill — precisely the statements that exceed 8s on a 632 MB production
control plane.

### 2. The dominant failure mode writes no record

`EXCEPTION WHEN OTHERS` does **not** catch `57014 query_canceled`. An ordinary
SQL error writes its `failed` ledger row; a statement timeout propagates out and
writes nothing. Given (1), the timeout is the *most likely* failure, and it is
the one that bypasses the accountability the design rests on. (Fixable with an
explicit `WHEN query_canceled` handler — but only after (1) is solved.)

### 3. The runner silently un-hardens itself — and CI cannot see it

`ALTER DEFAULT PRIVILEGES` on this database grants `EXECUTE` on **every** new
`public` function to `anon` and `authenticated`. Measured:

```
default ACL, public functions:
  postgres=X | anon=X | authenticated=X | service_role=X
anon-executable public functions today: 77 of 145
```

So an explicit `REVOKE … FROM PUBLIC, anon, authenticated` is not hardening, it
is the only thing standing between this function and the browser bundle
(`VITE_SUPABASE_PUBLISHABLE_KEY` ships to clients).

Two facts make that unacceptable to rely on:

- **`CREATE OR REPLACE` preserves the REVOKE; `DROP` + `CREATE` does not.** Any
  future signature change to the runner — adding `p_sha256`, say — applied
  *through the runner* restores `anon=X` and `=X` (PUBLIC), and the call
  **returns success**. Arbitrary `EXECUTE`-as-`postgres` becomes callable with
  the publishable key. CI cannot detect it: catching it requires reading
  `pg_proc.proacl`, and PostgREST exposes only `public` and `graphql_public`.
- **This repository gets that REVOKE wrong 71% of the time.** Of 45
  `REVOKE ALL ON FUNCTION` statements in the corpus, only **13** name
  `authenticated`:

  ```
  21  FROM PUBLIC, anon
  13  FROM PUBLIC, anon, authenticated
   9  FROM PUBLIC / public
  ```

  The most recent instance, `cron_delivery_health`, is `FROM PUBLIC, anon` —
  missing `authenticated`. `REVOKE FROM PUBLIC` does not remove the explicit
  `authenticated=X` entry the default ACL writes.

A control that must be perfect forever, that this codebase demonstrably gets
wrong most of the time, and whose failure is unauthenticated control-plane
takeover reported as a successful migration, is not a control.

## What was also learned, and is useful regardless

**Existence is answerable at zero privilege.** Probed with the publishable key
that already ships in the bundle, PostgREST distinguishes absent from
present-but-forbidden:

```
clones?select=id&limit=0             200 []
zz_no_such_table                     404 PGRST205  (absent)
clones?select=zz_no_such_col         400 42703     (absent column)
rpc/zz_no_such_fn                    404 PGRST202  (absent function)
billing_handoffs?select=*            401 42501     (PRESENT, forbidden)
```

So *"has this migration actually taken effect?"* is answerable today, with no
new privilege and no new database object. **Nobody had looked.** That matters
because the ledger cannot answer it: only **40 of 210** repo versions appear in
`supabase_migrations.schema_migrations`, and 103 ledger rows correspond to no
repo file at all — the same two-namespace problem the fleet sync hit.

`public.cron_delivery_health` already reports `cron.job` + `job_run_details`
state to `service_role`, so *"did the schedule this migration created actually
get created, and is it firing"* is answerable too.

## Options, honestly compared

| | removes the manual step | new privilege | fails loudly | verdict |
| --- | --- | --- | --- | --- |
| **A. Effect assertions + drift alarm** | no | **none** | yes | **ship regardless** |
| **B. Queue + `postgres`-owned pg_cron drain** | yes | DDL for `service_role` (async) | yes | best automation |
| **C. `SECURITY DEFINER` RPC** | partially (8s cap) | DDL for `service_role` + anon landmine | **no** | **rejected** |
| **D. Scheduled Claude Routine** | yes | none | needs A | bridge only |

**A** — every migration carries a machine-checkable claim about its own effect
(`-- @asserts table:foo`, `column:clones.deploy_url`, `cron:job-name`,
`rows:t>=17`), resolved on a schedule and in CI. It does not remove the manual
step; it makes forgetting impossible, which is the actual harm. It also answers
the 67-file backlog and catches a migration that ran but did not do what its
author thought — which **C can never do**.

**B** — `public.schema_migration_queue` (INSERT/SELECT to `service_role` only,
no UPDATE/DELETE, RLS on with no policy) plus `aurixa.drain_schema_migrations()`
as SECURITY **INVOKER** in a schema PostgREST answers `PGRST106` for, drained by
a `postgres`-owned pg_cron job. This fixes finding 1 (runs outside PostgREST, no
8s ceiling) and finding 3 (nothing callable by any API role — there is no
function in `public` at all). Be clear-eyed: a `service_role` holder can still
enqueue arbitrary SQL that executes as `postgres` ≤60s later, so the DDL
capability is the same; what changes is that it is no longer one forgotten word
away from `anon`.

## The rule

**Any mechanism that lets Mission Control apply its own migrations necessarily
grants DDL to whatever credential Mission Control holds.** That is inherent, and
it is a real increase: `service_role` has no DDL today
(`has_schema_privilege('service_role','public','CREATE') = false`). The only
question a design gets to answer is whether it *also* grants it to `anon` — and
option C answers that with a line this repository writes incorrectly 71% of the
time.
