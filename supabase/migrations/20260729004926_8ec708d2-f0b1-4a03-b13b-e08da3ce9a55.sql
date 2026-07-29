-- Product feedback, and the 100 credits that reward it.

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  origin_user_id TEXT,
  origin_username TEXT,
  origin_source TEXT,
  campaign_key TEXT NOT NULL,
  overall_rating SMALLINT CHECK (overall_rating BETWEEN 1 AND 5),
  recommend_score SMALLINT CHECK (recommend_score BETWEEN 0 AND 10),
  module_ratings JSONB NOT NULL DEFAULT '{}'::jsonb,
  most_valuable TEXT,
  biggest_frustration TEXT,
  feature_request TEXT,
  additional_comments TEXT,
  plan_slug TEXT,
  plan_name TEXT,
  forwarded_at TIMESTAMPTZ,
  forward_error TEXT,
  forward_attempts SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.feedback_submissions TO authenticated;
GRANT ALL ON public.feedback_submissions TO service_role;

CREATE INDEX IF NOT EXISTS idx_feedback_tenant_created
  ON public.feedback_submissions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_campaign
  ON public.feedback_submissions(campaign_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_unforwarded
  ON public.feedback_submissions(created_at)
  WHERE forwarded_at IS NULL;

ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read feedback" ON public.feedback_submissions;
CREATE POLICY "Operators read feedback" ON public.feedback_submissions
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

CREATE TABLE IF NOT EXISTS public.feedback_token_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  campaign_key TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK (tokens > 0),
  submission_id UUID REFERENCES public.feedback_submissions(id) ON DELETE SET NULL,
  ledger_id UUID REFERENCES public.token_ledger(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, campaign_key)
);

GRANT SELECT ON public.feedback_token_grants TO authenticated;
GRANT ALL ON public.feedback_token_grants TO service_role;

ALTER TABLE public.feedback_token_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read feedback grants" ON public.feedback_token_grants;
CREATE POLICY "Operators read feedback grants" ON public.feedback_token_grants
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

CREATE OR REPLACE FUNCTION public.feedback_campaign_key(
  _tenant_created_at TIMESTAMPTZ,
  _at TIMESTAMPTZ DEFAULT now()
) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _tenant_created_at IS NOT NULL
     AND _at < _tenant_created_at + interval '30 days'
      THEN 'onboarding'
    ELSE to_char(_at, 'YYYY') || '-Q' || to_char(date_part('quarter', _at), 'FM9')
  END
$$;

CREATE OR REPLACE FUNCTION public.submit_feedback(
  _tenant_id UUID,
  _payload JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tenant     public.tenants%ROWTYPE;
  _plan       public.billing_plans%ROWTYPE;
  _campaign   TEXT;
  _submission public.feedback_submissions%ROWTYPE;
  _reward     CONSTANT INTEGER := 100;
  _ledger_id  UUID;
  _granted    INTEGER := 0;
  _expires    TIMESTAMPTZ;
  _already    BOOLEAN := false;
BEGIN
  SELECT * INTO _tenant FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;

  IF _tenant.plan_id IS NOT NULL THEN
    SELECT * INTO _plan FROM public.billing_plans WHERE id = _tenant.plan_id;
  END IF;

  _campaign := public.feedback_campaign_key(_tenant.created_at, now());

  INSERT INTO public.feedback_submissions (
    tenant_id, clone_id, origin_user_id, origin_username, origin_source,
    campaign_key, overall_rating, recommend_score, module_ratings,
    most_valuable, biggest_frustration, feature_request, additional_comments,
    plan_slug, plan_name
  ) VALUES (
    _tenant_id,
    _tenant.clone_id,
    NULLIF(_payload ->> 'origin_user_id', ''),
    NULLIF(_payload ->> 'origin_username', ''),
    NULLIF(_payload ->> 'origin_source', ''),
    _campaign,
    NULLIF(_payload ->> 'overall_rating', '')::SMALLINT,
    NULLIF(_payload ->> 'recommend_score', '')::SMALLINT,
    COALESCE(_payload -> 'module_ratings', '{}'::jsonb),
    NULLIF(_payload ->> 'most_valuable', ''),
    NULLIF(_payload ->> 'biggest_frustration', ''),
    NULLIF(_payload ->> 'feature_request', ''),
    NULLIF(_payload ->> 'additional_comments', ''),
    _plan.slug,
    _plan.name
  )
  RETURNING * INTO _submission;

  _expires := now() + make_interval(days => public.token_expiry_days());

  BEGIN
    INSERT INTO public.token_ledger
      (tenant_id, kind, tokens, source, source_ref, reason, expires_at, metadata)
    VALUES (
      _tenant_id, 'grant', _reward, 'manual',
      'feedback:' || _tenant_id::text || ':' || _campaign,
      'product_feedback_reward', _expires,
      jsonb_build_object(
        'campaign_key', _campaign,
        'submission_id', _submission.id,
        'origin_user_id', _submission.origin_user_id
      )
    )
    RETURNING id INTO _ledger_id;

    INSERT INTO public.feedback_token_grants
      (tenant_id, campaign_key, tokens, submission_id, ledger_id)
    VALUES (_tenant_id, _campaign, _reward, _submission.id, _ledger_id);

    _granted := _reward;
  EXCEPTION
    WHEN unique_violation THEN
      _already := true;
      _granted := 0;
  END;

  IF _granted > 0 THEN
    PERFORM public.recompute_token_balance(_tenant_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'submission_id', _submission.id,
    'campaign_key', _campaign,
    'credits_granted', _granted,
    'already_granted', _already,
    'credits_expire_at', CASE WHEN _granted > 0 THEN _expires ELSE NULL END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.feedback_prompt_due(_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tenant   public.tenants%ROWTYPE;
  _campaign TEXT;
  _answered BOOLEAN;
  _rewarded BOOLEAN;
BEGIN
  SELECT * INTO _tenant FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;

  _campaign := public.feedback_campaign_key(_tenant.created_at, now());

  SELECT EXISTS (
    SELECT 1 FROM public.feedback_submissions
     WHERE tenant_id = _tenant_id AND campaign_key = _campaign
  ) INTO _answered;

  SELECT EXISTS (
    SELECT 1 FROM public.feedback_token_grants
     WHERE tenant_id = _tenant_id AND campaign_key = _campaign
  ) INTO _rewarded;

  RETURN jsonb_build_object(
    'ok', true,
    'due', NOT _answered,
    'campaign_key', _campaign,
    'reason', CASE WHEN _campaign = 'onboarding' THEN 'onboarding' ELSE 'quarterly' END,
    'reward_available', NOT _rewarded,
    'reward_tokens', 100
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_feedback_forwarded(
  _submission_id UUID,
  _ok BOOLEAN,
  _error TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.feedback_submissions
     SET forwarded_at    = CASE WHEN _ok THEN now() ELSE forwarded_at END,
         forward_error   = CASE WHEN _ok THEN NULL ELSE left(_error, 500) END,
         forward_attempts = forward_attempts + 1
   WHERE id = _submission_id
$$;

REVOKE ALL ON FUNCTION public.submit_feedback(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_feedback(UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.feedback_prompt_due(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feedback_prompt_due(UUID) TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.mark_feedback_forwarded(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_feedback_forwarded(UUID, BOOLEAN, TEXT) TO service_role;

GRANT EXECUTE ON FUNCTION public.feedback_campaign_key(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;

DO $$
DECLARE _created CONSTANT TIMESTAMPTZ := TIMESTAMPTZ '2026-01-15 00:00:00+00';
BEGIN
  IF public.feedback_campaign_key(_created, _created + interval '1 day') <> 'onboarding' THEN
    RAISE EXCEPTION 'day 1 should be onboarding';
  END IF;
  IF public.feedback_campaign_key(_created, _created + interval '29 days') <> 'onboarding' THEN
    RAISE EXCEPTION 'day 29 should still be onboarding';
  END IF;
  IF public.feedback_campaign_key(_created, _created + interval '31 days') <> '2026-Q1' THEN
    RAISE EXCEPTION 'day 31 should roll to the quarter, got %',
      public.feedback_campaign_key(_created, _created + interval '31 days');
  END IF;
  IF public.feedback_campaign_key(_created, TIMESTAMPTZ '2026-10-02 00:00:00+00') <> '2026-Q4' THEN
    RAISE EXCEPTION 'October should be Q4';
  END IF;
END $$;