-- Three notification kinds are written by code and have never existed in the
-- enum, so every one of those inserts failed with `invalid input value for
-- enum notification_kind` and the notification never reached anybody:
--
--   handoff_consent_received     — /api/public/handoffs/consent, fired when a
--                                  client submits their Supabase org details,
--                                  PAT and signed DPA. The insert's error was
--                                  discarded, so the handoff recorded fine and
--                                  only the operator who needed to know was
--                                  never told.
--   github_app_access_drift      — the fleet GitHub App preflight sweep.
--   api_usage_settlement_failed  — the API-usage settlement job.
--
-- Found by typechecking: the generated `notification_kind` union is the only
-- thing that was ever going to catch a literal the database will refuse, and
-- these files were all under `@ts-nocheck`.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'handoff_consent_received';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'github_app_access_drift';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'api_usage_settlement_failed';
