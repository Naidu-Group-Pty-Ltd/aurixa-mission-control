ALTER TABLE public.clone_backends
  ADD COLUMN IF NOT EXISTS parity_report jsonb,
  ADD COLUMN IF NOT EXISTS parity_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS repo_retarget jsonb;

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'handoff_consent_received';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'github_app_access_drift';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'api_usage_settlement_failed';

CREATE INDEX IF NOT EXISTS idx_api_usage_charges_clone_id ON public.api_usage_charges(clone_id);
CREATE INDEX IF NOT EXISTS idx_billing_handoffs_clone_id ON public.billing_handoffs(clone_id);
CREATE INDEX IF NOT EXISTS idx_billing_handoffs_tenant_id ON public.billing_handoffs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_clone_addon_purchases_tenant_id ON public.clone_addon_purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_codex_remediations_clone_id ON public.codex_remediations(clone_id);
CREATE INDEX IF NOT EXISTS idx_codex_scan_jobs_clone_id ON public.codex_scan_jobs(clone_id);
CREATE INDEX IF NOT EXISTS idx_crm_contracts_account_id ON public.crm_contracts(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_contracts_deal_id ON public.crm_contracts(deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_line_items_deal_id ON public.crm_deal_line_items(deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_feedback_requests_account_id ON public.crm_feedback_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_account_id ON public.crm_tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_clone_id ON public.feedback_submissions(clone_id);
CREATE INDEX IF NOT EXISTS idx_feedback_token_grants_submission_id ON public.feedback_token_grants(submission_id);
CREATE INDEX IF NOT EXISTS idx_handoff_events_actor_user_id ON public.handoff_events(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_handoff_observability_configs_clone_id ON public.handoff_observability_configs(clone_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_clone_id ON public.payment_methods(clone_id);
CREATE INDEX IF NOT EXISTS idx_purchases_handoff_id ON public.purchases(handoff_id);
CREATE INDEX IF NOT EXISTS idx_remediation_runs_clone_id ON public.remediation_runs(clone_id);
CREATE INDEX IF NOT EXISTS idx_remediation_runs_finding_id ON public.remediation_runs(finding_id);
CREATE INDEX IF NOT EXISTS idx_remediation_runs_remediation_id ON public.remediation_runs(remediation_id);
CREATE INDEX IF NOT EXISTS idx_security_assessment_comments_clone_id ON public.security_assessment_comments(clone_id);
CREATE INDEX IF NOT EXISTS idx_security_assessment_events_actor_user_id ON public.security_assessment_events(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_security_assessment_events_clone_id ON public.security_assessment_events(clone_id);
CREATE INDEX IF NOT EXISTS idx_security_assessment_events_partner_id ON public.security_assessment_events(partner_id);
CREATE INDEX IF NOT EXISTS idx_security_external_tickets_codex_finding_id ON public.security_external_tickets(codex_finding_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_clone_id ON public.security_findings(clone_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_codex_finding_id ON public.security_findings(codex_finding_id);
CREATE INDEX IF NOT EXISTS idx_security_partner_assignments_clone_id ON public.security_partner_assignments(clone_id);
CREATE INDEX IF NOT EXISTS idx_security_partner_memberships_user_id ON public.security_partner_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_security_reports_clone_id ON public.security_reports(clone_id);
CREATE INDEX IF NOT EXISTS idx_support_assistant_activity_clone_id ON public.support_assistant_activity(clone_id);
CREATE INDEX IF NOT EXISTS idx_support_assistant_activity_tenant_id ON public.support_assistant_activity(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_clone_id ON public.support_tickets(clone_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_codex_finding_id ON public.support_tickets(codex_finding_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant_id ON public.support_tickets(tenant_id);

CREATE OR REPLACE FUNCTION public.cron_delivery_health(_since_hours INT DEFAULT 24)
RETURNS TABLE (
  jobname          TEXT,
  schedule         TEXT,
  active           BOOLEAN,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  runs             BIGINT,
  last_http_status INT,
  last_http_error  TEXT,
  delivered        BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net
AS $$
DECLARE
  _cutoff TIMESTAMPTZ := now() - make_interval(hours => GREATEST(COALESCE(_since_hours, 24), 1));
BEGIN
  RETURN QUERY
  WITH runs AS (
    SELECT d.jobid,
           max(d.start_time)                          AS last_run_at,
           count(*)                                   AS run_count,
           (array_agg(d.status ORDER BY d.start_time DESC))[1] AS last_status,
           (array_agg(d.return_message ORDER BY d.start_time DESC))[1] AS last_message
      FROM cron.job_run_details d
     WHERE d.start_time >= _cutoff
     GROUP BY d.jobid
  ),
  resp AS (
    SELECT r.id, r.status_code, r.error_msg, r.created
      FROM net._http_response r
     WHERE r.created >= _cutoff
  )
  SELECT j.jobname::TEXT,
         j.schedule::TEXT,
         j.active,
         runs.last_run_at,
         runs.last_status::TEXT,
         COALESCE(runs.run_count, 0),
         lr.status_code,
         lr.error_msg::TEXT,
         CASE WHEN lr.status_code IS NULL THEN NULL
              ELSE lr.status_code BETWEEN 200 AND 299 END
    FROM cron.job j
    LEFT JOIN runs ON runs.jobid = j.jobid
    LEFT JOIN LATERAL (
      SELECT rp.status_code, rp.error_msg
        FROM resp rp
       WHERE runs.last_message IS NOT NULL
         AND rp.id::TEXT = regexp_replace(runs.last_message, '\D', '', 'g')
       LIMIT 1
    ) lr ON TRUE
   ORDER BY j.jobname;
END $$;

REVOKE ALL ON FUNCTION public.cron_delivery_health(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cron_delivery_health(INT) TO service_role;

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
  RAISE WARNING 'orphan hook workers NOT scheduled (%).', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('support-ingest-requests-purge')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'support-ingest-requests-purge');
  PERFORM cron.schedule(
    'support-ingest-requests-purge', '35 3 * * *',
    $purge$
    DELETE FROM public.support_ingest_requests WHERE created_at < now() - interval '7 days';
    $purge$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'support ingest purge NOT scheduled (%).', SQLERRM;
END $$;