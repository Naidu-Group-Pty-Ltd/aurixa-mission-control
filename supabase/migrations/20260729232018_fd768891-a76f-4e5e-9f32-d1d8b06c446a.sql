select cron.unschedule('crm-sweep-hourly') where exists (select 1 from cron.job where jobname = 'crm-sweep-hourly');

select cron.schedule('crm-sweep-hourly', '23 * * * *', $cron$
  select net.http_post(
    url := 'https://aurixa-mission-control.lovable.app/hooks/crm-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Lovable-Context', 'cron',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'DRIFT_REFRESH_TOKEN' limit 1)
    ),
    body := '{}'::jsonb
  ) as request_id;
$cron$);