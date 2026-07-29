-- Product feedback, and the 100 credits that reward it.
--
-- Two facts have to be recorded separately, because they are counted
-- differently:
--
--   • a SUBMISSION is per person. Five people in a workspace can each answer,
--     and each answer is worth having.
--   • a GRANT is per workspace. Those five submissions earn 100 credits once,
--     not five hundred.
--
-- Enforcing that in application code would mean a read-then-write, and two
-- people pressing submit at the same moment would both read "not yet granted"
-- and both write a grant. So the rule is a UNIQUE constraint on
-- (tenant, campaign) and the second insert simply loses — which is the only
-- version of this that is correct under concurrency.
--
-- Campaigns exist because the prompt recurs. A workspace is asked once in its
-- first 30 days and once a quarter after that, and each of those is separately
-- worth 100 credits — otherwise the quarterly prompt asks for effort and
-- offers nothing.

-- ── 1. Submissions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.feedback_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,

  -- Who answered. Not a Mission Control user: this is the identity the clone
  -- knows them by, carried through the handoff that opened the form. Kept so
  -- a follow-up conversation can be had with the person who wrote it.
  origin_user_id TEXT,
  origin_username TEXT,
  origin_source TEXT,

  -- Which round of asking this answers. See feedback_campaign_key().
  campaign_key TEXT NOT NULL,

  -- The whole-product score, 1–5, and the "would you recommend" score, 0–10.
  overall_rating SMALLINT CHECK (overall_rating BETWEEN 1 AND 5),
  recommend_score SMALLINT CHECK (recommend_score BETWEEN 0 AND 10),

  -- Per-module scores, keyed by module slug: {"deal-pipeline": 4, ...}.
  -- JSONB rather than a child table because the set of modules a workspace is
  -- asked about changes with its plan, and a rating is only ever read back
  -- alongside its submission.
  module_ratings JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The open-ended answers.
  most_valuable TEXT,
  biggest_frustration TEXT,
  feature_request TEXT,
  additional_comments TEXT,

  -- What the workspace was on when it answered, so a score can be read in
  -- context years later, after the plan has changed.
  plan_slug TEXT,
  plan_name TEXT,

  -- Delivery to the Make.com webhook. Recorded rather than assumed: a
  -- submission that never reached Airtable is invisible otherwise, and this
  -- makes it a query.
  forwarded_at TIMESTAMPTZ,
  forward_error TEXT,
  forward_attempts SMALLINT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_tenant_created
  ON public.feedback_submissions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_campaign
  ON public.feedback_submissions(campaign_key, created_at DESC);
-- Partial index over exactly the rows a retry sweep looks for.
CREATE INDEX IF NOT EXISTS idx_feedback_unforwarded
  ON public.feedback_submissions(created_at)
  WHERE forwarded_at IS NULL;

ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read feedback" ON public.feedback_submissions;
CREATE POLICY "Operators read feedback" ON public.feedback_submissions
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

-- ── 2. The grant, once per workspace per campaign ───────────────────────────
CREATE TABLE IF NOT EXISTS public.feedback_token_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  campaign_key TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK (tokens > 0),
  -- The submission that earned it: whoever got there first.
  submission_id UUID REFERENCES public.feedback_submissions(id) ON DELETE SET NULL,
  ledger_id UUID REFERENCES public.token_ledger(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- THE rule. Not a check in code that two concurrent submissions could both
  -- pass — a constraint the second one cannot get past.
  UNIQUE (tenant_id, campaign_key)
);

ALTER TABLE public.feedback_token_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read feedback grants" ON public.feedback_token_grants;
CREATE POLICY "Operators read feedback grants" ON public.feedback_token_grants
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

-- ── 3. Which round of asking are we in? ─────────────────────────────────────
-- A workspace's first 30 days are their own campaign, because first
-- impressions are a different question from "how is it going" and the answers
-- should not be pooled. After that it is quarterly, keyed on the calendar so
-- every workspace in a quarter answers the same campaign and the results are
-- comparable.
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

-- ── 4. Submitting ───────────────────────────────────────────────────────────
-- Records the answer and, if this workspace has not already been paid for this
-- campaign, grants the credits — in one transaction, so a submission can never
-- exist without its grant having been attempted, nor a grant without the
-- submission that earned it.
--
-- Returns what happened rather than throwing on the "already granted" path,
-- because that is a completely normal outcome: it is the second colleague to
-- answer, and their submission is still wanted.
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

  -- The credits. Issued into the same balance as everything else, on the same
  -- 30-day clock, so they are spent by the same soonest-to-expire rule rather
  -- than being a second kind of money.
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
      -- Someone in this workspace already earned it for this campaign. Their
      -- answer still counts; the reward does not stack. The ledger row is
      -- rolled back with this sub-block, so no credits are issued.
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

-- ── 5. Is a prompt due? ─────────────────────────────────────────────────────
-- The workspace asks this; Mission Control answers, so every clone inherits
-- the same cadence without shipping the rule into each front end.
--
-- Due when this workspace has not answered the CURRENT campaign. That single
-- rule gives both behaviours asked for: inside the first 30 days the campaign
-- is 'onboarding', and afterwards it rolls to a new key each quarter.
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
    -- So the prompt can be honest about the incentive. A workspace whose
    -- colleague already claimed it should not be promised 100 credits again.
    'reward_available', NOT _rewarded,
    'reward_tokens', 100
  );
END;
$$;

-- ── 6. Delivery bookkeeping ─────────────────────────────────────────────────
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

-- ── 7. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.submit_feedback(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_feedback(UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.feedback_prompt_due(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feedback_prompt_due(UUID) TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.mark_feedback_forwarded(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_feedback_forwarded(UUID, BOOLEAN, TEXT) TO service_role;

GRANT EXECUTE ON FUNCTION public.feedback_campaign_key(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;

-- ── 8. Prove the campaign boundaries ────────────────────────────────────────
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
