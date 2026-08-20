-- Index every foreign key's referencing column.
--
-- Postgres indexes the referenced side of a foreign key automatically and the
-- referencing side never, so each pair below was a sequential scan on joins and
-- on every ON DELETE/ON UPDATE check. Guarded by scripts/check-fk-indexes.mjs,
-- which reads the pairs in the marked block below as index coverage.
--
-- A few of these tables exist only in later/unapplied migrations, so the loop
-- skips anything absent rather than aborting the whole batch.
DO $$
DECLARE
  p record;
  idx text;
BEGIN
  -- fk-index-coverage: begin
  FOR p IN SELECT * FROM (VALUES
    ('client_supabase_accounts','created_by'),
    ('clone_deployments','provider_slug'),
    ('clone_deployments','requested_by'),
    ('clone_edge_config','posture_preset'),
    ('clone_handoffs','backend_id'),
    ('clone_handoffs','client_account_id'),
    ('clone_handoffs','created_by'),
    ('clone_handoffs','policy_id'),
    ('clone_health_beacons','handoff_id'),
    ('clone_stripe_configs','created_by'),
    ('codex_remediation_reviews','reviewer_id'),
    ('codex_remediations','cascade_event_id'),
    ('codex_remediations','fix_confirmed_by_job_id'),
    ('codex_remediations','merged_by'),
    ('codex_remediations','rejected_by'),
    ('codex_remediations','requested_by'),
    ('codex_scan_events','actor'),
    ('codex_scan_jobs','requested_by'),
    ('crm_activities','contact_id'),
    ('crm_churn_events','contract_id'),
    ('crm_feedback_requests','contact_id'),
    ('crm_offboarding_runs','churn_event_id'),
    ('crm_tickets','contact_id'),
    ('deployment_events','actor_user_id'),
    ('edge_dns_records','created_by'),
    ('edge_provisioning_jobs','provider_slug'),
    ('feedback_token_grants','ledger_id'),
    ('github_secret_syncs','triggered_by'),
    ('handoff_billing_splits','created_by'),
    ('handoff_contracts','terms_version_id'),
    ('handoff_invites','created_by'),
    ('handoff_observability_configs','created_by'),
    ('handoff_terms_versions','created_by'),
    ('hosting_teardowns','requested_by'),
    ('invoices','purchase_id'),
    ('plan_change_events','tenant_id'),
    ('platform_hosting_config','updated_by'),
    ('pricing_module_map','overridden_by'),
    ('remediation_runs','approved_by'),
    ('remediation_runs','rejected_by'),
    ('security_assessment_comments','author_user_id'),
    ('security_assessment_comments','partner_id'),
    ('security_assessments','assignment_id'),
    ('security_assessments','created_by'),
    ('security_external_tickets','created_by'),
    ('security_findings','partner_id'),
    ('security_findings','submitted_by'),
    ('security_intake_sources','created_by'),
    ('security_partner_assignments','assigned_by'),
    ('security_partner_assignments','partner_id'),
    ('security_partner_memberships','approved_by'),
    ('security_partners','created_by'),
    ('security_reports','partner_id'),
    ('security_reports','reviewed_by'),
    ('security_reports','submitted_by'),
    ('storefront_access_grants','created_by'),
    ('support_tickets','priority_overridden_by'),
    ('support_tickets','source_slug'),
    ('token_ledger','report_job_id'),
    ('user_invites','revoked_by')
  ) AS t(tbl, col)
  -- fk-index-coverage: end
  LOOP
    CONTINUE WHEN to_regclass('public.' || quote_ident(p.tbl)) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = p.tbl AND column_name = p.col
    );
    idx := format('idx_%s_%s', p.tbl, p.col);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)', idx, p.tbl, p.col
    );
  END LOOP;
END $$;