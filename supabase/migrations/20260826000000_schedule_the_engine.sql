-- Six workers were never scheduled, and two of them are the cloning engine.
--
-- `clone_backends` is drained by /hooks/backend-provisioning-drain and
-- `cascade_events` by /hooks/cascade-drain. Neither job exists in `cron.job`.
-- Both migrations that were supposed to create them do this:
--
--     SELECT decrypted_secret INTO v_secret
--       FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
--     IF v_secret IS NULL THEN
--       RAISE NOTICE 'Vault entry cron_secret not found; skipping … schedule.';
--       RETURN;                       -- <- the migration ends here
--     END IF;
--     v_headers := jsonb_build_object('Authorization','Bearer ' || v_secret)::text;
--     PERFORM cron.schedule('backend-provisioning-drain-1min', '* * * * *',
--       format($f$… headers:=%L::jsonb …$f$, v_headers));
--
-- The vault was empty when they ran. Each raised a NOTICE nobody reads, each
-- was recorded as applied, and the engine has never been driven. Four more went
-- the same way: entitlement-drain, codex-nightly, codex-sweep and
-- feedback-forward-retry.
--
-- WHAT AN OPERATOR SEES WITHOUT THIS. Creating a clone writes every row
-- correctly. `provisionBackend` then sets clone_backends.status_detail to
-- "Queued — background worker will start within ~60 seconds", and no worker
-- ever starts. /hooks/deployment-drain IS scheduled, so it advances the
-- deployment as far as `syncing_env`, finds no anon key, and waits — correctly,
-- because deploying a build wired to nothing is worse. Six hours later
-- STUCK_HOURS marks it `failed` with "Stuck in syncing_env for more than 6h",
-- which names the wrong thing: nothing was wrong with the deployment.
--
-- THE FIX IS THE SHAPE, NOT THE VALUE. Reading the secret at install time is
-- what makes scheduling conditional on it, and it is unnecessary — every
-- healthy job on this deployment reads the vault INSIDE its command, per run,
-- so a rotation needs no reschedule. With the lookup inside, there is nothing
-- left for the schedule to be conditional on, and a missing secret fails the
-- way it should: a 401 in `net._http_response`, which is the only place it can be
-- read -- `cron_delivery_health()` matches responses through `return_message`,
-- which pg_cron sets to "1 row" for these commands, so it reports NULL.
-- `check:cron-auth` now enforces exactly that, keyed on the
-- /hooks/ path rather than on the word Authorization — which is how a header
-- hidden behind format(%L) escaped it for eleven jobs.
--
-- FIVE MORE ARE CORPUS-ONLY. brand-drift, warm-health, run-schedules and
-- fleet-drift are live and healthy under names their original migrations never
-- wrote — they were rescheduled out of band — and support-remediation-drain
-- still bakes its header. On a replay each would come back under the legacy
-- name, or with a frozen credential, so the canonical name is written here and
-- the corpus now reproduces production exactly.
--
-- Their legacy names are unscheduled first. That is belt-and-braces rather than
-- a repair: `brand-drift-30min` and its siblings are already retired by
-- 20260820110100 and 20260820140000, so the corpus does NOT currently
-- double-drive any endpoint — an earlier draft of this comment said it did, and
-- it was reading `cron.schedule` without honouring the `cron.unschedule` that
-- follows. `check:cron` now computes the same last-action-wins set and fails on
-- any endpoint carrying two jobs, which is the check that settles it rather
-- than a claim in a comment.
--
-- Every call is written out explicitly. A loop over job names hides them from
-- check:cron-auth, which matches `cron.schedule('<literal>'` — the first draft
-- of the previous repair was written as a loop and failed its own guard.
--
-- Idempotent, and a no-op against live production for everything except the six
-- that are missing: a job already reading the vault is left exactly as it is.

DO $$
DECLARE
  v_base TEXT;
BEGIN
  -- The vault first: `public_app_url` is set there on this deployment, and the
  -- GUC is not. The literal is last so a fresh project still points somewhere
  -- real rather than at the preview host these migrations hard-coded.
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- backend-provisioning-drain-1min -> /hooks/backend-provisioning-drain   (* * * * *)
  -- THE clone backend engine. Never scheduled.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'backend-provisioning-drain-1min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('backend-provisioning-drain-1min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backend-provisioning-drain-1min');
    PERFORM cron.schedule(
      'backend-provisioning-drain-1min',
      '* * * * *',
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
        v_base || '/hooks/backend-provisioning-drain'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'backend-provisioning-drain-1min', v_base;
  END IF;

  -- cascade-drain-1min -> /hooks/cascade-drain   (* * * * *)
  -- THE code-propagation engine. Never scheduled.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'cascade-drain-1min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('cascade-drain-1min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cascade-drain-1min');
    PERFORM cron.schedule(
      'cascade-drain-1min',
      '* * * * *',
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
        v_base || '/hooks/cascade-drain'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'cascade-drain-1min', v_base;
  END IF;

  -- entitlement-drain-2min -> /hooks/entitlement-drain   (*/2 * * * *)
  -- Module reconciliation after a plan change. Never scheduled.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'entitlement-drain-2min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('entitlement-drain-2min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'entitlement-drain-2min');
    PERFORM cron.schedule(
      'entitlement-drain-2min',
      '*/2 * * * *',
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
        v_base || '/hooks/entitlement-drain'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'entitlement-drain-2min', v_base;
  END IF;

  -- codex-security-nightly -> /hooks/codex-nightly   (0 7 * * *)
  -- Nightly scans. Never scheduled. Still gated by prime_config.codex_nightly_enabled.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'codex-security-nightly' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('codex-security-nightly')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'codex-security-nightly');
    PERFORM cron.schedule(
      'codex-security-nightly',
      '0 7 * * *',
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
        v_base || '/hooks/codex-nightly'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'codex-security-nightly', v_base;
  END IF;

  -- codex-security-sweep -> /hooks/codex-sweep   (*/10 * * * *)
  -- Stalled-scan sweeper. Never scheduled; 17 scans have been stalled for weeks.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'codex-security-sweep' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('codex-security-sweep')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'codex-security-sweep');
    PERFORM cron.schedule(
      'codex-security-sweep',
      '*/10 * * * *',
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
        v_base || '/hooks/codex-sweep'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'codex-security-sweep', v_base;
  END IF;

  -- feedback-forward-retry -> /hooks/feedback-forward-retry   (*/10 * * * *)
  -- Replays undelivered feedback. Never scheduled.
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'feedback-forward-retry' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('feedback-forward-retry')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'feedback-forward-retry');
    PERFORM cron.schedule(
      'feedback-forward-retry',
      '*/10 * * * *',
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
        v_base || '/hooks/feedback-forward-retry'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'feedback-forward-retry', v_base;
  END IF;

  -- aurixa-brand-drift-scan -> /hooks/brand-drift   (*/30 * * * *)
  -- Live and healthy. The corpus schedules BOTH names -> a replay runs it twice.
  -- Retire the legacy name so a replay does not leave two jobs on this endpoint.
  PERFORM cron.unschedule('brand-drift-30min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brand-drift-30min');

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'aurixa-brand-drift-scan' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('aurixa-brand-drift-scan')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aurixa-brand-drift-scan');
    PERFORM cron.schedule(
      'aurixa-brand-drift-scan',
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
        v_base || '/hooks/brand-drift'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'aurixa-brand-drift-scan', v_base;
  END IF;

  -- warm-clone-health-snapshots -> /hooks/warm-health   (*/5 * * * *)
  -- Live and healthy under this name; the corpus only creates the legacy one.
  -- Retire the legacy name so a replay does not leave two jobs on this endpoint.
  PERFORM cron.unschedule('warm-health-5min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'warm-health-5min');

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'warm-clone-health-snapshots' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('warm-clone-health-snapshots')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'warm-clone-health-snapshots');
    PERFORM cron.schedule(
      'warm-clone-health-snapshots',
      '*/5 * * * *',
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
        v_base || '/hooks/warm-health'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'warm-clone-health-snapshots', v_base;
  END IF;

  -- aurixa-run-schedules-every-minute -> /hooks/run-schedules   (* * * * *)
  -- Live and healthy under this name; the corpus only creates the legacy one.
  -- Retire the legacy name so a replay does not leave two jobs on this endpoint.
  PERFORM cron.unschedule('run-schedules-1min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'run-schedules-1min');

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'aurixa-run-schedules-every-minute' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('aurixa-run-schedules-every-minute')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aurixa-run-schedules-every-minute');
    PERFORM cron.schedule(
      'aurixa-run-schedules-every-minute',
      '* * * * *',
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
        v_base || '/hooks/run-schedules'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'aurixa-run-schedules-every-minute', v_base;
  END IF;

  -- fleet-drift-scan -> /hooks/fleet-drift   (*/15 * * * *)
  -- Live and healthy under this name; the corpus only creates the legacy one.
  -- Retire the legacy name so a replay does not leave two jobs on this endpoint.
  PERFORM cron.unschedule('fleet-drift-15min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fleet-drift-15min');

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'fleet-drift-scan' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('fleet-drift-scan')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fleet-drift-scan');
    PERFORM cron.schedule(
      'fleet-drift-scan',
      '*/15 * * * *',
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
        v_base || '/hooks/fleet-drift'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'fleet-drift-scan', v_base;
  END IF;

  -- support-remediation-drain -> /hooks/support-remediation-drain   (*/2 * * * *)
  -- Live and healthy. Its corpus command bakes the header via format(%L).
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'support-remediation-drain' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('support-remediation-drain')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'support-remediation-drain');
    PERFORM cron.schedule(
      'support-remediation-drain',
      '*/2 * * * *',
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
        v_base || '/hooks/support-remediation-drain'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'support-remediation-drain', v_base;
  END IF;

EXCEPTION WHEN OTHERS THEN
  -- A deployment without pg_cron or vault must not fail the whole migration.
  -- This is tolerance for a missing EXTENSION, not for a missing secret: the
  -- secret is no longer read here at all.
  RAISE WARNING 'hook scheduling repair skipped (%).', SQLERRM;
END $$;
