-- @asserts table:migration_assertion_checks
-- @asserts cron:migration-drift-hourly
-- @asserts enum:notification_kind
--
-- Where "did this migration actually take?" gets its answer.
--
-- `supabase_migrations.schema_migrations` cannot answer it on this deployment.
-- Measured: 40 of 211 repo versions appear in that table, and 103 of its rows
-- correspond to no repo file at all, because Lovable stamps its own apply
-- timestamps. The repo and the ledger are two namespaces that barely overlap,
-- which is why 67 files sat in a documented backlog nobody could resolve, and
-- why a hand-apply that gets forgotten stays forgotten.
--
-- So the question is asked of the schema instead. Every migration from here on
-- carries a `-- @asserts` line naming something the database can be asked
-- about; `scripts/generate-migration-assertions.mjs` compiles those into a
-- module; `/hooks/migration-drift` resolves them hourly and records the verdict
-- here.
--
-- It catches a failure no applier can. A `DO $$ ... EXCEPTION WHEN OTHERS THEN
-- NULL $$` block -- and this corpus contains that shape -- runs, succeeds, and
-- achieves nothing. Every ledger records that as applied.
--
-- ZERO NEW PRIVILEGE. docs/MIGRATION_AUTOMATION_OPTIONS.md rejects the obvious
-- automation (a SECURITY DEFINER runner taking migration SQL) because this
-- database's default ACL grants EXECUTE on every new `public` function to
-- `anon` and `authenticated` -- 77 of 145 functions today -- so the explicit
-- REVOKE is the only thing standing between such a function and the browser
-- bundle, and this repository writes that REVOKE wrong 71% of the time. This
-- migration creates no function, grants no DDL, and adds nothing callable.

-- The alarm's own vocabulary. Schema drift is not code drift: `drift_high` and
-- `drift_medium` are about a clone's files diverging from the prime, and the
-- notification-mute feature is keyed on this enum, so folding the two together
-- would mean muting one silences the other.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'migration_drift';

-- One row per (migration, claim). The claims themselves live in the SQL and in
-- the generated module -- never here. A row is a record of an OBSERVATION, and
-- a row that outlives its claim is pruned by the worker rather than trusted.
CREATE TABLE IF NOT EXISTS public.migration_assertion_checks (
  migration          text NOT NULL,
  -- The claim in its source form, e.g. `table:clone_reference_syncs`. Text
  -- rather than a foreign key because the authority is the repository.
  assertion          text NOT NULL,
  kind               text NOT NULL,
  -- Five verdicts, not two. `error` is the probe failing and `unassertable` is
  -- there being no channel that can answer -- neither is a failed claim, and
  -- collapsing either into `unsatisfied` sends somebody to re-run SQL because
  -- of a 502. `not_applicable` is a `none:` claim, which is a statement about
  -- the migration rather than about the database.
  status             text NOT NULL
    CHECK (status IN ('satisfied', 'unsatisfied', 'unassertable', 'not_applicable', 'error')),
  detail             text NOT NULL,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  -- When the claim was last observed to HOLD. Kept across a later failure so a
  -- transient probe error does not erase the evidence that it once did.
  last_satisfied_at  timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration, assertion)
);

COMMENT ON TABLE public.migration_assertion_checks IS
  'Observations of whether each migration''s declared effect is present in this '
  'database. The claims are declared in supabase/migrations/*.sql as `-- @asserts` '
  'comments and compiled into src/server/migrationAssertions.generated.ts; a row '
  'here is evidence, never authority.';

-- The worker orders by staleness, so this index is the run's shape.
CREATE INDEX IF NOT EXISTS migration_assertion_checks_stale_idx
  ON public.migration_assertion_checks (checked_at);
-- Drift is the only status anybody looks for by itself.
CREATE INDEX IF NOT EXISTS migration_assertion_checks_drift_idx
  ON public.migration_assertion_checks (checked_at DESC) WHERE status = 'unsatisfied';

GRANT SELECT ON public.migration_assertion_checks TO authenticated;
GRANT ALL ON public.migration_assertion_checks TO service_role;
ALTER TABLE public.migration_assertion_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "migration_assertion_checks_read" ON public.migration_assertion_checks;
CREATE POLICY "migration_assertion_checks_read" ON public.migration_assertion_checks
FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));

-- Read-only to operators on purpose. Editing a verdict edits the evidence, and
-- the only honest way to clear one is to make the claim true. The worker holds
-- service_role, which RLS does not filter.

-- ---------------------------------------------------------------------------
-- Schedule
--
-- Hourly. The probes are cheap reads and the corpus changes at merge cadence,
-- so a tighter loop buys nothing; the alarm's job is that a forgotten apply is
-- found within the hour rather than in three weeks.
--
-- The secret is read from the vault INSIDE the command, per run, like every
-- other healthy job here. Reading it at install time is how six workers came to
-- be never scheduled at all: the vault was empty when their migrations ran,
-- each one took its `IF v_secret IS NULL THEN RETURN` branch, and a RAISE
-- NOTICE nobody reads was the only trace. Read at run time, a missing secret
-- surfaces as a 401 in `net._http_response`, which is visible.
DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'migration-drift-hourly' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('migration-drift-hourly')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'migration-drift-hourly');
    PERFORM cron.schedule(
      'migration-drift-hourly',
      '17 * * * *',
      format(
        $f$SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'Lovable-Context','cron',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
          ),
          body := jsonb_build_object('source','pg_cron'),
          timeout_milliseconds := 60000
        )$f$,
        v_base || '/hooks/migration-drift'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'migration-drift-hourly', v_base;
  END IF;
END $$;
