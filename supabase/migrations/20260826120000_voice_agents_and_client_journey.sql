-- Voice agents, the call log, and the client journey — the full loop.
--
-- Replaces the Make.com + GoHighLevel voice operation with first-party state:
-- the VAPI fleet registry, a call log replicating the prime repo's
-- vapi_call_logs vocabulary, an inbound call-context store, the outbound
-- dispatch queue with the cadences the Make scenarios encoded, and a client
-- journey (stage pipeline + appointments) that is the one source of outbound
-- triggers. See docs/voice-agents-architecture.md.
--
-- Two lessons inherited from the prime repo are load-bearing here:
--   * call_outcome is TEXT — the original CHECK constraint listed six values
--     and VAPI writes dozens of endedReasons; the constraint went stale the
--     week it shipped and every webhook insert failed silently.
--   * the context store is keyed by VAPI call id, not caller phone — the Make
--     data store keyed by phone, so two concurrent calls from one number
--     overwrote each other's context mid-call.

-- ============ ENUMS ============
DO $$ BEGIN CREATE TYPE public.voice_call_direction AS ENUM ('inbound','outbound'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.voice_outbound_status AS ENUM ('pending','dispatching','dispatched','completed','failed','canceled','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.voice_trigger_type AS ENUM ('opt_in_follow_up','quiz_follow_up','nurture','discovery_reminder','discovery_no_show','strategy_confirmation','strategy_no_show','ifc_confirmation','ifc_no_show','manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_appointment_kind AS ENUM ('discovery','strategy_phone','strategy_zoom','ifc_phone','ifc_zoom','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.crm_appointment_status AS ENUM ('scheduled','confirmed','completed','no_show','canceled','rescheduled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'voice_call_flagged';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'voice_outbound_failed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'voice_blacklist_hit';

-- ============ FLEET REGISTRY ============
CREATE TABLE IF NOT EXISTS public.voice_squads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_squad_id TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_squads TO authenticated;
GRANT ALL ON public.voice_squads TO service_role;
ALTER TABLE public.voice_squads ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.voice_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_assistant_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  -- Free text: receptionist, booking, follow_up, nurture, reminder, no_show,
  -- handoff_discovery, handoff_strategy, handoff_finance, sandbox …
  role TEXT,
  direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('inbound','outbound','both')),
  squad_id UUID REFERENCES public.voice_squads(id) ON DELETE SET NULL,
  squad_position INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_agents TO authenticated;
GRANT ALL ON public.voice_agents TO service_role;
ALTER TABLE public.voice_agents ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_voice_agents_squad ON public.voice_agents(squad_id);

CREATE TABLE IF NOT EXISTS public.voice_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_phone_number_id TEXT UNIQUE NOT NULL,
  -- NULL for SIP-only endpoints, which have a URI instead of an E.164 number.
  phone_number TEXT,
  sip_uri TEXT,
  label TEXT NOT NULL,
  provider TEXT,
  routes_to TEXT CHECK (routes_to IN ('squad','assistant')),
  route_ref TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_phone_numbers TO authenticated;
GRANT ALL ON public.voice_phone_numbers TO service_role;
ALTER TABLE public.voice_phone_numbers ENABLE ROW LEVEL SECURITY;

-- ============ THE CALL LOG ============
CREATE TABLE IF NOT EXISTS public.voice_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_call_id TEXT UNIQUE NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  phone_number TEXT,
  customer_name TEXT,
  call_direction public.voice_call_direction,
  call_status TEXT CHECK (call_status IN ('queued','ringing','in-progress','forwarding','ended')),
  -- Raw VAPI endedReason (customer-ended-call, silence-timed-out, …) plus the
  -- security terminations 'blacklisted' and 'killed'. Deliberately TEXT.
  call_outcome TEXT,
  call_intent TEXT,
  is_squad_call BOOLEAN NOT NULL DEFAULT false,
  squad_id TEXT,
  squad_name TEXT,
  assistants_involved JSONB NOT NULL DEFAULT '[]'::jsonb,
  handoff_sequence JSONB NOT NULL DEFAULT '[]'::jsonb,
  structured_data_multi JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  cost DECIMAL(10,4),
  transcript TEXT,
  artifact_messages JSONB,
  summary TEXT,
  sentiment TEXT CHECK (sentiment IN ('positive','neutral','negative','mixed')),
  key_topics TEXT[],
  action_items TEXT[],
  ai_recommendations TEXT[],
  negative_sentiment_moment JSONB,
  root_cause_category TEXT,
  escalation_severity INTEGER CHECK (escalation_severity BETWEEN 1 AND 5),
  recovery_priority INTEGER CHECK (recovery_priority BETWEEN 1 AND 5),
  resolution_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (resolution_status IN ('needs_review','reviewed','resolved','escalated')),
  resolution_notes TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  recording_url TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_calls TO authenticated;
GRANT ALL ON public.voice_calls TO service_role;
ALTER TABLE public.voice_calls ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_voice_calls_started ON public.voice_calls(started_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_voice_calls_phone ON public.voice_calls(phone_number);
CREATE INDEX IF NOT EXISTS idx_voice_calls_agent ON public.voice_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_outcome ON public.voice_calls(call_outcome);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON public.voice_calls(call_status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_intent ON public.voice_calls(call_intent);
CREATE INDEX IF NOT EXISTS idx_voice_calls_sentiment ON public.voice_calls(sentiment);
CREATE INDEX IF NOT EXISTS idx_voice_calls_resolution ON public.voice_calls(resolution_status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_account ON public.voice_calls(account_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_contact ON public.voice_calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_tags ON public.voice_calls USING GIN(tags);

-- ============ CLIENT JOURNEY (the tracker) ============
CREATE TABLE IF NOT EXISTS public.crm_journey_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_journey_stages TO authenticated;
GRANT ALL ON public.crm_journey_stages TO service_role;
ALTER TABLE public.crm_journey_stages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crm_client_journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID UNIQUE NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL DEFAULT 'new_lead' REFERENCES public.crm_journey_stages(key) ON DELETE RESTRICT,
  entered_stage_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  follow_up_at TIMESTAMPTZ,
  last_call_at TIMESTAMPTZ,
  last_call_outcome TEXT,
  calls_total INTEGER NOT NULL DEFAULT 0,
  do_not_call BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_client_journeys TO authenticated;
GRANT ALL ON public.crm_client_journeys TO service_role;
ALTER TABLE public.crm_client_journeys ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_crm_client_journeys_account ON public.crm_client_journeys(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_client_journeys_stage ON public.crm_client_journeys(stage_key);
CREATE INDEX IF NOT EXISTS idx_crm_client_journeys_follow_up ON public.crm_client_journeys(follow_up_at);

CREATE TABLE IF NOT EXISTS public.crm_journey_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id UUID NOT NULL REFERENCES public.crm_client_journeys(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('call','manual','system','webhook')),
  call_id UUID REFERENCES public.voice_calls(id) ON DELETE SET NULL,
  actor_user_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_journey_events TO authenticated;
GRANT ALL ON public.crm_journey_events TO service_role;
ALTER TABLE public.crm_journey_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_crm_journey_events_journey ON public.crm_journey_events(journey_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_journey_events_call ON public.crm_journey_events(call_id);

CREATE TABLE IF NOT EXISTS public.crm_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  journey_id UUID REFERENCES public.crm_client_journeys(id) ON DELETE SET NULL,
  kind public.crm_appointment_kind NOT NULL DEFAULT 'discovery',
  title TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  status public.crm_appointment_status NOT NULL DEFAULT 'scheduled',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('voice_agent','manual','system')),
  booked_by_call_id UUID REFERENCES public.voice_calls(id) ON DELETE SET NULL,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_appointments TO authenticated;
GRANT ALL ON public.crm_appointments TO service_role;
ALTER TABLE public.crm_appointments ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_crm_appointments_account ON public.crm_appointments(account_id);
CREATE INDEX IF NOT EXISTS idx_crm_appointments_contact ON public.crm_appointments(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_appointments_journey ON public.crm_appointments(journey_id);
CREATE INDEX IF NOT EXISTS idx_crm_appointments_starts ON public.crm_appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_crm_appointments_status ON public.crm_appointments(status);
CREATE INDEX IF NOT EXISTS idx_crm_appointments_booked_by ON public.crm_appointments(booked_by_call_id);

-- Raw webhook queue: the webhook writes fast, the drain enriches. A webhook
-- handler that calls three vendor APIs before answering is a webhook that
-- times out and gets retried into duplicates.
CREATE TABLE IF NOT EXISTS public.voice_call_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_call_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_call_events TO authenticated;
GRANT ALL ON public.voice_call_events TO service_role;
ALTER TABLE public.voice_call_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_voice_call_events_unprocessed ON public.voice_call_events(received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_call_events_call ON public.voice_call_events(vapi_call_id);

-- Inbound call context, written by the resolve_contact tool and read by
-- get_call_context / the handoff router. Keyed by call id (see header).
CREATE TABLE IF NOT EXISTS public.voice_call_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_call_id TEXT UNIQUE NOT NULL,
  caller_phone TEXT,
  normalized_phone TEXT,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE SET NULL,
  first_name TEXT,
  full_name TEXT,
  -- Uppercase on purpose: the assistants' prompts branch on these exact strings.
  contact_state TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK (contact_state IN ('RESOLVED','UNRESOLVED','NEEDS_NAME')),
  contact_found BOOLEAN NOT NULL DEFAULT false,
  contact_created BOOLEAN NOT NULL DEFAULT false,
  confirmed_intent TEXT,
  caller_reason TEXT,
  handoff_ready BOOLEAN NOT NULL DEFAULT false,
  source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_call_context TO authenticated;
GRANT ALL ON public.voice_call_context TO service_role;
ALTER TABLE public.voice_call_context ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_voice_call_context_phone ON public.voice_call_context(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_voice_call_context_contact ON public.voice_call_context(contact_id);
CREATE INDEX IF NOT EXISTS idx_voice_call_context_account ON public.voice_call_context(account_id);

-- ============ BLACKLIST / TAGS / ALERTS ============
CREATE TABLE IF NOT EXISTS public.voice_blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  normalized_number TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('spam','scam','telemarketer','abusive','other')),
  kill_mode TEXT NOT NULL DEFAULT 'silent' CHECK (kill_mode IN ('silent','announce')),
  announce_message TEXT CHECK (announce_message IS NULL OR length(announce_message) <= 300),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_blacklist TO authenticated;
GRANT ALL ON public.voice_blacklist TO service_role;
ALTER TABLE public.voice_blacklist ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.voice_call_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  color TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_call_tags TO authenticated;
GRANT ALL ON public.voice_call_tags TO service_role;
ALTER TABLE public.voice_call_tags ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.voice_alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  condition_type TEXT NOT NULL CHECK (condition_type IN ('outcome','sentiment','intent','duration_gt','duration_lt','cost_gt','escalation_gte')),
  condition_value TEXT NOT NULL,
  is_positive BOOLEAN NOT NULL DEFAULT false,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  notify_operators BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_alert_rules TO authenticated;
GRANT ALL ON public.voice_alert_rules TO service_role;
ALTER TABLE public.voice_alert_rules ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.voice_alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES public.voice_alert_rules(id) ON DELETE CASCADE,
  call_id UUID REFERENCES public.voice_calls(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  message TEXT NOT NULL,
  is_positive BOOLEAN NOT NULL DEFAULT false,
  is_read BOOLEAN NOT NULL DEFAULT false,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_alert_history TO authenticated;
GRANT ALL ON public.voice_alert_history TO service_role;
ALTER TABLE public.voice_alert_history ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_voice_alert_history_rule ON public.voice_alert_history(rule_id);
CREATE INDEX IF NOT EXISTS idx_voice_alert_history_call ON public.voice_alert_history(call_id);
CREATE INDEX IF NOT EXISTS idx_voice_alert_history_unread ON public.voice_alert_history(triggered_at) WHERE NOT is_read;

-- ============ OUTBOUND ============
CREATE TABLE IF NOT EXISTS public.voice_campaign_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type public.voice_trigger_type UNIQUE NOT NULL,
  label TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  vapi_assistant_id TEXT,
  vapi_phone_number_id TEXT,
  -- 'event': dial delay_seconds after the trigger event.
  -- 'appointment': dial at appointment start + anchor_offset_seconds
  -- (negative = before; the discovery reminder is -7200).
  schedule_anchor TEXT NOT NULL DEFAULT 'event' CHECK (schedule_anchor IN ('event','appointment')),
  delay_seconds INTEGER NOT NULL DEFAULT 120,
  anchor_offset_seconds INTEGER NOT NULL DEFAULT 0,
  expiry_seconds INTEGER,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  retry_delay_seconds INTEGER NOT NULL DEFAULT 900,
  -- Make had no quiet hours; every rule here gets them.
  quiet_hours JSONB NOT NULL DEFAULT '{"timezone":"Australia/Sydney","start":"08:00","end":"20:00","days":[1,2,3,4,5,6]}'::jsonb,
  variable_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_campaign_rules TO authenticated;
GRANT ALL ON public.voice_campaign_rules TO service_role;
ALTER TABLE public.voice_campaign_rules ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.voice_outbound_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type public.voice_trigger_type NOT NULL,
  campaign_rule_id UUID REFERENCES public.voice_campaign_rules(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  journey_id UUID REFERENCES public.crm_client_journeys(id) ON DELETE SET NULL,
  appointment_id UUID REFERENCES public.crm_appointments(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  vapi_assistant_id TEXT NOT NULL,
  vapi_phone_number_id TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  variable_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  status public.voice_outbound_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  vapi_call_id TEXT,
  dedupe_key TEXT,
  created_by UUID,
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_outbound_jobs TO authenticated;
GRANT ALL ON public.voice_outbound_jobs TO service_role;
ALTER TABLE public.voice_outbound_jobs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_due ON public.voice_outbound_jobs(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_rule ON public.voice_outbound_jobs(campaign_rule_id);
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_account ON public.voice_outbound_jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_contact ON public.voice_outbound_jobs(contact_id);
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_journey ON public.voice_outbound_jobs(journey_id);
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_appointment ON public.voice_outbound_jobs(appointment_id);
CREATE INDEX IF NOT EXISTS idx_voice_outbound_jobs_call ON public.voice_outbound_jobs(vapi_call_id);
-- One live job per (trigger, subject, anchor). Retries reuse the row, so the
-- key only blocks a second enqueue while the first is still in flight.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_outbound_jobs_dedupe ON public.voice_outbound_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','dispatching','dispatched');

-- ============ RLS POLICIES (operator read/write) ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'voice_squads','voice_agents','voice_phone_numbers','voice_calls',
    'voice_call_events','voice_call_context','voice_blacklist','voice_call_tags',
    'voice_alert_rules','voice_alert_history','voice_campaign_rules',
    'voice_outbound_jobs','crm_journey_stages','crm_client_journeys',
    'crm_journey_events','crm_appointments'
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
    'voice_squads','voice_agents','voice_phone_numbers','voice_calls',
    'voice_call_context','voice_blacklist','voice_alert_rules',
    'voice_campaign_rules','voice_outbound_jobs','crm_journey_stages',
    'crm_client_journeys','crm_appointments'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'set_updated_at_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
      'set_updated_at_' || t, t);
  END LOOP;
END $$;

-- ============ SEEDS ============
-- Journey stages: the prime repo's client pipeline vocabulary, made local.
INSERT INTO public.crm_journey_stages (key, name, position, color, is_terminal) VALUES
  ('new_lead', 'New Lead', 10, '#6B7280', false),
  ('engaged', 'Engaged / Nurturing', 20, '#3B82F6', false),
  ('discovery_call', 'Discovery Call', 30, '#06B6D4', false),
  ('strategy_session', 'Strategy Session', 40, '#8B5CF6', false),
  ('finance_consult', 'Finance Consult', 50, '#F59E0B', false),
  ('proposal', 'Proposal', 60, '#EC4899', false),
  ('won', 'Won', 70, '#22C55E', true),
  ('lost', 'Lost', 80, '#EF4444', true)
ON CONFLICT (key) DO NOTHING;

-- Default call tags, mirroring the prime repo's seed.
INSERT INTO public.voice_call_tags (name, color, description) VALUES
  ('High Priority', '#EF4444', 'Needs attention soon'),
  ('Follow Up', '#F59E0B', 'Requires a follow-up touch'),
  ('VIP', '#8B5CF6', 'High-value client'),
  ('Sales Lead', '#22C55E', 'Active sales opportunity'),
  ('Support', '#3B82F6', 'Support enquiry'),
  ('Complaint', '#F97316', 'Complaint raised on the call')
ON CONFLICT (name) DO NOTHING;

-- The VAPI fleet, as the Make scenarios and the prime repo's org snapshot
-- record it. IDs are identifiers, not credentials.
INSERT INTO public.voice_squads (vapi_squad_id, name, description) VALUES
  ('a9656ea1-3575-4ac6-b985-fd138be06cc5', 'NPC Sales Force',
   'Inbound reception squad: front desk plus three booking specialists.')
ON CONFLICT (vapi_squad_id) DO NOTHING;

WITH squad AS (
  SELECT id FROM public.voice_squads WHERE vapi_squad_id = 'a9656ea1-3575-4ac6-b985-fd138be06cc5'
)
INSERT INTO public.voice_agents (vapi_assistant_id, name, role, direction, squad_id, squad_position, description) VALUES
  ('bfff143e-03f7-4bc2-afbb-5734987f672f', 'NPC Inbound Agent', 'receptionist', 'inbound', (SELECT id FROM squad), 1, 'Front desk: greets, resolves the caller, routes intent.'),
  ('739b47bf-9adb-4ac6-aca4-976d815f673e', 'NPC Opt In Follow Up Inbound', 'booking', 'inbound', (SELECT id FROM squad), 2, 'Discovery-call booking specialist.'),
  ('5ae449c8-1999-4f44-9115-9d63bf7444ae', 'NPC Strategy Session Inbound', 'booking', 'inbound', (SELECT id FROM squad), 3, 'Strategy-session booking specialist.'),
  ('7770a48b-68d1-48df-a03a-9cc5b9e91ad8', 'NPC IFC Inbound', 'booking', 'inbound', (SELECT id FROM squad), 4, 'Initial finance consult booking specialist.'),
  ('fdb1ecde-e884-4650-abd3-8c19a2a006dd', 'Discovery Handoff Specialist', 'handoff_discovery', 'inbound', NULL, NULL, 'Squad-transfer destination for discovery intent.'),
  ('f958ec93-6f41-4507-a7b1-f8c8d54e775e', 'Strategy Handoff Specialist', 'handoff_strategy', 'inbound', NULL, NULL, 'Squad-transfer destination for strategy intent.'),
  ('ed0aa90f-e5ea-439d-b086-f694cf5f978d', 'Finance Handoff Specialist', 'handoff_finance', 'inbound', NULL, NULL, 'Squad-transfer destination for finance intent.'),
  ('9b4f7438-35b1-4d87-809a-03e56c2f9144', 'Opt-In Follow Up Agent', 'follow_up', 'outbound', NULL, NULL, 'Calls a new opt-in lead ~2 minutes after the form fill.'),
  ('044329e5-4709-49f9-81f7-d1e25ea28213', 'Quiz Follow Up Agent', 'follow_up', 'outbound', NULL, NULL, 'Calls ~30 minutes after a quiz submission, briefed with a quiz summary.'),
  ('66d3e994-32c4-4d38-90af-2351078ad0f7', 'Active Nurturing Agent', 'nurture', 'outbound', NULL, NULL, 'Nurture-campaign caller.'),
  ('8057b181-7e8a-46fe-80d3-afc8df6fca75', 'Discovery Reminder Agent', 'reminder', 'outbound', NULL, NULL, 'Reminder call two hours before a discovery call.'),
  ('9013efd8-c662-4466-99f9-bb9597b44cfb', 'Discovery No-Show Agent', 'no_show', 'outbound', NULL, NULL, 'Rebooking call after a discovery-call no-show.'),
  ('f8abe39e-0944-4a53-afa6-95ac1852f892', 'Strategy Confirmation Agent', 'follow_up', 'outbound', NULL, NULL, 'Confirmation call after a strategy session is booked.'),
  ('5aa70a8e-01fb-4bcb-b275-6822b4e7e3da', 'Strategy No-Show Agent', 'no_show', 'outbound', NULL, NULL, 'Rebooking call after a strategy-session no-show.'),
  ('209964e0-9b0c-48b1-a190-9b462de21462', 'IFC No-Show Agent', 'no_show', 'outbound', NULL, NULL, 'Rebooking call after an initial-finance-consult no-show.')
ON CONFLICT (vapi_assistant_id) DO NOTHING;

INSERT INTO public.voice_phone_numbers (vapi_phone_number_id, phone_number, sip_uri, label, provider, routes_to, route_ref) VALUES
  ('de3918be-63a3-455c-bab7-bbd4872a2ea6', '+61286093299', NULL, 'Primary outbound line', 'twilio', NULL, NULL),
  ('f53c1661-29e9-4d8c-b595-b9da28cb46dc', '+61281056305', NULL, 'Secondary outbound line', 'twilio', NULL, NULL),
  ('e8d1169c-43f2-447d-9c7c-a7670b1f8f5a', NULL, NULL, 'Discovery reminder line', 'twilio', NULL, NULL),
  ('ae35b1f3-25c4-4620-ac13-525a58da96c9', NULL, 'sip:naidupropertyconsultingservices@sip.vapi.ai', 'Inbound SIP (squad)', 'vapi', 'squad', 'a9656ea1-3575-4ac6-b985-fd138be06cc5'),
  ('61e6c684-6f5a-4567-aeeb-50c1552fb223', NULL, 'sip:npc-services@sip.vapi.ai', 'Inbound SIP (follow up)', 'vapi', 'assistant', NULL)
ON CONFLICT (vapi_phone_number_id) DO NOTHING;

-- The outbound cadences the Make scenarios encoded, one row each.
INSERT INTO public.voice_campaign_rules
  (trigger_type, label, is_enabled, vapi_assistant_id, vapi_phone_number_id, schedule_anchor, delay_seconds, anchor_offset_seconds, expiry_seconds, max_attempts, retry_delay_seconds, variable_defaults) VALUES
  ('opt_in_follow_up', 'Opt-in lead follow-up', true, '9b4f7438-35b1-4d87-809a-03e56c2f9144', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, 420, 2, 900,
   '{"callTitle":"Discovery Call with Rugesh from NPC Services | {fullName}"}'::jsonb),
  ('quiz_follow_up', 'Quiz submission follow-up', true, '044329e5-4709-49f9-81f7-d1e25ea28213', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 1800, 0, NULL, 2, 900,
   '{"callTitle":"Discovery Call with Rugesh from NPC Services | {fullName}"}'::jsonb),
  ('nurture', 'Active nurturing call', true, '66d3e994-32c4-4d38-90af-2351078ad0f7', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, NULL, 1, 900,
   '{"callTitle":"Discovery Call with Rugesh from NPC Services | {fullName}"}'::jsonb),
  ('discovery_reminder', 'Discovery call reminder (T-2h)', true, '8057b181-7e8a-46fe-80d3-afc8df6fca75', 'e8d1169c-43f2-447d-9c7c-a7670b1f8f5a', 'appointment', 0, -7200, NULL, 1, 900,
   '{}'::jsonb),
  ('discovery_no_show', 'Discovery no-show rebook', true, '9013efd8-c662-4466-99f9-bb9597b44cfb', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, NULL, 2, 900,
   '{"callTitle":"Discovery Call with Rugesh | {fullName}"}'::jsonb),
  ('strategy_confirmation', 'Strategy session confirmation', true, 'f8abe39e-0944-4a53-afa6-95ac1852f892', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, NULL, 1, 900,
   '{"callTitle":"Strategy Session with NPC Services | {fullName}"}'::jsonb),
  ('strategy_no_show', 'Strategy session no-show rebook', true, '5aa70a8e-01fb-4bcb-b275-6822b4e7e3da', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, NULL, 2, 900,
   '{"callTitle":"Strategy Session with NPC Services | {fullName}"}'::jsonb),
  -- Make never confirmed IFC bookings; the rule exists but starts disabled so
  -- behaviour matches the migrated system until somebody chooses otherwise.
  ('ifc_confirmation', 'Finance consult confirmation', false, 'f8abe39e-0944-4a53-afa6-95ac1852f892', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, NULL, 1, 900,
   '{"callTitle":"Initial Finance Consult with NPC Services | {fullName}"}'::jsonb),
  ('ifc_no_show', 'Finance consult no-show rebook', true, '209964e0-9b0c-48b1-a190-9b462de21462', 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 120, 0, NULL, 2, 900,
   '{"callTitle":"Initial Finance Consult with NPC Services | {fullName}"}'::jsonb),
  ('manual', 'Operator-initiated call', true, NULL, 'de3918be-63a3-455c-bab7-bbd4872a2ea6', 'event', 0, 0, NULL, 1, 900, '{}'::jsonb)
ON CONFLICT (trigger_type) DO NOTHING;

-- ============ CRON ============
DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- voice-call-drain-1min -> /hooks/voice-call-drain   (* * * * *)
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'voice-call-drain-1min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('voice-call-drain-1min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'voice-call-drain-1min');
    PERFORM cron.schedule(
      'voice-call-drain-1min',
      '* * * * *',
      format(
        $f$SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'Lovable-Context','cron',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
          ),
          body := jsonb_build_object('source','pg_cron'),
          timeout_milliseconds := 60000
        )$f$,
        v_base || '/hooks/voice-call-drain'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'voice-call-drain-1min', v_base;
  END IF;

  -- voice-outbound-dispatch-1min -> /hooks/voice-outbound-dispatch   (* * * * *)
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'voice-outbound-dispatch-1min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('voice-outbound-dispatch-1min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'voice-outbound-dispatch-1min');
    PERFORM cron.schedule(
      'voice-outbound-dispatch-1min',
      '* * * * *',
      format(
        $f$SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'Lovable-Context','cron',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
          ),
          body := jsonb_build_object('source','pg_cron'),
          timeout_milliseconds := 60000
        )$f$,
        v_base || '/hooks/voice-outbound-dispatch'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'voice-outbound-dispatch-1min', v_base;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'voice cron scheduling skipped: %', SQLERRM;
END $$;
