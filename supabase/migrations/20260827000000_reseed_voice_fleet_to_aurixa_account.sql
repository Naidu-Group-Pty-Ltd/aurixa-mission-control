-- Re-seed the voice fleet registry to the Aurixa VAPI account (org 453f00c2…).
--
-- The original seed mixed two VAPI accounts: the outbound assistant ids were
-- Aurixa's, but the inbound squad, its members and every phone number belonged
-- to the NPC dashboard's separate VAPI org — and the "handoff specialists"
-- were mislabelled (those ids are the squad's own booking specialists). A
-- fresh, dedicated fleet (12 assistants + one squad, all named "MC …",
-- metadata.fleet = mc-v1) has been created on the Aurixa account, pointed at
-- /api/public/voice/webhook, and nothing here references the old NPC fleet
-- any more. The old assistants still exist in VAPI, untouched — they are
-- simply no longer part of Mission Control's loop.
--
-- The Aurixa account holds no phone numbers yet, so every campaign rule's
-- vapi_phone_number_id is NULL: the dispatcher will refuse to dial until a
-- number is imported and set on the rules (editable at /voice/agents).

-- ============ REMOVE THE MIXED SEED ============
DELETE FROM public.voice_agents WHERE vapi_assistant_id IN (
  'bfff143e-03f7-4bc2-afbb-5734987f672f', -- NPC dashboard org (inbound squad)
  '739b47bf-9adb-4ac6-aca4-976d815f673e',
  '5ae449c8-1999-4f44-9115-9d63bf7444ae',
  '7770a48b-68d1-48df-a03a-9cc5b9e91ad8',
  'fdb1ecde-e884-4650-abd3-8c19a2a006dd', -- old NPC fleet on the Aurixa account
  'f958ec93-6f41-4507-a7b1-f8c8d54e775e',
  'ed0aa90f-e5ea-439d-b086-f694cf5f978d',
  '9b4f7438-35b1-4d87-809a-03e56c2f9144',
  '044329e5-4709-49f9-81f7-d1e25ea28213',
  '66d3e994-32c4-4d38-90af-2351078ad0f7',
  '8057b181-7e8a-46fe-80d3-afc8df6fca75',
  '9013efd8-c662-4466-99f9-bb9597b44cfb',
  'f8abe39e-0944-4a53-afa6-95ac1852f892',
  '5aa70a8e-01fb-4bcb-b275-6822b4e7e3da',
  '209964e0-9b0c-48b1-a190-9b462de21462'
);
DELETE FROM public.voice_squads
  WHERE vapi_squad_id = 'a9656ea1-3575-4ac6-b985-fd138be06cc5';
DELETE FROM public.voice_phone_numbers WHERE vapi_phone_number_id IN (
  'de3918be-63a3-455c-bab7-bbd4872a2ea6',
  'f53c1661-29e9-4d8c-b595-b9da28cb46dc',
  'e8d1169c-43f2-447d-9c7c-a7670b1f8f5a',
  'ae35b1f3-25c4-4620-ac13-525a58da96c9',
  '61e6c684-6f5a-4567-aeeb-50c1552fb223'
);

-- ============ THE MC FLEET (Aurixa account) ============
INSERT INTO public.voice_squads (vapi_squad_id, name, description) VALUES
  ('d6bfd085-2724-476d-9d5e-0c9d72463e4c', 'MC Reception Squad',
   'Mission Control inbound squad: front desk plus three booking specialists, with native transfer destinations.')
ON CONFLICT (vapi_squad_id) DO NOTHING;

WITH squad AS (
  SELECT id FROM public.voice_squads WHERE vapi_squad_id = 'd6bfd085-2724-476d-9d5e-0c9d72463e4c'
)
INSERT INTO public.voice_agents (vapi_assistant_id, name, role, direction, squad_id, squad_position, description) VALUES
  ('2646fd1f-2c45-4406-acfc-03293eac9a44', 'MC Front Desk', 'receptionist', 'inbound', (SELECT id FROM squad), 1,
   'Front desk: resolves the caller, finds intent, transfers to a specialist.'),
  -- The three specialists carry the handoff_* roles because the webhook''s
  -- assistant-request router selects transfer destinations by role.
  ('314b7dab-de19-443d-b5f5-8b9bddcba023', 'MC Discovery Booking', 'handoff_discovery', 'inbound', (SELECT id FROM squad), 2,
   'Discovery-call booking specialist and discovery handoff destination.'),
  ('5c639d89-423a-4ea8-ae70-58a10edae617', 'MC Strategy Booking', 'handoff_strategy', 'inbound', (SELECT id FROM squad), 3,
   'Strategy-session booking specialist and strategy handoff destination.'),
  ('06846fcd-58b5-4518-a913-407c10d7421a', 'MC Finance Consult Booking', 'handoff_finance', 'inbound', (SELECT id FROM squad), 4,
   'Initial-finance-consult booking specialist and finance handoff destination.'),
  ('3633456e-93a9-4065-b89b-287063ef0b19', 'MC Opt-In Follow Up', 'follow_up', 'outbound', NULL, NULL,
   'Calls a new opt-in lead ~2 minutes after the form fill.'),
  ('c490e65b-9a6f-4765-b9c3-819c487701fb', 'MC Quiz Follow Up', 'follow_up', 'outbound', NULL, NULL,
   'Calls ~30 minutes after a quiz submission, briefed with the quiz summary.'),
  ('38522d0d-1b4a-42e3-8d85-20df34f347fa', 'MC Active Nurture', 'nurture', 'outbound', NULL, NULL,
   'Nurture-campaign caller.'),
  ('48fb110b-4b56-44b7-9ccb-1e66bb41b419', 'MC Discovery Reminder', 'reminder', 'outbound', NULL, NULL,
   'Reminder call two hours before a discovery call.'),
  ('3139be01-2926-437c-84b8-cd5cf027de99', 'MC Discovery No-Show', 'no_show', 'outbound', NULL, NULL,
   'Rebooking call after a discovery-call no-show.'),
  ('e8d5962b-6e7c-45bc-8294-75e9742bd07f', 'MC Strategy Confirmation', 'follow_up', 'outbound', NULL, NULL,
   'Confirmation call after a strategy session is booked.'),
  ('69d05a7b-3502-4f69-afd7-20073b828803', 'MC Strategy No-Show', 'no_show', 'outbound', NULL, NULL,
   'Rebooking call after a strategy-session no-show.'),
  ('d5e11b2e-69fd-41e9-a1f7-14996e056b30', 'MC IFC No-Show', 'no_show', 'outbound', NULL, NULL,
   'Rebooking call after an initial-finance-consult no-show.')
ON CONFLICT (vapi_assistant_id) DO NOTHING;

-- ============ RE-POINT THE CAMPAIGN RULES ============
UPDATE public.voice_campaign_rules SET vapi_phone_number_id = NULL;
UPDATE public.voice_campaign_rules SET vapi_assistant_id = '3633456e-93a9-4065-b89b-287063ef0b19' WHERE trigger_type = 'opt_in_follow_up';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = 'c490e65b-9a6f-4765-b9c3-819c487701fb' WHERE trigger_type = 'quiz_follow_up';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = '38522d0d-1b4a-42e3-8d85-20df34f347fa' WHERE trigger_type = 'nurture';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = '48fb110b-4b56-44b7-9ccb-1e66bb41b419' WHERE trigger_type = 'discovery_reminder';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = '3139be01-2926-437c-84b8-cd5cf027de99' WHERE trigger_type = 'discovery_no_show';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = 'e8d5962b-6e7c-45bc-8294-75e9742bd07f' WHERE trigger_type = 'strategy_confirmation';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = '69d05a7b-3502-4f69-afd7-20073b828803' WHERE trigger_type = 'strategy_no_show';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = 'e8d5962b-6e7c-45bc-8294-75e9742bd07f' WHERE trigger_type = 'ifc_confirmation';
UPDATE public.voice_campaign_rules SET vapi_assistant_id = 'd5e11b2e-69fd-41e9-a1f7-14996e056b30' WHERE trigger_type = 'ifc_no_show';
