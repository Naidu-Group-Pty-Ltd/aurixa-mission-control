-- Schedule the deployment worker, in the same migration series that had to go
-- find six workers nothing had ever called.
--
-- `/hooks/deployment-drain` advances `clone_deployments` one state per pass
-- (create project → link repo → sync env → deploy → attach domain → verify →
-- live). Every step is a network call to a rate-limited API, so the worker does
-- not try to run a clone end-to-end inside one invocation: it takes one step,
-- persists, and lets the next tick continue. That is only correct if the tick
-- actually happens, which is what this migration is.
--
-- Every-minute, matching edge-drain: a clone waiting on DNS propagation is
-- re-checked often enough that "provisioned" and "reachable" are minutes apart
-- rather than hours, and the claim index makes an empty pass nearly free.
--
-- The purge is daily and deliberately separate: deployment_events is an
-- unbounded write path fed by a per-minute worker, and this repository has
-- already had one of those grow without limit while its own rate limiter ran
-- three exact counts over it per request.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- HOW THIS JOB AUTHENTICATES, and why the first version of it did not.
--
-- The original block here read the secret from `app.settings.cron_secret`,
-- wrapped in COALESCE(..., ''), and baked the resulting header into the job
-- command with format(%L). Three separate faults, and in production they
-- compounded into a job that never once authenticated:
--
--   1. WRONG SOURCE. Every other scheduled job in this deployment reads
--      `vault.decrypted_secrets`. The GUC is unset here — and unset is the
--      normal state, because nothing sets it.
--   2. A MISSING SECRET BECAME AN EMPTY ONE. `COALESCE(..., '')` turned "no
--      credential" into the literal header `Bearer `, which is a well-formed
--      request the endpoint answers 401. A missing credential must fail
--      loudly, never resolve to a valid-looking wrong value.
--   3. BAKED AT INSTALL TIME. `format(%L)` froze the header into the job's
--      command text, so the value was whatever the GUC held during the
--      migration — for ever. Setting the GUC afterwards would have changed
--      nothing.
--
-- Measured: 208 × `{"error":"Unauthorized"}` in three hours, every one of them
-- this job. The deployment pipeline could not have advanced a single clone
-- even once the provider credentials were in place.
--
-- The vault lookup below is INSIDE the command string on purpose. It is
-- evaluated on each run, so a rotated secret is picked up without rescheduling.
DO $$
DECLARE
  v_base TEXT;
BEGIN
  -- The production host, not the preview one. `public_app_url` still wins when
  -- it is set, which is what makes a domain change a one-line GUC update.
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  PERFORM cron.unschedule('deployment-drain-1min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deployment-drain-1min');

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

  PERFORM cron.unschedule('deployment-events-purge-daily')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deployment-events-purge-daily');

  PERFORM cron.schedule(
    'deployment-events-purge-daily',
    '35 3 * * *',
    'SELECT public.purge_deployment_events()'
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'deployment drain NOT scheduled (%).', SQLERRM;
END $$;