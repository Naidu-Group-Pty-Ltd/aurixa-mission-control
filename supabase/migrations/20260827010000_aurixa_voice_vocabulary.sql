-- Aurixa-native voice vocabulary — enum values only.
--
-- The voice loop shipped speaking the prime repo's property funnel; Aurixa's
-- own funnel (priority access application → Business Readiness Questionnaire
-- → strategic review → pathway → onboarding) needs its own trigger and
-- appointment vocabulary. Postgres refuses to USE an enum value in the
-- transaction that added it, so this migration is additions only — the
-- seeds and rules that reference them are 20260827011000.
-- See docs/voice-aurixa-pipeline.md.

ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'questionnaire_follow_up';
ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'review_booking_follow_up';
ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'review_confirmation';
ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'session_reminder';
ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'session_no_show';
ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'kickoff_scheduler';
ALTER TYPE public.voice_trigger_type ADD VALUE IF NOT EXISTS 'checkin_at_risk';

ALTER TYPE public.crm_appointment_kind ADD VALUE IF NOT EXISTS 'strategic_review';
ALTER TYPE public.crm_appointment_kind ADD VALUE IF NOT EXISTS 'discovery_session';
ALTER TYPE public.crm_appointment_kind ADD VALUE IF NOT EXISTS 'guided_demo';
ALTER TYPE public.crm_appointment_kind ADD VALUE IF NOT EXISTS 'enterprise_consultation';
ALTER TYPE public.crm_appointment_kind ADD VALUE IF NOT EXISTS 'kickoff';
