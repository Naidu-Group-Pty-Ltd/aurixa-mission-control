-- ============ ENUMS ============
DO $$ BEGIN CREATE TYPE public.crm_lifecycle_stage AS ENUM ('lead','opportunity','onboarding','active','at_risk','churned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_deal_stage AS ENUM ('discovery','demo','proposal','contract','won','lost'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_activity_kind AS ENUM ('note','call','email','meeting','system','status_change','payment','ticket','feedback','dispute','churn'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_task_status AS ENUM ('open','in_progress','done','canceled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_ticket_type AS ENUM ('support','bug','billing','feature','incident'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_ticket_severity AS ENUM ('low','normal','high','critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_ticket_status AS ENUM ('open','in_progress','waiting_client','resolved','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_dispute_kind AS ENUM ('chargeback','billing_disagreement','service_credit','contractual','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_dispute_status AS ENUM ('open','under_review','evidence_submitted','won','lost','withdrawn','settled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_churn_reason AS ENUM ('price','missing_capability','switched_provider','internal_build','non_payment','business_closed','poor_experience','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_offboarding_path AS ENUM ('ownership_transfer','export_and_terminate','terminate_only'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ ACCOUNTS ============
CREATE TABLE IF NOT EXISTS public.crm_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  classification TEXT,
  lifecycle_stage public.crm_lifecycle_stage NOT NULL DEFAULT 'lead',
  owner_user_id UUID,
  source TEXT,
  website TEXT,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  tenant_id UUID,
  health_score INTEGER,
  health_computed_at TIMESTAMPTZ,
  arr_cents BIGINT NOT NULL DEFAULT 0,
  mrr_cents BIGINT NOT NULL DEFAULT 0,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  last_contacted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_accounts TO authenticated;
GRANT ALL ON public.crm_accounts TO service_role;
ALTER TABLE public.crm_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  job_title TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  marketing_consent BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_contacts TO authenticated;
GRANT ALL ON public.crm_contacts TO service_role;
ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  kind public.crm_activity_kind NOT NULL DEFAULT 'note',
  title TEXT NOT NULL,
  body TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID,
  actor_label TEXT,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_activities TO authenticated;
GRANT ALL ON public.crm_activities TO service_role;
ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  deal_id UUID,
  ticket_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  status public.crm_task_status NOT NULL DEFAULT 'open',
  due_at TIMESTAMPTZ,
  assignee_user_id UUID,
  completed_at TIMESTAMPTZ,
  created_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_tasks TO authenticated;
GRANT ALL ON public.crm_tasks TO service_role;
ALTER TABLE public.crm_tasks ENABLE ROW LEVEL SECURITY;

-- ============ DEALS ============
CREATE TABLE IF NOT EXISTS public.crm_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stage public.crm_deal_stage NOT NULL DEFAULT 'discovery',
  tier_slug TEXT,
  seats INTEGER NOT NULL DEFAULT 1,
  expected_mrr_cents BIGINT NOT NULL DEFAULT 0,
  setup_fee_cents BIGINT NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 20,
  expected_close_date DATE,
  won_at TIMESTAMPTZ,
  lost_at TIMESTAMPTZ,
  lost_reason TEXT,
  owner_user_id UUID,
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  storefront_grant_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_deals TO authenticated;
GRANT ALL ON public.crm_deals TO service_role;
ALTER TABLE public.crm_deals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_deal_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES public.crm_deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_slug TEXT,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents BIGINT NOT NULL DEFAULT 0,
  recurring BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_deal_line_items TO authenticated;
GRANT ALL ON public.crm_deal_line_items TO service_role;
ALTER TABLE public.crm_deal_line_items ENABLE ROW LEVEL SECURITY;

-- ============ CONTRACTS / ONBOARDING ============
CREATE TABLE IF NOT EXISTS public.crm_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES public.crm_deals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  tier_slug TEXT,
  billing_cadence TEXT NOT NULL DEFAULT 'monthly',
  committed_seats INTEGER NOT NULL DEFAULT 1,
  mrr_cents BIGINT NOT NULL DEFAULT 0,
  term_start DATE NOT NULL DEFAULT CURRENT_DATE,
  term_end DATE,
  auto_renew BOOLEAN NOT NULL DEFAULT true,
  notice_period_days INTEGER NOT NULL DEFAULT 30,
  terms_version_id UUID,
  signed_by TEXT,
  signed_at TIMESTAMPTZ,
  document_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_contracts TO authenticated;
GRANT ALL ON public.crm_contracts TO service_role;
ALTER TABLE public.crm_contracts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_onboarding_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  auto_source TEXT,
  completed_at TIMESTAMPTZ,
  completed_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, step_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_onboarding_tasks TO authenticated;
GRANT ALL ON public.crm_onboarding_tasks TO service_role;
ALTER TABLE public.crm_onboarding_tasks ENABLE ROW LEVEL SECURITY;

-- ============ TICKETS / DISPUTES ============
CREATE TABLE IF NOT EXISTS public.crm_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  reference TEXT,
  type public.crm_ticket_type NOT NULL DEFAULT 'support',
  severity public.crm_ticket_severity NOT NULL DEFAULT 'normal',
  status public.crm_ticket_status NOT NULL DEFAULT 'open',
  subject TEXT NOT NULL,
  description TEXT,
  assignee_user_id UUID,
  sla_due_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  codex_finding_id UUID,
  route_error_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_tickets TO authenticated;
GRANT ALL ON public.crm_tickets TO service_role;
ALTER TABLE public.crm_tickets ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.crm_tickets(id) ON DELETE CASCADE,
  author_user_id UUID,
  author_label TEXT,
  internal BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_ticket_messages TO authenticated;
GRANT ALL ON public.crm_ticket_messages TO service_role;
ALTER TABLE public.crm_ticket_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  kind public.crm_dispute_kind NOT NULL DEFAULT 'billing_disagreement',
  status public.crm_dispute_status NOT NULL DEFAULT 'open',
  amount_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AUD',
  stripe_dispute_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  reason TEXT,
  summary TEXT,
  evidence_url TEXT,
  owner_user_id UUID,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  outcome TEXT,
  blocks_renewal BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_disputes TO authenticated;
GRANT ALL ON public.crm_disputes TO service_role;
ALTER TABLE public.crm_disputes ENABLE ROW LEVEL SECURITY;

-- ============ FEEDBACK / CHURN / OFFBOARDING ============
CREATE TABLE IF NOT EXISTS public.crm_feedback_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  campaign_key TEXT,
  channel TEXT NOT NULL DEFAULT 'email',
  requested_by UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  submission_id UUID,
  nps_score SMALLINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_feedback_requests TO authenticated;
GRANT ALL ON public.crm_feedback_requests TO service_role;
ALTER TABLE public.crm_feedback_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_churn_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES public.crm_contracts(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at TIMESTAMPTZ,
  reason public.crm_churn_reason NOT NULL DEFAULT 'other',
  reason_detail TEXT,
  competitor TEXT,
  save_attempted BOOLEAN NOT NULL DEFAULT false,
  save_outcome TEXT,
  refund_cents BIGINT NOT NULL DEFAULT 0,
  final_invoice_id UUID,
  data_retention_until TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  recorded_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_churn_events TO authenticated;
GRANT ALL ON public.crm_churn_events TO service_role;
ALTER TABLE public.crm_churn_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_offboarding_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  churn_event_id UUID REFERENCES public.crm_churn_events(id) ON DELETE SET NULL,
  path public.crm_offboarding_path NOT NULL DEFAULT 'export_and_terminate',
  status TEXT NOT NULL DEFAULT 'pending',
  handoff_id UUID,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  export_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  export_delivered_at TIMESTAMPTZ,
  export_checksum TEXT,
  destroy_after TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ,
  owner_user_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_offboarding_runs TO authenticated;
GRANT ALL ON public.crm_offboarding_runs TO service_role;
ALTER TABLE public.crm_offboarding_runs ENABLE ROW LEVEL SECURITY;

-- ============ LEAD LINK ============
ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.crm_accounts(id) ON DELETE SET NULL;

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_crm_accounts_stage ON public.crm_accounts(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_crm_accounts_clone ON public.crm_accounts(clone_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_account ON public.crm_contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_account ON public.crm_activities(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_status ON public.crm_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON public.crm_deals(stage);
CREATE INDEX IF NOT EXISTS idx_crm_deals_account ON public.crm_deals(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_tickets_status ON public.crm_tickets(status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_crm_tickets_account ON public.crm_tickets(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_ticket_messages_ticket ON public.crm_ticket_messages(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_disputes_account ON public.crm_disputes(account_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_churn_account ON public.crm_churn_events(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_offboarding_account ON public.crm_offboarding_runs(account_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_leads_account ON public.waitlist_leads(account_id);

-- ============ RLS POLICIES (operator read, admin manage) ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_accounts','crm_contacts','crm_activities','crm_tasks','crm_deals',
    'crm_deal_line_items','crm_contracts','crm_onboarding_tasks','crm_tickets',
    'crm_ticket_messages','crm_disputes','crm_feedback_requests',
    'crm_churn_events','crm_offboarding_runs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_operator_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_operator_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()))',
      t || '_operator_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) WITH CHECK (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()))',
      t || '_operator_write', t);
  END LOOP;
END $$;

-- ============ updated_at TRIGGERS ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_accounts','crm_contacts','crm_tasks','crm_deals','crm_contracts',
    'crm_onboarding_tasks','crm_tickets','crm_disputes','crm_feedback_requests',
    'crm_churn_events','crm_offboarding_runs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'set_updated_at_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
      'set_updated_at_' || t, t);
  END LOOP;
END $$;

-- Deal stage change stamps stage_changed_at
CREATE OR REPLACE FUNCTION public.crm_stamp_deal_stage()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_changed_at := now();
    IF NEW.stage = 'won' AND NEW.won_at IS NULL THEN NEW.won_at := now(); END IF;
    IF NEW.stage = 'lost' AND NEW.lost_at IS NULL THEN NEW.lost_at := now(); END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS crm_deals_stage_stamp ON public.crm_deals;
CREATE TRIGGER crm_deals_stage_stamp BEFORE UPDATE ON public.crm_deals
FOR EACH ROW EXECUTE FUNCTION public.crm_stamp_deal_stage();

-- ============ LEAD -> ACCOUNT CONVERSION ============
CREATE OR REPLACE FUNCTION public.crm_convert_lead(_lead_id UUID, _owner UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _lead public.waitlist_leads%ROWTYPE; _account_id UUID;
BEGIN
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator required';
  END IF;

  SELECT * INTO _lead FROM public.waitlist_leads WHERE id = _lead_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'lead_not_found'); END IF;
  IF _lead.account_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'account_id', _lead.account_id);
  END IF;

  INSERT INTO public.crm_accounts (name, classification, lifecycle_stage, owner_user_id, source, created_by, metadata)
  VALUES (
    COALESCE(NULLIF(_lead.entity_name, ''), _lead.first_name || ' ' || _lead.last_name),
    _lead.entity_classification,
    'opportunity',
    COALESCE(_owner, auth.uid()),
    COALESCE(_lead.source, 'waitlist'),
    auth.uid(),
    jsonb_build_object('lead_id', _lead.id, 'transaction_volume', _lead.transaction_volume,
                       'tech_stack_bottlenecks', _lead.tech_stack_bottlenecks)
  )
  RETURNING id INTO _account_id;

  INSERT INTO public.crm_contacts (account_id, first_name, last_name, email, phone, is_primary)
  VALUES (_account_id, _lead.first_name, _lead.last_name, _lead.email, _lead.mobile_number, true);

  INSERT INTO public.crm_activities (account_id, kind, title, body, actor_user_id, entity_type, entity_id)
  VALUES (_account_id, 'system', 'Converted from waitlist lead',
          _lead.first_name || ' ' || _lead.last_name || ' · ' || _lead.email,
          auth.uid(), 'waitlist_lead', _lead.id);

  INSERT INTO public.crm_deals (account_id, name, stage, owner_user_id)
  VALUES (_account_id, COALESCE(NULLIF(_lead.entity_name, ''), _lead.email) || ' — new business',
          'discovery', COALESCE(_owner, auth.uid()));

  UPDATE public.waitlist_leads
     SET account_id = _account_id,
         status = CASE WHEN status = 'new' THEN 'qualified'::lead_status ELSE status END
   WHERE id = _lead_id;

  RETURN jsonb_build_object('ok', true, 'account_id', _account_id);
END $$;

-- ============ ONBOARDING TEMPLATE ============
CREATE OR REPLACE FUNCTION public.crm_seed_onboarding(_account_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _steps TEXT[][] := ARRAY[
    ARRAY['kickoff','Kickoff call completed'],
    ARRAY['contract_signed','Contract signed'],
    ARRAY['backend_provisioned','Dedicated backend provisioned'],
    ARRAY['domain_mapped','Subdomain / custom domain mapped'],
    ARRAY['brand_cascade','Brand profile cascaded'],
    ARRAY['modules_enabled','Modules enabled for tier'],
    ARRAY['seats_issued','Seats issued to client users'],
    ARRAY['billing_live','Billing active in Stripe'],
    ARRAY['training','Training / walkthrough delivered'],
    ARRAY['go_live','Go-live confirmed']
  ];
  _i INT;
BEGIN
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator required';
  END IF;
  FOR _i IN 1 .. array_length(_steps, 1) LOOP
    INSERT INTO public.crm_onboarding_tasks (account_id, step_key, label, position)
    VALUES (_account_id, _steps[_i][1], _steps[_i][2], _i)
    ON CONFLICT (account_id, step_key) DO NOTHING;
  END LOOP;
  UPDATE public.crm_accounts SET lifecycle_stage = 'onboarding'
   WHERE id = _account_id AND lifecycle_stage IN ('lead','opportunity');
  RETURN jsonb_build_object('ok', true, 'steps', array_length(_steps, 1));
END $$;

-- ============ HEALTH SCORE ============
CREATE OR REPLACE FUNCTION public.crm_recompute_health(_account_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _acc public.crm_accounts%ROWTYPE;
  _score INT := 70;
  _open_tickets INT; _crit_tickets INT; _open_disputes INT;
  _days_since_contact NUMERIC; _nps NUMERIC; _balance INT;
BEGIN
  SELECT * INTO _acc FROM public.crm_accounts WHERE id = _account_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*) FILTER (WHERE status IN ('open','in_progress','waiting_client')),
         COUNT(*) FILTER (WHERE severity = 'critical' AND status <> 'closed')
    INTO _open_tickets, _crit_tickets
    FROM public.crm_tickets WHERE account_id = _account_id;

  SELECT COUNT(*) INTO _open_disputes
    FROM public.crm_disputes WHERE account_id = _account_id AND status IN ('open','under_review','evidence_submitted');

  _days_since_contact := EXTRACT(epoch FROM (now() - COALESCE(_acc.last_contacted_at, _acc.created_at))) / 86400.0;

  SELECT AVG(recommend_score) INTO _nps
    FROM public.feedback_submissions
   WHERE (_acc.tenant_id IS NOT NULL AND tenant_id = _acc.tenant_id)
      OR (_acc.clone_id IS NOT NULL AND clone_id = _acc.clone_id);

  IF _acc.tenant_id IS NOT NULL THEN
    SELECT available INTO _balance FROM public.token_balances WHERE tenant_id = _acc.tenant_id;
  END IF;

  _score := _score
    - LEAST(20, COALESCE(_open_tickets, 0) * 3)
    - COALESCE(_crit_tickets, 0) * 10
    - COALESCE(_open_disputes, 0) * 15
    - LEAST(15, GREATEST(0, (_days_since_contact - 30) / 4)::int)
    + CASE WHEN _nps IS NULL THEN 0 WHEN _nps >= 9 THEN 20 WHEN _nps >= 7 THEN 10 ELSE -10 END
    + CASE WHEN _balance IS NULL THEN 0 WHEN _balance > 0 THEN 10 ELSE -10 END;

  _score := GREATEST(0, LEAST(100, _score));

  UPDATE public.crm_accounts
     SET health_score = _score,
         health_computed_at = now(),
         lifecycle_stage = CASE
           WHEN lifecycle_stage = 'active' AND _score < 40 THEN 'at_risk'::crm_lifecycle_stage
           WHEN lifecycle_stage = 'at_risk' AND _score >= 60 THEN 'active'::crm_lifecycle_stage
           ELSE lifecycle_stage END
   WHERE id = _account_id;

  RETURN _score;
END $$;

CREATE OR REPLACE FUNCTION public.crm_recompute_all_health()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _a RECORD; _n INT := 0;
BEGIN
  FOR _a IN SELECT id FROM public.crm_accounts WHERE lifecycle_stage IN ('onboarding','active','at_risk') LOOP
    PERFORM public.crm_recompute_health(_a.id);
    _n := _n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'accounts', _n);
END $$;

-- ============ PIPELINE SUMMARY ============
CREATE OR REPLACE FUNCTION public.crm_pipeline_summary()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _out JSONB;
BEGIN
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator required';
  END IF;
  SELECT jsonb_build_object(
    'accounts_by_stage', (
      SELECT COALESCE(jsonb_object_agg(lifecycle_stage, c), '{}'::jsonb)
      FROM (SELECT lifecycle_stage, COUNT(*) c FROM public.crm_accounts GROUP BY 1) s),
    'deals_by_stage', (
      SELECT COALESCE(jsonb_object_agg(stage, jsonb_build_object('count', c, 'value', v)), '{}'::jsonb)
      FROM (SELECT stage, COUNT(*) c, COALESCE(SUM(expected_mrr_cents),0) v
              FROM public.crm_deals GROUP BY 1) d),
    'weighted_forecast_cents', (
      SELECT COALESCE(SUM(expected_mrr_cents * probability / 100.0), 0)::bigint
        FROM public.crm_deals WHERE stage NOT IN ('won','lost')),
    'mrr_cents', (SELECT COALESCE(SUM(mrr_cents),0) FROM public.crm_accounts WHERE lifecycle_stage IN ('active','at_risk')),
    'open_tickets', (SELECT COUNT(*) FROM public.crm_tickets WHERE status IN ('open','in_progress','waiting_client')),
    'sla_breached', (SELECT COUNT(*) FROM public.crm_tickets WHERE status IN ('open','in_progress') AND sla_due_at < now()),
    'open_disputes', (SELECT COUNT(*) FROM public.crm_disputes WHERE status IN ('open','under_review','evidence_submitted')),
    'overdue_tasks', (SELECT COUNT(*) FROM public.crm_tasks WHERE status IN ('open','in_progress') AND due_at < now()),
    'at_risk', (SELECT COUNT(*) FROM public.crm_accounts WHERE lifecycle_stage = 'at_risk'),
    'churned_90d', (SELECT COUNT(*) FROM public.crm_churn_events WHERE created_at > now() - interval '90 days'),
    'unconverted_leads', (SELECT COUNT(*) FROM public.waitlist_leads WHERE account_id IS NULL)
  ) INTO _out;
  RETURN _out;
END $$;

-- ============ SLA / RENEWAL SWEEP ============
CREATE OR REPLACE FUNCTION public.crm_sweep()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _t RECORD; _c RECORD; _sla INT := 0; _renew INT := 0;
BEGIN
  FOR _t IN
    SELECT id, subject, account_id FROM public.crm_tickets
     WHERE status IN ('open','in_progress') AND sla_due_at IS NOT NULL AND sla_due_at < now()
       AND COALESCE((metadata->>'sla_notified')::boolean, false) = false
     LIMIT 200
  LOOP
    INSERT INTO public.notifications (kind, severity, title, body, url, metadata)
    VALUES ('crm_sla_breach', 'error', 'Ticket SLA breached', _t.subject, '/crm/tickets',
            jsonb_build_object('ticket_id', _t.id, 'account_id', _t.account_id));
    UPDATE public.crm_tickets SET metadata = metadata || jsonb_build_object('sla_notified', true) WHERE id = _t.id;
    _sla := _sla + 1;
  END LOOP;

  FOR _c IN
    SELECT ct.id, ct.account_id, ct.term_end, a.name FROM public.crm_contracts ct
      JOIN public.crm_accounts a ON a.id = ct.account_id
     WHERE ct.status = 'active' AND ct.term_end IS NOT NULL
       AND ct.term_end <= (CURRENT_DATE + (ct.notice_period_days || ' days')::interval)
       AND COALESCE((ct.metadata->>'renewal_notified')::boolean, false) = false
     LIMIT 200
  LOOP
    INSERT INTO public.crm_tasks (account_id, title, description, due_at, status)
    VALUES (_c.account_id, 'Renewal decision: ' || _c.name,
            'Contract term ends ' || _c.term_end || '. Notice period window is open.',
            _c.term_end::timestamptz, 'open');
    INSERT INTO public.notifications (kind, severity, title, body, url, metadata)
    VALUES ('crm_renewal_due', 'warning', 'Renewal window open: ' || _c.name,
            'Term ends ' || _c.term_end, '/crm/accounts/' || _c.account_id,
            jsonb_build_object('contract_id', _c.id));
    UPDATE public.crm_contracts SET metadata = metadata || jsonb_build_object('renewal_notified', true) WHERE id = _c.id;
    _renew := _renew + 1;
  END LOOP;

  PERFORM public.crm_recompute_all_health();
  RETURN jsonb_build_object('ok', true, 'sla_alerts', _sla, 'renewal_alerts', _renew);
END $$;