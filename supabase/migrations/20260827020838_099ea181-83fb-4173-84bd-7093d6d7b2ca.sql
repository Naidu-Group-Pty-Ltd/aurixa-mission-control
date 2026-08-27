-- The Aurixa pipeline: journey stages, campaign cadences and appointment
-- wiring for our own B2B SaaS funnel. Uses the enum values added by
-- 20260827010000 (separate migration, per Postgres's same-transaction rule).
-- See docs/voice-aurixa-pipeline.md for the plan this implements.

-- ============ JOURNEY STAGES ============
-- The NPC stages are deactivated, not deleted: crm_client_journeys.stage_key
-- references crm_journey_stages(key) ON DELETE RESTRICT, and a stage that has
-- ever been lived-in stays resolvable.
UPDATE public.crm_journey_stages SET is_active = false
 WHERE key IN ('new_lead','engaged','discovery_call','strategy_session','finance_consult','proposal','won','lost');

INSERT INTO public.crm_journey_stages (key, name, position, color, is_terminal) VALUES
  ('applied', 'Stage 1 — Applied', 10, '#6B7280', false),
  ('questionnaire', 'Stage 2 — BRQ In Progress', 20, '#3B82F6', false),
  ('review_pending', 'Stage 3 — Review To Book', 30, '#06B6D4', false),
  ('review_booked', 'Strategic Review Booked', 40, '#8B5CF6', false),
  ('pathway', 'Pathway Recommended', 50, '#F59E0B', false),
  ('onboarding', 'Onboarding', 60, '#EC4899', false),
  ('live', 'Live Customer', 70, '#22C55E', true),
  ('closed_lost', 'Closed — Lost', 80, '#EF4444', true)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.crm_client_journeys ALTER COLUMN stage_key SET DEFAULT 'applied';

-- ============ CAMPAIGN RULES ============
-- The NPC cadences stop dialing; their rows stay for history.
UPDATE public.voice_campaign_rules SET is_enabled = false
 WHERE trigger_type IN ('opt_in_follow_up','quiz_follow_up','discovery_reminder','discovery_no_show','strategy_confirmation','strategy_no_show','ifc_confirmation','ifc_no_show');

-- Business-hours calling window for a B2B audience.
UPDATE public.voice_campaign_rules
   SET quiet_hours = '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb;

-- The Aurixa cadences. Assistant ids are the MC fleet (retargeted in place on
-- the Aurixa VAPI account); phone ids stay NULL until a number is imported.
INSERT INTO public.voice_campaign_rules
  (trigger_type, label, is_enabled, vapi_assistant_id, vapi_phone_number_id, schedule_anchor, delay_seconds, anchor_offset_seconds, expiry_seconds, max_attempts, retry_delay_seconds, quiet_hours, variable_defaults) VALUES
  ('questionnaire_follow_up', 'Stage 1: get the BRQ completed', true, '3633456e-93a9-4065-b89b-287063ef0b19', NULL, 'event', 14400, 0, NULL, 2, 86400,
   '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{"callTitle":"Aurixa Systems — Business Readiness Questionnaire | {fullName}"}'::jsonb),
  ('review_booking_follow_up', 'Stage 2: get the strategic review booked', true, 'c490e65b-9a6f-4765-b9c3-819c487701fb', NULL, 'event', 14400, 0, NULL, 2, 86400,
   '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{"callTitle":"Aurixa Systems — Strategic Review Booking | {fullName}"}'::jsonb),
  ('review_confirmation', 'Strategic review confirmation call', true, 'e8d5962b-6e7c-45bc-8294-75e9742bd07f', NULL, 'event', 120, 0, NULL, 1, 900,
   '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{"callTitle":"Aurixa Systems — Strategic Review Confirmed | {fullName}"}'::jsonb),
  ('session_reminder', 'Session reminder (T−2h)', true, '48fb110b-4b56-44b7-9ccb-1e66bb41b419', NULL, 'appointment', 0, -7200, NULL, 1, 900,
   '{"timezone":"Australia/Sydney","start":"08:30","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{}'::jsonb),
  ('session_no_show', 'Session no-show rebook', true, '3139be01-2926-437c-84b8-cd5cf027de99', NULL, 'event', 600, 0, NULL, 2, 86400,
   '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{}'::jsonb),
  ('kickoff_scheduler', 'Onboarding kickoff scheduling call', true, '69d05a7b-3502-4f69-afd7-20073b828803', NULL, 'event', 3600, 0, NULL, 2, 86400,
   '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{"callTitle":"Aurixa Systems — Onboarding Kickoff | {fullName}"}'::jsonb),
  ('checkin_at_risk', 'At-risk account check-in (off until deliberate)', false, 'd5e11b2e-69fd-41e9-a1f7-14996e056b30', NULL, 'event', 60, 0, NULL, 1, 900,
   '{"timezone":"Australia/Sydney","start":"09:00","end":"17:30","days":[1,2,3,4,5]}'::jsonb,
   '{}'::jsonb)
ON CONFLICT (trigger_type) DO NOTHING;

-- Nurture stays, retargeted to the Aurixa re-engagement agent and register.
UPDATE public.voice_campaign_rules
   SET vapi_assistant_id = '38522d0d-1b4a-42e3-8d85-20df34f347fa',
       label = 'Re-engagement call for a stalled application',
       variable_defaults = '{"callTitle":"Aurixa Systems — Checking In | {fullName}"}'::jsonb
 WHERE trigger_type = 'nurture';

-- ============ AGENT REGISTRY (names/roles follow the retargeted fleet) ============
UPDATE public.voice_agents SET name = 'MC Front Desk', role = 'receptionist',
  description = 'Aurixa reception: explains the priority-access process, qualifies, routes to a specialist.'
 WHERE vapi_assistant_id = '2646fd1f-2c45-4406-acfc-03293eac9a44';
UPDATE public.voice_agents SET name = 'MC Review Booking', role = 'handoff_review',
  description = 'Books strategic reviews and pathway sessions against the real calendar.'
 WHERE vapi_assistant_id = '314b7dab-de19-443d-b5f5-8b9bddcba023';
UPDATE public.voice_agents SET name = 'MC Solutions Advisor', role = 'handoff_solutions',
  description = 'Platform and capability questions; states the tier shape; lands on booking a review.'
 WHERE vapi_assistant_id = '5c639d89-423a-4ea8-ae70-58a10edae617';
UPDATE public.voice_agents SET name = 'MC Support Intake', role = 'handoff_support',
  description = 'Structured support intake for existing customers; points at the support portal.'
 WHERE vapi_assistant_id = '06846fcd-58b5-4518-a913-407c10d7421a';
UPDATE public.voice_agents SET name = 'MC Questionnaire Follow Up', role = 'follow_up',
  description = 'Stage 1 chaser: helps the applicant complete the 6–8 minute BRQ.'
 WHERE vapi_assistant_id = '3633456e-93a9-4065-b89b-287063ef0b19';
UPDATE public.voice_agents SET name = 'MC Review Booking Follow Up', role = 'follow_up',
  description = 'Stage 2 chaser: books the 30-minute strategic review on the call.'
 WHERE vapi_assistant_id = 'c490e65b-9a6f-4765-b9c3-819c487701fb';
UPDATE public.voice_agents SET name = 'MC Nurture', role = 'nurture',
  description = 'Re-engages stalled applications.'
 WHERE vapi_assistant_id = '38522d0d-1b4a-42e3-8d85-20df34f347fa';
UPDATE public.voice_agents SET name = 'MC Session Reminder', role = 'reminder',
  description = 'Reminder two hours before any booked session; can rebook.'
 WHERE vapi_assistant_id = '48fb110b-4b56-44b7-9ccb-1e66bb41b419';
UPDATE public.voice_agents SET name = 'MC Session No-Show', role = 'no_show',
  description = 'Zero-guilt rebooking after a missed session.'
 WHERE vapi_assistant_id = '3139be01-2926-437c-84b8-cd5cf027de99';
UPDATE public.voice_agents SET name = 'MC Review Confirmation', role = 'follow_up',
  description = 'Right after a strategic review is booked: confirm, flag the calendar invite, verify email.'
 WHERE vapi_assistant_id = 'e8d5962b-6e7c-45bc-8294-75e9742bd07f';
UPDATE public.voice_agents SET name = 'MC Kickoff Scheduler', role = 'follow_up',
  description = 'After a won deal: welcome and schedule the onboarding kickoff call.'
 WHERE vapi_assistant_id = '69d05a7b-3502-4f69-afd7-20073b828803';
UPDATE public.voice_agents SET name = 'MC Account Check-In', role = 'retention',
  description = 'Retention check-in for at-risk accounts (campaign rule seeded disabled).'
 WHERE vapi_assistant_id = 'd5e11b2e-69fd-41e9-a1f7-14996e056b30';