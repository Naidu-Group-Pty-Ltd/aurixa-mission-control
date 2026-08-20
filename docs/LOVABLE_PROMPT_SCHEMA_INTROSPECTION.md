# Task: replace the migration-replay clone path with catalog introspection

## Why

`provisionCloneBackend` in `src/server/backend-provisioning.server.ts` builds a
clone's schema by replaying the prime repo's `supabase/migrations/**` in
filename order (`applyPrimeMigrations`). **For our prime this can never
succeed.** The repo's migration history does not construct the prime's schema —
it assumes base tables no migration creates — so it fails on migration #1 with:

```
ERROR: 42P01: relation "client_activities" does not exist
```

The ledger has also drifted from the repo: 949 migration files on disk against
853 tracked, and 546 live tables materialised out of band. Provisioning throws
(correctly) and every attempt burns a Supabase project slot.

**A replay of a repository's migrations is not a clone of a database.** It
reproduces the history someone wrote down, not the schema that exists.

This has been done by hand end to end against the live projects, so the
approach below is known to work: 1.58 MB of DDL, minutes to run, using only the
Supabase Management API — no database password, no open Postgres port.

## What to build

A new module `src/server/schema-introspection.server.ts` that reads the
**prime's live `pg_catalog`**, generates DDL, applies it to the clone in
dependency order, and **reconciles every stage against the prime**.

### Reuse, do not reinvent

From `src/server/backend-provisioning.server.ts`:

- `runSqlOnProject(projectRef: string, sql: string): Promise<unknown>` — POSTs
  to the Management API `/database/query`. Returns parsed JSON; rows come back
  as a bare array, but tolerate `{rows}` / `{result}` wrappers (see how
  `applyPrimeMigrations` does it).
- `sqlLiteral(value: string): string` — quote a string for SQL.
- `getPrimeProjectRef()` / `tryGetPrimeProjectRef()`.

### The stages, in this exact order

Dependency order is not optional — each stage needs the previous one.

| # | Stage | Source query (on the prime) |
|---|---|---|
| 1 | enum types | `pg_type t JOIN pg_enum e` where `t.typtype='e'`, emit `create type … as enum (…)` |
| 2 | sequences | `pg_class` where `relkind='S'` |
| 3 | tables (columns only) | `pg_attribute` + `pg_attrdef`, emit `create table if not exists` |
| 4 | functions | `pg_get_functiondef(p.oid)` where `prokind in ('f','p')` and **not extension-owned** |
| 5 | constraints | `pg_get_constraintdef`, ordered `p` → `u` → `c` → `f` |
| 6 | indexes | `pg_indexes`, **excluding constraint-backed ones** |
| 7 | views | `pg_views`, emit `create or replace view` |
| 8 | materialized views | `pg_class` where `relkind='m'`, `pg_get_viewdef(oid, true)` |
| 9 | triggers | `pg_get_triggerdef(t.oid)` where `not tgisinternal` |
| 10 | RLS enable | `alter table … enable row level security` for tables with `relrowsecurity` |
| 11 | policies | `pg_policies` → `create policy … as … for … to … using (…) with check (…)` |

Scope every query to `n.nspname in ('public','aml')`. **`aml` is not optional —
the prime keeps 106 tables there.**

Exclude extension-owned functions with
`LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'` … `d.objid IS NULL`.
Without this you will try to recreate ~118 `vector` functions.

### Five rules that each produced a wrong result that looked right

These are not theoretical. Each one was hit doing this by hand.

1. **Reconcile every stage against the prime.** After applying, count the
   objects on the prime and on the clone and compare. Do **not** treat "every
   statement I sent applied without error" as success — that is a different
   question, and it is exactly how a transfer applied 528 of 641 tables and
   reported done. Return `{ stage, primeCount, cloneCount, applied, failed,
   reconciled }` per stage and mark the run failed when any `reconciled` is
   false.

2. **`create table if not exists` does not repair an existing table.** On a
   re-run, tables that already exist are skipped and any column drift survives
   invisibly — counts match while columns do not. After stage 3, compare the
   full column signature (`attname + format_type(atttypid, atttypmod)` per
   table, hashed) and emit `alter table … add column if not exists …` for
   anything missing.

3. **`LANGUAGE sql` functions are validated at creation.** One that calls
   another fails if the callee does not exist yet, and catalog order does not
   give you dependency order. Run stage 4 **repeatedly until the failure count
   stops falling**, then report failure. By hand this converged in three passes:
   12 failures, then 1, then 0. Cap the passes (say 5) so a genuine error
   cannot loop.

4. **`pg_indexes` includes constraint-backed indexes.** Creating everything it
   returns double-creates whatever stage 5 already made. Filter with
   `NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class ic ON ic.oid = c.conindid
   WHERE ic.relname = i.indexname)` — but reconcile against the **unfiltered**
   count, because that is what the clone will report.

5. **Materialized views are `relkind='m'`, not `'r'`.** Every table query
   misses them. One exists (`pdf_import_cost_daily`), and an index belongs to
   it — if you skip stage 8, stage 6 fails with a message about a relation that
   "does not exist".

### Never move a row

Every source query must read `pg_catalog` / `information_schema` only. Assert
it: refuse any generated source query that does not begin with `select` or
`with`. The clone must still hold zero rows afterwards apart from the seeded
admin. Add a `verifyCloneIsEmpty(cloneRef)` that counts every row in
`public` + `aml` and returns the non-empty tables.

### Applying DDL safely

Apply in batches (≈60 statements; ≈15 for functions, whose bodies are large).
Wrap each statement so one failure does not abort the batch — create a helper
function on the clone that takes a `jsonb` array of statements and executes
each in its own `BEGIN … EXCEPTION` block, recording failures to a table. Treat
`already exists` / `duplicate` as success so re-runs are idempotent.

## Wiring it in

In `provisionCloneBackend` (`backend-provisioning.server.ts`), replace the
migration-replay step with:

1. Run catalog introspection (the new module).
2. Stamp `supabase_migrations.schema_migrations` with the prime's applied
   migration IDs, so future *incremental* migrations still apply cleanly.

**Keep `applyPrimeMigrations`.** It is still used for module migrations and is
the right tool for incremental changes after the clone exists. Do not delete it.

Make the path selectable — add an input flag (default: introspection) so an
operator can still force the replay.

## Repo conventions you must follow

- **`src/lib/**/*.functions.ts` is client-reachable.** A static
  `import … from "@/server/…"` there **fails the build** with
  `[import-protection] Import denied in client environment`. The convention is
  a dynamic import of a shim inside the function body:
  ```ts
  const { x } = await import(/* @vite-ignore */ "@/lib/_server-shims/your-module.server");
  ```
  Add `src/lib/_server-shims/schema-introspection.server.ts` containing
  `export * from "@/server/schema-introspection.server";`
- Do **not** add `@ts-nocheck` to new files. Two existing files have it and
  lint flags both; do not add a third.
- Tests are `vitest`, colocated as `src/server/<name>.test.ts`. Export the pure
  helpers (DDL builders, the reconcile comparison, the convergence loop's
  stop condition) and unit-test them without hitting the network.
- Run `npm run typecheck`, `npm run test`, `npm run lint`, `npm run build`
  before you finish. The build catches the import-protection error that
  typecheck and tests both miss.

## Acceptance criteria

- [ ] `npm run build` passes (this is the one that catches the shim mistake).
- [ ] `npm run typecheck` reports 0 errors; `npm run test` all green.
- [ ] New unit tests cover: the constraint-backed index filter, the column-drift
      detector, the convergence stop condition, and the read-only source-query
      assertion.
- [ ] `provisionCloneBackend` no longer depends on migration replay to build the
      schema, and `applyPrimeMigrations` still exists for module migrations.
- [ ] Every stage returns a reconciliation result, and the run fails when any
      stage is short.
- [ ] Nothing in the new module can select from a data table.

## Reference: expected numbers

Cloning our prime by hand produced exactly these, and they are what a correct
implementation should reconcile to:

| Object | Count |
|---|---|
| enum types | 94 |
| tables | 641 (column signature md5-identical) |
| functions | 491 |
| constraints | 2,560 (name-set md5-identical) |
| indexes | 2,136 |
| views / matviews | 13 / 1 |
| triggers | 472 |
| RLS policies | 1,149 |
| sequences | 1 |
| **rows in the clone afterwards** | **2** (the seeded admin only) |

Background and the full gap analysis: `docs/CLONE_PIPELINE_GAPS.md` §1 and §7.
