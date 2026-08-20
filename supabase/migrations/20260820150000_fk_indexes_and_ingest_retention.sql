-- Index the foreign keys that a parent delete has to scan.
--
-- Postgres indexes the referenced side of a foreign key and never the
-- referencing side. Every `ON DELETE CASCADE` / `ON DELETE SET NULL` therefore
-- sequentially scans the child table for each parent row deleted — so deleting
-- one clone scans a dozen tables, and deleting a CRM account scans its tasks,
-- contracts and feedback requests.
--
-- Derived from the migrations' own parse tree rather than by grepping for
-- REFERENCES: an earlier regex pass ran past a `CREATE TABLE` boundary in a file
-- that puts several columns on one line, invented two columns on
-- `api_provider_rates` that do not exist, and missed indexes declared in forms
-- it did not anticipate. The numbers below come from pglast, and every target
-- was then checked to exist in the generated types, which come from the live
-- database.
--
-- 88 FK columns have no leading index. 68 of those carry a referential action,
-- and 35 of those are ALSO filtered on directly in application code
-- (`.eq("clone_id", …)` and friends), so the same missing index costs twice —
-- once on delete, once on every read. Those 35 are the set below.
--
-- The other 33 are left alone on purpose. An index nothing reads and no cascade
-- traverses is write amplification for no gain, and most of the remainder are
-- `created_by`-style audit columns that nothing ever filters on.
--
-- `IF NOT EXISTS` throughout, and deliberately not CONCURRENTLY: a migration
-- runs inside a transaction, where CONCURRENTLY is rejected. These tables are
-- small enough for that to be the right trade today; one that grows past it
-- wants its index built by hand, outside a migration.

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
-- ── Retention for the support ingest limiter ────────────────────────────────
--
-- `support_ingest_requests` takes one row per support-portal ingest request and
-- has never had anything delete them. The limiter that owns the table then runs
-- three `count(*) exact` queries over it on every request.
--
-- That combination degrades in the one direction that matters. As the table
-- grows the counts get slower, and the limiter's own error path is
-- `catch → return { limited: false }` — it fails OPEN, deliberately, so a broken
-- limiter cannot take support intake down with it. Unbounded growth therefore
-- ends with the rate limit quietly not being enforced on a public endpoint.
--
-- Its sibling `token_api_rate_limits` has been purged at 14 days since the day
-- it was created. Seven is plenty here: the longest window this limiter
-- consults is 24 hours.
DO $$ BEGIN
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
