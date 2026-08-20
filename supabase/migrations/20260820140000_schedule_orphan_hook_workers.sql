-- Six /hooks workers each document the cron cadence that schedules them, and
-- nothing schedules any of them.
--
-- Every one of these files opens by stating its own schedule:
--
--   hooks/edge-drain                  "Called by pg_cron every minute"
--   hooks/edge-drift                  "Daily edge drift check"
--   hooks/handoff-observability-poll  "pg_cron POSTs here every 15 minutes"
--   hooks/handoff-parity-refresh      "Cron-invoked … older than 6 hours"
--   hooks/drift-refresh               "pg_cron schedules a POST here every 5 min"
--   hooks/api-usage-settle            "Cron-invoked settlement … Daily is enough"
--
-- None of the six appears in any migration, any GitHub workflow, or any host
-- cron config. `hooks/run-schedules` is not a general dispatcher either — it
-- only walks `cascade_schedules` rows. They have never run.
--
-- The one that costs money: `api-usage-settle` closes every ended billing
-- period and pushes what it owes onto the tenant's next Stripe invoice. Its own
-- comment says a missed run "costs latency, never revenue" — which is true of a
-- missed run and not of a job that has never run. `edge_provisioning_jobs` has
-- likewise had no drainer, and `edge-drift` marks the drift that `edge-drain`
-- would then repair.
--
-- Also removes a duplicate: `/hooks/brand-drift` is scheduled twice, as
-- `brand-drift-30min` (20260607) and `aurixa-brand-drift-scan` (20260609). Both
-- are `*/30 * * * *` against the same URL and neither unschedules the other, so
-- the brand drift scan has been running twice every half hour. The later name
-- is kept.
--
-- URLs are built from `app.settings.public_app_url` where it is set, falling
-- back to the host every existing job hardcodes. Setting the GUC is what stops
-- the next domain change from silently pointing cron at a dead host:
--
--   ALTER DATABASE postgres SET app.settings.public_app_url = 'https://…';

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  v_base    TEXT;
  v_headers JSONB;
  j         RECORD;
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

  -- The duplicate brand-drift job. Keeping `aurixa-brand-drift-scan` because it
  -- is the one the most recent migration (re)created.
  PERFORM cron.unschedule('brand-drift-30min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brand-drift-30min');

  FOR j IN
    SELECT * FROM (VALUES
      ('api-usage-settle-daily',          '20 4 * * *',   'api-usage-settle'),
      ('edge-drain-1min',                 '* * * * *',    'edge-drain'),
      ('edge-drift-daily',                '40 3 * * *',   'edge-drift'),
      ('handoff-observability-poll-15min','*/15 * * * *', 'handoff-observability-poll'),
      ('handoff-parity-refresh-hourly',   '10 * * * *',   'handoff-parity-refresh'),
      ('drift-refresh-5min',              '*/5 * * * *',  'drift-refresh')
    ) AS t(jobname, schedule, hook)
  LOOP
    PERFORM cron.unschedule(j.jobname)
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = j.jobname);

    PERFORM cron.schedule(
      j.jobname,
      j.schedule,
      format(
        $f$SELECT net.http_post(url:=%L, headers:=%L::jsonb, body:='{"source":"pg_cron"}'::jsonb)$f$,
        v_base || '/hooks/' || j.hook,
        v_headers
      )
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'orphan hook workers NOT scheduled (%).', SQLERRM;
END $$;
