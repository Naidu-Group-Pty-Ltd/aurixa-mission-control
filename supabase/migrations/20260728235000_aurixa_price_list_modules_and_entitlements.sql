-- Aurixa price list — add-on modules and the per-tier entitlement matrix.
--
-- Transcribed from the signed-off pricing sheet. Every figure is TAX-INCLUSIVE:
-- these are the amounts a customer pays, and GST is derived from them (÷11),
-- never added to them.
--
-- Scope note, deliberately narrow. This migration touches only things that
-- CANNOT put a wrong price in front of a customer:
--
--   • addon_modules carries no stripe_price_id and is not directly
--     checkout-able, so it is display data and safe to replace here.
--   • plan_module_entitlements is new and inert until something reads it.
--
-- Tier prices are NOT changed here. `seat_plans.price_cents` is what the
-- pricing page shows while `seat_plans.stripe_price_id` is what Stripe
-- actually charges, so moving one without the other would advertise $504 and
-- bill $749. That cutover is atomic with creating the Stripe prices and lives
-- in the sync script (scripts/sync-stripe-catalog.ts).

-- ─── 1. Add-on modules ──────────────────────────────────────────────────────

-- The previous six placeholder add-ons are not in the signed-off sheet.
-- Deactivated rather than deleted, so any row referencing them still resolves.
UPDATE public.addon_modules SET is_active = false
 WHERE slug NOT IN ('market-updates', 'commercial-industrial', 'opportunity-marketplace', 'intelligence-hub', 'report-comparisons', 'cashflow-comparisons', 'email-copilot', 'call-logs', 'portfolio-analysis', 'send-portfolio', 'client-forms', 'borrowing-capacity', 'lenders', 'client-ai', 'agreements', 'marketing', 'deal-pipeline', 'aml-ctf', 'model-hub', 'finance-portal', 'integrations', 'api-usage', 'aurixa-agent');

INSERT INTO public.addon_modules
  (slug, name, description, price_min_cents, price_max_cents, currency, billing_period,
   category, included_in_plans, is_active, sort_order, metadata)
VALUES
  ('market-updates', 'Market Updates', NULL, 5900, 5900, 'AUD', 'monthly', 'Main Dashboard', '["growth", "scale"]'::jsonb, true, 10, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('commercial-industrial', 'Commercial / Industrial', NULL, 16900, 16900, 'AUD', 'monthly', 'Main Dashboard', '["scale"]'::jsonb, true, 20, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('opportunity-marketplace', 'Opportunity Marketplace', NULL, 16900, 16900, 'AUD', 'monthly', 'Main Dashboard', '["scale"]'::jsonb, true, 30, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('intelligence-hub', 'Aurixa Intelligence Hub', NULL, 7900, 7900, 'AUD', 'monthly', 'Reports & Analysis', '[]'::jsonb, true, 40, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('report-comparisons', 'Generated Reports — Comparisons', NULL, 9900, 9900, 'AUD', 'monthly', 'Reports & Analysis', '["growth", "scale"]'::jsonb, true, 50, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('cashflow-comparisons', 'Cash Flow Analysis — Comparisons', NULL, 9900, 9900, 'AUD', 'monthly', 'Reports & Analysis', '["growth", "scale"]'::jsonb, true, 60, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('email-copilot', 'Email Copilot', 'Unlocks client Emails, which stay off on every tier without it.', 9900, 9900, 'AUD', 'monthly', 'Client & CRM', '[]'::jsonb, true, 70, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('call-logs', 'Call Logs', 'Plus a custom build price if requested.', 22500, 22500, 'AUD', 'monthly', 'Client & CRM', '[]'::jsonb, true, 80, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('portfolio-analysis', 'Portfolio Analysis', NULL, 12500, 12500, 'AUD', 'monthly', 'Client & CRM', '["scale"]'::jsonb, true, 90, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('send-portfolio', 'Send Portfolio To Client', NULL, 6900, 6900, 'AUD', 'monthly', 'Client & CRM', '["scale"]'::jsonb, true, 100, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('client-forms', 'Client Forms', 'Enabled on every tier; price applies to standalone purchase.', 4900, 4900, 'AUD', 'monthly', 'Client & CRM', '["launch", "growth", "scale"]'::jsonb, true, 110, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('borrowing-capacity', 'Borrowing Capacity', NULL, 22500, 22500, 'AUD', 'monthly', 'Client & CRM', '["scale"]'::jsonb, true, 120, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('lenders', 'Lenders', 'In development.', 9900, 9900, 'AUD', 'monthly', 'Client & CRM', '[]'::jsonb, true, 130, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('client-ai', 'Client AI', NULL, 7900, 7900, 'AUD', 'monthly', 'Client & CRM', '["scale"]'::jsonb, true, 140, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('agreements', 'Agreements', NULL, 6900, 6900, 'AUD', 'monthly', 'Operations', '["scale"]'::jsonb, true, 150, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('marketing', 'Marketing', NULL, 17900, 17900, 'AUD', 'monthly', 'Operations', '["scale"]'::jsonb, true, 160, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('deal-pipeline', 'Deal Pipeline', NULL, 9900, 9900, 'AUD', 'monthly', 'Operations', '["growth", "scale"]'::jsonb, true, 170, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('aml-ctf', 'AML / CTF Compliance', 'The difference between a tier''s with- and without-AML headline price.', 19500, 19500, 'AUD', 'monthly', 'AML / CTF Compliance', '[]'::jsonb, true, 180, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('model-hub', 'Model Hub', NULL, 19500, 19500, 'AUD', 'monthly', 'Administration', '["scale"]'::jsonb, true, 190, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('finance-portal', 'Finance Portal', 'Also unlocks client Send To Finance and Finance Messages.', 22500, 22500, 'AUD', 'monthly', 'Administration', '["scale"]'::jsonb, true, 200, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('integrations', 'Integrations', 'Subject to the client integrating their own APIs.', 13500, 13500, 'AUD', 'monthly', 'Administration', '[]'::jsonb, true, 210, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('api-usage', 'API Usage', NULL, 14900, 14900, 'AUD', 'monthly', 'Administration', '["scale"]'::jsonb, true, 220, '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('aurixa-agent', 'Aurixa Agent', NULL, 37500, 37500, 'AUD', 'monthly', 'AI Assistant', '[]'::jsonb, true, 230, '{"tax_inclusive": true, "gst_included": true}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  name              = EXCLUDED.name,
  description       = EXCLUDED.description,
  price_min_cents   = EXCLUDED.price_min_cents,
  price_max_cents   = EXCLUDED.price_max_cents,
  currency          = EXCLUDED.currency,
  billing_period    = EXCLUDED.billing_period,
  category          = EXCLUDED.category,
  included_in_plans = EXCLUDED.included_in_plans,
  is_active         = true,
  sort_order        = EXCLUDED.sort_order,
  metadata          = EXCLUDED.metadata;

-- ─── 2. Per-tier sub-module entitlements ────────────────────────────────────
--
-- One row per (tier, sub-module). `entitlement_key` is what a clone gates on;
-- it is derived from the module and sub-module names so it survives a rename
-- of the display text.

CREATE TABLE IF NOT EXISTS public.plan_module_entitlements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_slug       TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  module_name     TEXT NOT NULL,
  sub_module_name TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_slug, entitlement_key)
);

CREATE INDEX IF NOT EXISTS plan_module_entitlements_plan_idx
  ON public.plan_module_entitlements (plan_slug) WHERE enabled;

ALTER TABLE public.plan_module_entitlements ENABLE ROW LEVEL SECURITY;

-- Entitlements are product facts, not customer data: every clone needs to read
-- them to know what to show, and they reveal nothing about any tenant.
DROP POLICY IF EXISTS "Entitlements are public product data" ON public.plan_module_entitlements;
CREATE POLICY "Entitlements are public product data"
  ON public.plan_module_entitlements FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.plan_module_entitlements TO anon, authenticated;
GRANT ALL    ON public.plan_module_entitlements TO service_role;

INSERT INTO public.plan_module_entitlements
  (plan_slug, entitlement_key, module_name, sub_module_name, enabled)
VALUES
  ('launch', 'generated-reports.investment', 'Generated Reports', 'Investment', true),
  ('launch', 'generated-reports.comparisons', 'Generated Reports', 'Comparisons', false),
  ('launch', 'cash-flow-analysis.10-year-cash-flow', 'Cash Flow Analysis', '10 Year Cash Flow', true),
  ('launch', 'cash-flow-analysis.comparisons', 'Cash Flow Analysis', 'Comparisons', false),
  ('launch', 'clients.send-to-finance', 'Clients', 'Send To Finance', false),
  ('launch', 'clients.review', 'Clients', 'Review', true),
  ('launch', 'clients.portfolio-analysis', 'Clients', 'Portfolio Analysis', false),
  ('launch', 'clients.download-client-details-pdf', 'Clients', 'Download Client Details PDF', true),
  ('launch', 'clients.send-portfolio-to-client', 'Clients', 'Send Portfolio To Client', false),
  ('launch', 'clients.send-agreement', 'Clients', 'Send Agreement', false),
  ('launch', 'clients.portal-access', 'Clients', 'Portal Access', true),
  ('launch', 'clients.view-as-client', 'Clients', 'View As Client', true),
  ('launch', 'clients.overview', 'Clients', 'Overview', true),
  ('launch', 'clients.personal', 'Clients', 'Personal', true),
  ('launch', 'clients.properties', 'Clients', 'Properties', true),
  ('launch', 'clients.deals', 'Clients', 'Deals', false),
  ('launch', 'clients.employment', 'Clients', 'Employment', true),
  ('launch', 'clients.financials', 'Clients', 'Financials', true),
  ('launch', 'clients.reports', 'Clients', 'Reports', true),
  ('launch', 'clients.sent-reports', 'Clients', 'Sent Reports', true),
  ('launch', 'clients.requests', 'Clients', 'Requests', true),
  ('launch', 'clients.emails', 'Clients', 'Emails', false),
  ('launch', 'clients.conversations', 'Clients', 'Conversations', false),
  ('launch', 'clients.appointments', 'Clients', 'Appointments', false),
  ('launch', 'clients.portal-messages', 'Clients', 'Portal Messages', true),
  ('launch', 'clients.finance-messages', 'Clients', 'Finance Messages', false),
  ('launch', 'clients.notes', 'Clients', 'Notes', true),
  ('launch', 'clients.reminders', 'Clients', 'Reminders', true),
  ('launch', 'clients.client-forms', 'Clients', 'Client Forms', true),
  ('launch', 'clients.files', 'Clients', 'Files', true),
  ('launch', 'clients.activity-documents', 'Clients', 'Activity/Documents', true),
  ('launch', 'clients.borrowing-capacity', 'Clients', 'Borrowing Capacity', false),
  ('launch', 'clients.lenders', 'Clients', 'Lenders', false),
  ('launch', 'clients.ai', 'Clients', 'AI', false),
  ('growth', 'generated-reports.investment', 'Generated Reports', 'Investment', true),
  ('growth', 'generated-reports.comparisons', 'Generated Reports', 'Comparisons', true),
  ('growth', 'cash-flow-analysis.10-year-cash-flow', 'Cash Flow Analysis', '10 Year Cash Flow', true),
  ('growth', 'cash-flow-analysis.comparisons', 'Cash Flow Analysis', 'Comparisons', true),
  ('growth', 'clients.send-to-finance', 'Clients', 'Send To Finance', false),
  ('growth', 'clients.review', 'Clients', 'Review', true),
  ('growth', 'clients.portfolio-analysis', 'Clients', 'Portfolio Analysis', false),
  ('growth', 'clients.download-client-details-pdf', 'Clients', 'Download Client Details PDF', true),
  ('growth', 'clients.send-portfolio-to-client', 'Clients', 'Send Portfolio To Client', false),
  ('growth', 'clients.send-agreement', 'Clients', 'Send Agreement', false),
  ('growth', 'clients.portal-access', 'Clients', 'Portal Access', true),
  ('growth', 'clients.view-as-client', 'Clients', 'View As Client', true),
  ('growth', 'clients.overview', 'Clients', 'Overview', true),
  ('growth', 'clients.personal', 'Clients', 'Personal', true),
  ('growth', 'clients.properties', 'Clients', 'Properties', true),
  ('growth', 'clients.deals', 'Clients', 'Deals', true),
  ('growth', 'clients.employment', 'Clients', 'Employment', true),
  ('growth', 'clients.financials', 'Clients', 'Financials', true),
  ('growth', 'clients.reports', 'Clients', 'Reports', true),
  ('growth', 'clients.sent-reports', 'Clients', 'Sent Reports', true),
  ('growth', 'clients.requests', 'Clients', 'Requests', true),
  ('growth', 'clients.emails', 'Clients', 'Emails', false),
  ('growth', 'clients.conversations', 'Clients', 'Conversations', false),
  ('growth', 'clients.appointments', 'Clients', 'Appointments', false),
  ('growth', 'clients.portal-messages', 'Clients', 'Portal Messages', true),
  ('growth', 'clients.finance-messages', 'Clients', 'Finance Messages', false),
  ('growth', 'clients.notes', 'Clients', 'Notes', true),
  ('growth', 'clients.reminders', 'Clients', 'Reminders', true),
  ('growth', 'clients.client-forms', 'Clients', 'Client Forms', true),
  ('growth', 'clients.files', 'Clients', 'Files', true),
  ('growth', 'clients.activity-documents', 'Clients', 'Activity/Documents', true),
  ('growth', 'clients.borrowing-capacity', 'Clients', 'Borrowing Capacity', false),
  ('growth', 'clients.lenders', 'Clients', 'Lenders', false),
  ('growth', 'clients.ai', 'Clients', 'AI', false),
  ('scale', 'generated-reports.investment', 'Generated Reports', 'Investment', true),
  ('scale', 'generated-reports.comparisons', 'Generated Reports', 'Comparisons', true),
  ('scale', 'cash-flow-analysis.10-year-cash-flow', 'Cash Flow Analysis', '10 Year Cash Flow', true),
  ('scale', 'cash-flow-analysis.comparisons', 'Cash Flow Analysis', 'Comparisons', true),
  ('scale', 'clients.send-to-finance', 'Clients', 'Send To Finance', true),
  ('scale', 'clients.review', 'Clients', 'Review', true),
  ('scale', 'clients.portfolio-analysis', 'Clients', 'Portfolio Analysis', true),
  ('scale', 'clients.download-client-details-pdf', 'Clients', 'Download Client Details PDF', true),
  ('scale', 'clients.send-portfolio-to-client', 'Clients', 'Send Portfolio To Client', true),
  ('scale', 'clients.send-agreement', 'Clients', 'Send Agreement', true),
  ('scale', 'clients.portal-access', 'Clients', 'Portal Access', true),
  ('scale', 'clients.view-as-client', 'Clients', 'View As Client', true),
  ('scale', 'clients.overview', 'Clients', 'Overview', true),
  ('scale', 'clients.personal', 'Clients', 'Personal', true),
  ('scale', 'clients.properties', 'Clients', 'Properties', true),
  ('scale', 'clients.deals', 'Clients', 'Deals', true),
  ('scale', 'clients.employment', 'Clients', 'Employment', true),
  ('scale', 'clients.financials', 'Clients', 'Financials', true),
  ('scale', 'clients.reports', 'Clients', 'Reports', true),
  ('scale', 'clients.sent-reports', 'Clients', 'Sent Reports', true),
  ('scale', 'clients.requests', 'Clients', 'Requests', true),
  ('scale', 'clients.emails', 'Clients', 'Emails', false),
  ('scale', 'clients.conversations', 'Clients', 'Conversations', true),
  ('scale', 'clients.appointments', 'Clients', 'Appointments', true),
  ('scale', 'clients.portal-messages', 'Clients', 'Portal Messages', true),
  ('scale', 'clients.finance-messages', 'Clients', 'Finance Messages', true),
  ('scale', 'clients.notes', 'Clients', 'Notes', true),
  ('scale', 'clients.reminders', 'Clients', 'Reminders', true),
  ('scale', 'clients.client-forms', 'Clients', 'Client Forms', true),
  ('scale', 'clients.files', 'Clients', 'Files', true),
  ('scale', 'clients.activity-documents', 'Clients', 'Activity/Documents', true),
  ('scale', 'clients.borrowing-capacity', 'Clients', 'Borrowing Capacity', true),
  ('scale', 'clients.lenders', 'Clients', 'Lenders', false),
  ('scale', 'clients.ai', 'Clients', 'AI', true)
ON CONFLICT (plan_slug, entitlement_key) DO UPDATE SET
  module_name     = EXCLUDED.module_name,
  sub_module_name = EXCLUDED.sub_module_name,
  enabled         = EXCLUDED.enabled,
  updated_at      = now();

NOTIFY pgrst, 'reload schema';
