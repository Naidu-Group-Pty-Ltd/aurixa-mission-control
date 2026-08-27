-- @asserts table:schema_migration_queue
-- @asserts cron:schema-migration-drain
--
-- The database applies its own migrations, because nothing outside it can.
--
-- Mission Control's database is a Lovable Cloud project in LOVABLE's Supabase
-- organisation. Measured 2026-08-27: `get_project` answers 403, and Supabase's
-- own documentation is explicit -- "You won't see this project in your Supabase
-- Dashboard, and you won't have access to service role keys or direct database
-- URLs." So `.github/workflows/apply-migrations.yml` was built on a Management
-- API that can never reach this project, and has failed on every run since it
-- was created. `psql` is unavailable for the same reason.
--
-- docs/MIGRATION_AUTOMATION_OPTIONS.md records every other channel that was
-- probed: extra PostgREST schemas (PGRST106), a platform SQL endpoint on the
-- project host (404 on all four paths), a connection string injected under
-- another name (the server reads only SUPABASE_URL and the service key). All
-- blocked. What is left is the database asking itself.
--
-- ============================================================================
-- WHY NOT A `SECURITY DEFINER` FUNCTION IN `public`
-- ============================================================================
--
-- That was the obvious design and it is rejected, on three findings that were
-- reproduced on this database rather than reasoned about:
--
-- 1. THE 8-SECOND CEILING CANNOT BE ESCAPED. `authenticator` carries
--    `statement_timeout=8s, lock_timeout=8s` (in `pg_db_role_setting`), so
--    every PostgREST call inherits it. Setting `statement_timeout` in a
--    function's `proconfig` does NOT help: the timer is armed when the
--    top-level statement begins and a GUC change mid-statement does not re-arm
--    it -- confirmed here, a definer function with `SET statement_timeout='1s'`
--    ran `pg_sleep(3)` to completion. And `current_setting()` INSIDE the
--    function reports the new value, so every way of checking the fix from
--    inside reports success. 117 of 211 migrations do a top-level
--    `CREATE INDEX` or `UPDATE public....` backfill.
--
-- 2. THE DOMINANT FAILURE MODE WRITES NO RECORD. `EXCEPTION WHEN OTHERS` does
--    not catch `57014 query_canceled`, so the statement timeout -- the MOST
--    likely failure given (1) -- is the one that bypasses the ledger row the
--    design rests on.
--
-- 3. THE RUNNER WOULD SILENTLY UN-HARDEN ITSELF. `pg_default_acl` on this
--    database grants EXECUTE on every new `public` function to `anon` AND
--    `authenticated` (measured: `postgres=X/postgres,anon=X/postgres,
--    authenticated=X/postgres,service_role=X/postgres`), which is why 77 of 145
--    public functions are anon-executable today. `CREATE OR REPLACE` preserves
--    an explicit REVOKE; `DROP` + `CREATE` does not -- so any future signature
--    change applied THROUGH the runner restores `anon=X` and returns success.
--    Of the 45 `REVOKE ALL ON FUNCTION` statements in this corpus only 13 name
--    `authenticated`; the most recent, `cron_delivery_health`, does not.
--
-- ============================================================================
-- WHAT THIS DOES INSTEAD
-- ============================================================================
--
-- A queue in `public` that `service_role` may APPEND to, drained by a
-- `postgres`-owned pg_cron job calling a function in a schema PostgREST does
-- not serve.
--
-- (1) dissolves: the drain runs in a pg_cron background worker, and `postgres`
-- has no `statement_timeout` in `pg_db_role_setting` at all -- the 8s ceiling
-- is an `authenticator` setting and nothing else inherits it. The job's command
-- sets its own budget explicitly rather than relying on a cluster default.
--
-- (3) dissolves: there is no function in `public`. The drain lives in `aurixa`,
-- which has NO `pg_default_acl` entry -- every entry on this database is
-- schema-scoped and there is none for a schema that does not exist yet -- so a
-- new schema grants nothing to anyone by default. It is also SECURITY INVOKER,
-- which means even a role that somehow reached it would run it with its OWN
-- privileges, and `service_role` has no DDL
-- (`has_schema_privilege('service_role','public','CREATE') = false`). The
-- privilege here comes from WHO runs the function -- `postgres`, via cron --
-- never from the function itself. That is the difference from a definer.
--
-- BE CLEAR-EYED ABOUT WHAT IS STILL TRUE. A `service_role` holder can enqueue
-- arbitrary SQL that executes as `postgres` within a minute. Any mechanism that
-- lets Mission Control apply its own migrations necessarily grants DDL to
-- whatever credential Mission Control holds; that is inherent and it is a real
-- increase. What changes is that it is no longer one forgotten word away from
-- `anon`.

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_migration_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The 14-digit version. UNIQUE, so re-posting a merge is a no-op rather than
  -- a second application: `cron.schedule` calls and seed INSERTs in this corpus
  -- are not idempotent.
  version      text NOT NULL UNIQUE,
  name         text NOT NULL,
  sql          text NOT NULL,
  -- What was enqueued, so what RAN can be compared with what the repository
  -- holds. A migration edited after it applied is the mistake this catches.
  sha256       text,
  status       text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'applied', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  enqueued_by  text,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

COMMENT ON TABLE public.schema_migration_queue IS
  'Migrations awaiting application to THIS database, drained by the '
  'postgres-owned `schema-migration-drain` cron job. service_role may INSERT '
  'and SELECT and nothing else: the drain owns every status transition, so a '
  'holder of the API key cannot mark something applied that never ran.';

CREATE INDEX IF NOT EXISTS schema_migration_queue_pending_idx
  ON public.schema_migration_queue (version) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS schema_migration_queue_recent_idx
  ON public.schema_migration_queue (enqueued_at DESC);

-- RLS on with no policy: closed to `anon` and `authenticated` outright. That is
-- the correct state for a table only the service-role client touches, and
-- `scripts/check-rls-policies.mjs` carries it in SERVICE_ROLE_ONLY rather than
-- letting a missing policy look like an oversight.
ALTER TABLE public.schema_migration_queue ENABLE ROW LEVEL SECURITY;

-- RLS IS NOT ENOUGH HERE, AND THIS IS THE LINE THAT MATTERS.
--
-- `service_role` has `rolbypassrls = true`, so RLS never filters it -- only
-- GRANTs do. And `pg_default_acl` on this database grants `arwdDxtm` (ALL) on
-- every new `public` table to `anon`, `authenticated`, `service_role` AND
-- `sandbox_exec`. Without the revoke below, the API key could UPDATE a row to
-- `applied` without the SQL ever having run, or DELETE the evidence that it
-- failed. Creating the table is not enough; taking the default grants away is
-- the control.
REVOKE ALL ON public.schema_migration_queue FROM PUBLIC;
DO $revoke$
DECLARE
  v_role text;
BEGIN
  -- Named roles are revoked conditionally because this corpus is replayed onto
  -- clone databases by `applyPrimeMigrations`, and `sandbox_exec` is a Lovable
  -- Cloud role that a plain Supabase project does not have. A `REVOKE ... FROM
  -- <missing role>` aborts the whole replay.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'sandbox_exec']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.schema_migration_queue FROM %I', v_role);
    END IF;
  END LOOP;
END $revoke$;

-- Append and read. Never update, never delete.
GRANT SELECT, INSERT ON public.schema_migration_queue TO service_role;

-- ---------------------------------------------------------------------------
-- The drain, in a schema PostgREST does not serve
-- ---------------------------------------------------------------------------
--
-- PostgREST on this project exposes `public` and `graphql_public` and answers
-- `PGRST106 - Only the following schemas are exposed` for anything else. So
-- `aurixa` is unreachable over the API entirely, independently of any grant.
CREATE SCHEMA IF NOT EXISTS aurixa;
COMMENT ON SCHEMA aurixa IS
  'Machinery that must never be reachable over PostgREST. Nothing in here is '
  'granted to an API role, and PostgREST would answer PGRST106 even if it were.';
REVOKE ALL ON SCHEMA aurixa FROM PUBLIC;

-- SECURITY INVOKER, deliberately and load-bearingly. The function confers no
-- privilege of its own; it runs as whoever calls it, and the only caller with
-- DDL is the `postgres`-owned cron job below. A `service_role` that somehow
-- reached it would execute the migrations as `service_role`, which cannot
-- CREATE in `public` -- so the first statement would fail.
--
-- `search_path` mirrors what a migration sees when Lovable applies it
-- (`"$user", public, extensions`). `search_path = ''` was measured to break 58
-- of 211 files in this corpus, so it is not an option here.
CREATE OR REPLACE FUNCTION aurixa.drain_schema_migrations(_max_per_run integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_catalog
AS $fn$
DECLARE
  v_row      public.schema_migration_queue%ROWTYPE;
  v_applied  integer := 0;
  v_failed   integer := 0;
  v_names    text[]  := ARRAY[]::text[];
  v_msg      text;
  v_state    text;
  v_terminal boolean;
BEGIN
  -- Transaction-scoped, so it is released by the commit or the rollback and
  -- there is no unlock to forget on an error path. A session-level lock in a
  -- worker that dies mid-run parks the queue until somebody notices.
  IF NOT pg_try_advisory_xact_lock(hashtext('aurixa.drain_schema_migrations')) THEN
    RETURN jsonb_build_object('skipped', 'another drain holds the lock');
  END IF;

  -- A FAILED migration halts the queue. Migrations are ordered, and applying
  -- N+1 after N failed is how a schema becomes something nobody can reproduce
  -- -- the same rule `applyPrimeMigrations` follows for a clone.
  IF EXISTS (SELECT 1 FROM public.schema_migration_queue WHERE status = 'failed') THEN
    RETURN jsonb_build_object('halted', 'a failed migration is blocking the queue');
  END IF;

  WHILE v_applied + v_failed < GREATEST(COALESCE(_max_per_run, 20), 1) LOOP
    SELECT * INTO v_row
      FROM public.schema_migration_queue
     WHERE status = 'queued'
     ORDER BY version, enqueued_at
     LIMIT 1;
    EXIT WHEN NOT FOUND;

    -- Outside the sub-block below on purpose: a rolled-back attempt must still
    -- leave its attempt counted, or a migration that fails deterministically
    -- retries every minute forever.
    UPDATE public.schema_migration_queue
       SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE id = v_row.id;

    BEGIN
      -- The payload, executed as-is. Nothing is interpolated into it -- this is
      -- the SQL the repository holds, travelling as a value.
      EXECUTE v_row.sql;

      -- Stamp the ledger the way the old Management API path did, so the two
      -- namespaces do not diverge further for the files WE apply.
      INSERT INTO supabase_migrations.schema_migrations (version)
      SELECT v_row.version
       WHERE NOT EXISTS (
         SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_row.version
       );

      UPDATE public.schema_migration_queue
         SET status = 'applied', finished_at = now(), error = NULL
       WHERE id = v_row.id;
      v_applied := v_applied + 1;
      v_names := v_names || v_row.name;
    EXCEPTION
      WHEN OTHERS THEN
        -- The sub-block is a savepoint, so everything the migration did is
        -- rolled back before this runs. A failed migration therefore leaves
        -- NOTHING applied, which is what makes a retry safe.
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        -- Three attempts, then terminal. Two of the three exist to absorb a
        -- lock contention; a deterministic SQL error will simply fail three
        -- times in three minutes and then stop, rather than retrying forever.
        v_terminal := (v_row.attempts + 1) >= 3;
        UPDATE public.schema_migration_queue
           SET status = CASE WHEN v_terminal THEN 'failed' ELSE 'queued' END,
               error = format('%s %s', v_state, v_msg),
               finished_at = CASE WHEN v_terminal THEN now() ELSE NULL END
         WHERE id = v_row.id;
        v_failed := v_failed + 1;
        EXIT;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'failed', v_failed,
    'names', to_jsonb(v_names)
  );
END $fn$;

-- Belt and braces. `aurixa` has no default ACL entry, but PostgreSQL grants
-- EXECUTE on a new function to PUBLIC unless told otherwise, and the whole
-- point of this design is that no API role can reach it.
REVOKE ALL ON FUNCTION aurixa.drain_schema_migrations(integer) FROM PUBLIC;
DO $revoke_fn$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'sandbox_exec']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION aurixa.drain_schema_migrations(integer) FROM %I', v_role
      );
    END IF;
  END LOOP;
END $revoke_fn$;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
--
-- Every minute: a merge should reach the database in about the time a CI job
-- takes, and an empty queue costs one indexed lookup.
--
-- The job runs as whoever schedules it, and migrations on this deployment run
-- as `postgres` (measured: `current_user` = `session_user` = `postgres`, and
-- all 32 existing jobs carry `username = postgres`). That is where the DDL
-- capability comes from, and it is the only place it comes from.
--
-- The command sets its own budget rather than inheriting one. `postgres` has no
-- `statement_timeout` in `pg_db_role_setting`, so the effective value is a
-- cluster default this repository does not control; a `CREATE INDEX` on a
-- 632 MB database can outlast a two-minute default. 20 minutes is generous for
-- a migration and short enough that a runaway is not permanent. `lock_timeout`
-- is deliberately SHORT: a migration that cannot take its lock in 30 seconds
-- should get out of the application's way and retry next minute.
--
-- This job posts to no URL and needs no credential, so `check-cron-auth.mjs`'s
-- vault rule -- which is scoped to commands that POST to a `/hooks/` path --
-- correctly does not apply. There is no secret here to leak or to rotate.
DO $schedule$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'schema-migration-drain'
       AND command LIKE '%aurixa.drain_schema_migrations%'
  ) THEN
    PERFORM cron.unschedule('schema-migration-drain')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'schema-migration-drain');
    PERFORM cron.schedule(
      'schema-migration-drain',
      '* * * * *',
      $cmd$SET statement_timeout = '20min'; SET lock_timeout = '30s'; SELECT aurixa.drain_schema_migrations();$cmd$
    );
    RAISE NOTICE 'scheduled schema-migration-drain';
  END IF;
END $schedule$;
