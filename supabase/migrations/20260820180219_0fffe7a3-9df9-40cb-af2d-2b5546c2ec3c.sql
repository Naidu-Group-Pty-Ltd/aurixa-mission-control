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

DO $$
DECLARE
  v_base    TEXT;
  v_headers JSONB;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://aurixa-mission-control.lovable.app'
  );
  v_base := rtrim(v_base, '/');

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization',
    'Bearer ' || COALESCE(current_setting('app.settings.cron_secret', true), '')
  );

  PERFORM cron.unschedule('deployment-drain-1min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deployment-drain-1min');

  PERFORM cron.schedule(
    'deployment-drain-1min',
    '* * * * *',
    format(
      $f$SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:='{"source":"pg_cron"}'::jsonb)$f$,
      v_base || '/hooks/deployment-drain',
      v_headers
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