-- Schedule /hooks/fleet-migration-sync.
--
-- WHAT IT IS FOR. When the prime gains a migration, the cascade copies the FILE
-- into every clone's repository automatically. Nothing applied it to the
-- clone's DATABASE. `fleetMigrationSync` has existed and worked the whole time
-- and its only caller was a button on an admin page, so the fleet stayed in
-- step with the prime exactly as often as somebody remembered to press it.
--
-- That is the ceiling on how many clones this platform can carry. One clone is
-- a click. Ten is a chore nobody does on the day it matters. The schema drifts,
-- the clone's edge functions begin naming columns it does not have, and the
-- symptom arrives as PostgREST 42703s inside a tenant's application rather than
-- as anything anyone here would recognise as a missed migration.
--
-- THIRTY MINUTES, not one. Nothing here is queue-draining: a clone's schema
-- does not change between ticks, and there is no user waiting on the next one.
-- Each run takes a bounded slice of the fleet (see DEFAULT_BATCH) so the work
-- is spread across ticks rather than attempted in one invocation that would
-- outlive the isolate — the shape that timed out the first mirror cascade at
-- exactly 60,000 ms.
--
-- CHEAP WHEN THE FLEET IS LEVEL. `applyPrimeMigrations` unions both ledgers on
-- the clone and skips everything already applied, so a clone in step costs one
-- round trip and writes nothing.
--
-- THE SECRET IS READ INSIDE THE COMMAND. Every healthy job on this deployment
-- resolves `cron_secret` from the vault per run, so a rotation needs no
-- reschedule and a missing secret fails as a 401 in `net._http_response` rather
-- than as a migration that silently declines to schedule anything. That shape
-- is what 20260826000000_schedule_the_engine.sql exists to fix.
--
-- Idempotent: re-running leaves an existing vault-reading job exactly as it is.

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

  -- fleet-migration-sync-30min -> /hooks/fleet-migration-sync   (*/30 * * * *)
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'fleet-migration-sync-30min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('fleet-migration-sync-30min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fleet-migration-sync-30min');
    PERFORM cron.schedule(
      'fleet-migration-sync-30min',
      '*/30 * * * *',
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
        v_base || '/hooks/fleet-migration-sync'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'fleet-migration-sync-30min', v_base;
  END IF;
END $$;
