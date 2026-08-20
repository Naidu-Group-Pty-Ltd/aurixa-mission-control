-- Four scheduled jobs cannot authenticate when this corpus is replayed.
--
-- `deployment-drain-1min` is the live one. It shipped with its Authorization
-- header built as `'Bearer ' || COALESCE(current_setting(
-- 'app.settings.cron_secret', true), '')` and BAKED INTO THE COMMAND at install
-- time by format(%L). That GUC is unset on this deployment — every working job
-- reads `vault.decrypted_secrets` — so the header was the literal string
-- `Bearer `: a well-formed request the endpoint answers 401. Measured before
-- this repair: 208 × `{"error":"Unauthorized"}` in three hours, all of them
-- this job, while `cron.job_run_details` reported every run as succeeded —
-- because queueing the HTTP call is the success it reports.
--
-- The other three (`aurixa-brand-drift-scan`, `expire-reservations-5min`,
-- `token-alerts-15min`) are the same defect in the corpus only. Production is
-- healthy because they were rescheduled out of band, but their last scheduling
-- IN THE MIGRATIONS still carries an empty bearer and a stale preview host, so
-- a rebuild from zero recreates them broken. Same class as the replay defect
-- this repository already records: the live database was built incrementally
-- and is fine, and the corpus cannot reproduce it.
--
-- Three faults, one idea — a missing credential must fail loudly, never
-- degrade into a valid-looking wrong one:
--   * WRONG SOURCE   a GUC nothing sets, instead of the vault
--   * EMPTY FALLBACK COALESCE(..., '') turning absent into blank
--   * BAKED AT INSTALL  the value frozen into the command, so setting the
--                       secret afterwards changes nothing
--
-- The vault lookup below sits INSIDE each command on purpose: evaluated per
-- run, so a rotated secret is picked up without rescheduling.
--
-- Idempotent. A job already reading the vault is left alone rather than churned.

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- deployment-drain-1min
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deployment-drain-1min')
     AND NOT EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname = 'deployment-drain-1min' AND command LIKE '%vault.decrypted_secrets%'
     )
  THEN
    PERFORM cron.unschedule('deployment-drain-1min');
    PERFORM cron.schedule(
      'deployment-drain-1min',
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
        v_base || '/hooks/deployment-drain'
      )
    );
    RAISE NOTICE 'rescheduled deployment-drain-1min against %', v_base;
  END IF;

  -- aurixa-brand-drift-scan
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aurixa-brand-drift-scan')
     AND NOT EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname = 'aurixa-brand-drift-scan' AND command LIKE '%vault.decrypted_secrets%'
     )
  THEN
    PERFORM cron.unschedule('aurixa-brand-drift-scan');
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
    RAISE NOTICE 'rescheduled aurixa-brand-drift-scan against %', v_base;
  END IF;

  -- expire-reservations-5min
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-reservations-5min')
     AND NOT EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname = 'expire-reservations-5min' AND command LIKE '%vault.decrypted_secrets%'
     )
  THEN
    PERFORM cron.unschedule('expire-reservations-5min');
    PERFORM cron.schedule(
      'expire-reservations-5min',
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
        v_base || '/hooks/expire-reservations'
      )
    );
    RAISE NOTICE 'rescheduled expire-reservations-5min against %', v_base;
  END IF;

  -- token-alerts-15min
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'token-alerts-15min')
     AND NOT EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname = 'token-alerts-15min' AND command LIKE '%vault.decrypted_secrets%'
     )
  THEN
    PERFORM cron.unschedule('token-alerts-15min');
    PERFORM cron.schedule(
      'token-alerts-15min',
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
        v_base || '/hooks/token-alerts'
      )
    );
    RAISE NOTICE 'rescheduled token-alerts-15min against %', v_base;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron or vault must not fail the whole migration.
  RAISE WARNING 'cron auth repair skipped (%).', SQLERRM;
END $$;
