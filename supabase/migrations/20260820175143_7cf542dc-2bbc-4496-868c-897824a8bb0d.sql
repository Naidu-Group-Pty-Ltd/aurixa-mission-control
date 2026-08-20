DO $$
DECLARE
  v_base text := 'https://mission-control.aurixasystems.com.au';
  v_secret text;
  j record;
  spec text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'cron_secret missing from vault';
  END IF;

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