-- Schedule /hooks/allowed-origins-reconcile.
--
-- WHAT IT IS FOR. `ALLOWED_ORIGINS` is derived from a clone's own origins, and
-- those move after provisioning: a custom domain attached to a clone that has
-- been live for a month, a re-allocated subdomain, a redeploy that changes the
-- provider origin, a change to the platform's `primary_domain` that moves every
-- clone at once. Provisioning derives the value and the deployment drain
-- completes it; between them they cover a clone's first hour and nothing
-- covers the rest of its life.
--
-- The symptom when it rots is the one this area exists because of: the prime's
-- CORS helper falls back to the PRIME's hostnames when the variable is unset or
-- wrong, so a clone answers its own login request with somebody else's origin
-- and the browser refuses the response. Sign-in fails with correct credentials,
-- a healthy account, and no server-side error anywhere.
--
-- It is also what makes the EXISTING fleet self-heal. Every clone provisioned
-- before any of this existed has the secret unset; the first run sets it,
-- without an operator remembering to press anything.
--
-- FIFTEEN MINUTES, not one. Nothing here is queue-draining — there is no
-- backlog to work off and no user waiting on the next tick. The events that
-- move a clone's origins are minutes-to-days apart, and the two paths that
-- matter most (provisioning, and the deployment reaching `live`) already set it
-- inline. This is the safety net, and a safety net that runs every minute is
-- sixty times the Management API traffic for the same outcome.
--
-- CHEAP ON THE RUNS THAT FIND NOTHING. A clone whose derived value matches what
-- Mission Control last wrote costs one indexed read and no Management API call,
-- and records no event. Only a clone whose origins actually moved is written
-- and logged.
--
-- THE SECRET IS READ INSIDE THE COMMAND. Every healthy job on this deployment
-- resolves `cron_secret` from the vault per run, so a rotation needs no
-- reschedule and a missing secret fails as a 401 in `net._http_response` rather
-- than as a migration that silently declines to schedule anything. That shape
-- is what `20260826000000_schedule_the_engine.sql` exists to fix and what
-- `check:cron-auth` enforces; this job is written the same way from the start.
--
-- Idempotent: re-running leaves an existing vault-reading job exactly as it is.

DO $$
DECLARE
  v_base TEXT;
BEGIN
  -- Same resolution order as every other job here: vault, then the GUC, then a
  -- literal so a fresh project still points somewhere real.
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- allowed-origins-reconcile-15min -> /hooks/allowed-origins-reconcile   (*/15 * * * *)
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'allowed-origins-reconcile-15min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('allowed-origins-reconcile-15min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'allowed-origins-reconcile-15min');
    PERFORM cron.schedule(
      'allowed-origins-reconcile-15min',
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
        v_base || '/hooks/allowed-origins-reconcile'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'allowed-origins-reconcile-15min', v_base;
  END IF;
END $$;
