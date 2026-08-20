DO $$
DECLARE
  v_base text := 'https://mission-control.aurixasystems.com.au';
  v_secret text;
  j record;
  spec text;
BEGIN
  -- Fail-soft, not fail-closed. This aborted the whole migration run when the
  -- secret was absent, which made the corpus unreplayable on any database whose
  -- operator had not set it yet -- including every freshly provisioned clone
  -- backend. Re-pointing jobs at a host with no token to send is not an
  -- improvement on leaving them alone, so when there is no secret this does
  -- nothing and says so.
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
  v_secret := COALESCE(v_secret, NULLIF(current_setting('app.settings.cron_secret', true), ''));
  IF v_secret IS NULL THEN
    RAISE NOTICE 'cron_secret not configured -- leaving existing cron commands untouched';
    RETURN;
  END IF;

  -- The canonical host, overridable by the operator rather than pinned here.
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    v_base
  );
  v_base := rtrim(v_base, '/');

  -- Remove duplicate workers (same hook scheduled twice under two names).
  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname IN ('aurixa-drift-refresh-5min', 'aurixa-edge-drain-1min', 'aurixa-edge-drift-daily');

  -- Re-point every HTTP job at the canonical host with a valid bearer token.
  FOR j IN
    SELECT jobname, schedule, substring(command from 'https://[^'']*/hooks/([a-z0-9-]+)') AS hook
    FROM cron.job
    WHERE command LIKE '%/hooks/%'
  LOOP
    IF j.hook IS NULL THEN CONTINUE; END IF;
    spec := format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Lovable-Context','cron','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 60000
      );$f$,
      v_base || '/hooks/' || j.hook
    );
    PERFORM cron.schedule(j.jobname, j.schedule, spec);
  END LOOP;
END $$;