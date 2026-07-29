-- Let a colleague answer after someone else already has.
--
-- `feedback_prompt_due` reported one boolean, `due`, computed from whether
-- ANY submission exists for the workspace this campaign. Two different
-- questions were being answered with it:
--
--   1. "should the dashboard nag this workspace?"  — workspace-level, correct
--   2. "should this person see the form?"          — per person, and wrong
--
-- The form used the same flag, so the moment one person answered, everyone
-- else in the workspace opened the page to "You've already answered this one"
-- and could not submit. That directly contradicts the design: many people may
-- answer, and only the reward is once per workspace. Colleagues two through
-- five were silently locked out of a form built to hear from them.
--
-- So the workspace-level answer stays for the prompt, and a per-person one is
-- added beside it for the form. The reward rule is untouched — it lives in the
-- UNIQUE constraint on feedback_token_grants and was never the thing at fault.

-- The one-argument version has to go first: adding a defaulted parameter
-- creates a second function rather than replacing it, and a one-argument call
-- would then be ambiguous.
DROP FUNCTION IF EXISTS public.feedback_prompt_due(UUID);

CREATE OR REPLACE FUNCTION public.feedback_prompt_due(
  _tenant_id      UUID,
  _origin_user_id TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tenant       public.tenants%ROWTYPE;
  _campaign     TEXT;
  _answered     BOOLEAN;
  _you_answered BOOLEAN := false;
  _rewarded     BOOLEAN;
BEGIN
  SELECT * INTO _tenant FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;

  _campaign := public.feedback_campaign_key(_tenant.created_at, now());

  SELECT EXISTS (
    SELECT 1 FROM public.feedback_submissions
     WHERE tenant_id = _tenant_id AND campaign_key = _campaign
  ) INTO _answered;

  -- Only meaningful when we know who is asking. A `?uid=` link identifies the
  -- workspace but not the individual, so this stays false and such a visitor
  -- is always shown the form — the right way round: a stranger who can submit
  -- is better than a colleague who cannot.
  IF _origin_user_id IS NOT NULL AND length(trim(_origin_user_id)) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.feedback_submissions
       WHERE tenant_id = _tenant_id
         AND campaign_key = _campaign
         AND origin_user_id = _origin_user_id
    ) INTO _you_answered;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.feedback_token_grants
     WHERE tenant_id = _tenant_id AND campaign_key = _campaign
  ) INTO _rewarded;

  RETURN jsonb_build_object(
    'ok', true,
    -- Whether to ASK. Workspace-level on purpose: once someone has answered,
    -- the whole team stops being nagged.
    'due', NOT _answered,
    -- Whether THIS PERSON has already had their say. What the form gates on.
    'you_answered', _you_answered,
    'workspace_answered', _answered,
    'campaign_key', _campaign,
    'reason', CASE WHEN _campaign = 'onboarding' THEN 'onboarding' ELSE 'quarterly' END,
    -- So nothing promises 100 credits a colleague has already claimed.
    'reward_available', NOT _rewarded,
    'reward_tokens', 100
  );
END;
$$;

REVOKE ALL ON FUNCTION public.feedback_prompt_due(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feedback_prompt_due(UUID, TEXT) TO service_role, authenticated;

-- Prove the distinction the old signature could not express.
DO $probe$
DECLARE
  _t UUID; _a JSONB; _b JSONB;
BEGIN
  INSERT INTO public.tenants (external_ref, display_name, status)
  VALUES ('test:feedback-prompt-probe', 'Probe', 'active') RETURNING id INTO _t;

  PERFORM public.submit_feedback(_t, '{"origin_user_id":"user-a","overall_rating":"5"}'::jsonb);

  _a := public.feedback_prompt_due(_t, 'user-a');
  _b := public.feedback_prompt_due(_t, 'user-b');

  IF (_a ->> 'you_answered') <> 'true' THEN
    RAISE EXCEPTION 'the person who answered should be marked as having answered: %', _a;
  END IF;
  IF (_b ->> 'you_answered') <> 'false' THEN
    RAISE EXCEPTION 'a colleague who has NOT answered must still get the form: %', _b;
  END IF;
  IF (_b ->> 'due') <> 'false' THEN
    RAISE EXCEPTION 'the workspace should stop being nagged once anyone answers: %', _b;
  END IF;
  IF (_b ->> 'reward_available') <> 'false' THEN
    RAISE EXCEPTION 'the reward is claimed and must not be promised again: %', _b;
  END IF;

  DELETE FROM public.tenants WHERE id = _t;
END $probe$;
