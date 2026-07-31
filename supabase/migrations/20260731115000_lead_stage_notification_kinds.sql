-- Notifications for the two priority-access milestones that were previously
-- invisible in Mission Control: finishing the Business Readiness Questionnaire
-- (Stage 2) and booking the strategic review (Stage 3).
--
-- Kept in its own migration because a new enum value cannot be used in the
-- same transaction that adds it, and the journey migration that follows this
-- one writes rows the notification fan-out reads.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'lead_stage_two';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'lead_stage_three';
