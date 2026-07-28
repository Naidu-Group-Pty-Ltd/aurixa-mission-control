-- Included monthly credits for the sold tiers, and the plan change that grants
-- them.
--
--   Launch  7,000 credits / month
--   Growth 35,000 credits / month
--   Scale  75,000 credits / month
--
-- Two plan tables exist here and they were never connected. `seat_plans` is
-- what Stripe sells — launch/growth/scale/enterprise, with prices. Meanwhile
-- `billing_plans` is what actually governs a workspace: `tenants.plan_id`
-- points at it, `monthly_allowance` is read from it, and the hourly
-- issue_due_plan_allowances() cron credits from it.
--
-- Buying a tier wrote clone_seat_entitlements and stopped there. Nothing ever
-- set `tenants.plan_id`, so every paying workspace sat on whatever billing
-- plan it started with — for most, none at all — and a tier granted exactly
-- zero credits. That is the gap this closes.
--
-- The bridge is deliberately by SLUG rather than a foreign key: seat_plans and
-- billing_plans already share launch/growth/scale, and a new column would be a
-- second thing to keep in step. One name, one meaning.

-- ── 1. The tiers, as billing plans ──────────────────────────────────────────
-- rollover_cap stays 0: credits already roll over and expire on their own
-- 30-day clock (token_expiry_days), so a separate cap would be a second,
-- conflicting expiry rule. overage_policy 'topup_only' — a workspace out of
-- credits buys a pack rather than silently running up a bill.
INSERT INTO public.billing_plans
  (slug, name, monthly_allowance, rollover_cap, overage_policy, price_cents, currency, is_active, metadata)
VALUES
  ('launch', 'Launch',  7000, 0, 'topup_only',  69900, 'AUD', true,
   '{"tier":true,"tax_inclusive":true,"gst_included":true}'::jsonb),
  ('growth', 'Growth', 35000, 0, 'topup_only', 105500, 'AUD', true,
   '{"tier":true,"tax_inclusive":true,"gst_included":true}'::jsonb),
  ('scale',  'Scale',  75000, 0, 'topup_only', 221000, 'AUD', true,
   '{"tier":true,"tax_inclusive":true,"gst_included":true}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  name              = EXCLUDED.name,
  monthly_allowance = EXCLUDED.monthly_allowance,
  overage_policy    = EXCLUDED.overage_policy,
  price_cents       = EXCLUDED.price_cents,
  currency          = EXCLUDED.currency,
  is_active         = true,
  metadata          = public.billing_plans.metadata || EXCLUDED.metadata,
  updated_at        = now();

-- The same figure on the seat plan, so the storefront mirror carries it to the
-- pricing page without a second lookup. billing_plans stays authoritative for
-- what is granted; this copy is for display.
UPDATE public.seat_plans sp
   SET metadata   = sp.metadata || jsonb_build_object('monthly_credits', bp.monthly_allowance),
       updated_at = now()
  FROM public.billing_plans bp
 WHERE bp.slug = sp.slug
   AND bp.monthly_allowance > 0;

-- ── 2. A plan change is an event, not just a column write ───────────────────
-- The front end has to announce a change exactly once, which means the change
-- needs somewhere to live between happening and being seen. A flag on the
-- tenant could not do it: two changes in a month would collapse into one, and
-- nothing would record what the previous plan was.
CREATE TABLE IF NOT EXISTS public.plan_change_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  from_plan_slug TEXT,
  from_plan_name TEXT,
  to_plan_slug TEXT NOT NULL,
  to_plan_name TEXT NOT NULL,
  credits_granted INTEGER NOT NULL DEFAULT 0 CHECK (credits_granted >= 0),
  credits_expire_at TIMESTAMPTZ,
  -- What caused it (a checkout session, a subscription update). UNIQUE, so a
  -- replayed Stripe webhook announces the change once rather than once per
  -- delivery attempt.
  source_ref TEXT NOT NULL UNIQUE,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_change_unseen
  ON public.plan_change_events(tenant_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

ALTER TABLE public.plan_change_events ENABLE ROW LEVEL SECURITY;

-- Operators read; nothing writes through the API. Every write goes through the
-- SECURITY DEFINER functions below, which run as service_role from the webhook.
DROP POLICY IF EXISTS "Operators read plan_change_events" ON public.plan_change_events;
CREATE POLICY "Operators read plan_change_events" ON public.plan_change_events
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

-- ── 3. Applying a plan change ───────────────────────────────────────────────
-- Moves the tenant onto the tier's billing plan, credits the allowance, and
-- records the change — or does none of those, if it has already been done.
--
-- The allowance is credited through issue_plan_allowance rather than by
-- inserting a ledger row here, and that is the whole trick. That function
-- writes its grant under the ref the monthly cron also uses
-- (`plan:<plan_id>:<period start>`), so the cron sees this period as already
-- issued and does not credit it a second time. Granting directly would double
-- every upgrade.
CREATE OR REPLACE FUNCTION public.apply_seat_plan_change(
  _tenant_id  UUID,
  _plan_slug  TEXT,
  _source_ref TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tenant    public.tenants%ROWTYPE;
  _new_plan  public.billing_plans%ROWTYPE;
  _old_plan  public.billing_plans%ROWTYPE;
  _existing  public.plan_change_events%ROWTYPE;
  _issued    JSONB;
  _granted   INTEGER := 0;
  _expires   TIMESTAMPTZ;
  _start     TIMESTAMPTZ := now();
BEGIN
  IF _source_ref IS NULL OR length(trim(_source_ref)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'source_ref_required');
  END IF;

  -- Replay of a webhook we have already handled. Answer with what happened the
  -- first time rather than doing it again.
  SELECT * INTO _existing FROM public.plan_change_events WHERE source_ref = _source_ref;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'event_id', _existing.id,
      'credits_granted', _existing.credits_granted
    );
  END IF;

  SELECT * INTO _tenant FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;

  SELECT * INTO _new_plan FROM public.billing_plans WHERE slug = _plan_slug AND is_active;
  IF NOT FOUND THEN
    -- Enterprise and anything quoted rather than listed has no billing plan.
    -- Not an error: there is simply no allowance to grant.
    RETURN jsonb_build_object('ok', true, 'skipped', 'no_billing_plan_for_slug', 'slug', _plan_slug);
  END IF;

  IF _tenant.plan_id IS NOT NULL THEN
    SELECT * INTO _old_plan FROM public.billing_plans WHERE id = _tenant.plan_id;
  END IF;

  -- Move the workspace, and start its period now. The period start is what the
  -- allowance is keyed on, so a change mid-month begins a fresh one rather than
  -- colliding with the period the old plan already consumed.
  UPDATE public.tenants
     SET plan_id              = _new_plan.id,
         plan_started_at      = _start,
         current_period_start = _start,
         status               = CASE WHEN status = 'active' THEN status ELSE 'active' END,
         updated_at           = now()
   WHERE id = _tenant_id;

  _issued := public.issue_plan_allowance(_tenant_id, _start);
  IF COALESCE(_issued ->> 'ok', 'false') = 'true' THEN
    _granted := COALESCE((_issued ->> 'tokens')::INTEGER, 0);
    _expires := NULLIF(_issued ->> 'expires_at', '')::TIMESTAMPTZ;
    -- An idempotent issue means this period was already credited (the tenant
    -- was moved onto this plan a moment ago by another path). The change is
    -- still worth announcing; the credits are not granted twice.
    IF COALESCE(_issued ->> 'idempotent', 'false') = 'true' THEN
      _granted := 0;
    END IF;
  END IF;

  INSERT INTO public.plan_change_events
    (tenant_id, from_plan_slug, from_plan_name, to_plan_slug, to_plan_name,
     credits_granted, credits_expire_at, source_ref)
  VALUES
    (_tenant_id, _old_plan.slug, _old_plan.name, _new_plan.slug, _new_plan.name,
     _granted, _expires, _source_ref)
  RETURNING * INTO _existing;

  PERFORM public.recompute_token_balance(_tenant_id);

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', _existing.id,
    'from_plan', _old_plan.slug,
    'to_plan', _new_plan.slug,
    'credits_granted', _granted,
    'credits_expire_at', _expires
  );
END;
$$;

-- ── 4. Advancing the billing period ─────────────────────────────────────────
-- The monthly cron only issues once per (plan, period start), so an allowance
-- renews only if the period actually moves. Stripe knows when it does; this is
-- how that gets recorded. Issuing immediately rather than waiting up to an
-- hour for the cron, because a renewal a customer has just paid for should be
-- spendable straight away.
CREATE OR REPLACE FUNCTION public.advance_tenant_billing_period(
  _tenant_id    UUID,
  _period_start TIMESTAMPTZ,
  _period_end   TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tenant public.tenants%ROWTYPE;
  _issued JSONB;
BEGIN
  SELECT * INTO _tenant FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;
  IF _period_start IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'period_start_required');
  END IF;

  -- Never move the period backwards. Stripe redelivers, and an out-of-order
  -- event that rewound the period would re-issue an allowance for a month
  -- already credited.
  IF _tenant.current_period_start IS NOT NULL
     AND _period_start <= _tenant.current_period_start THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_newer');
  END IF;

  UPDATE public.tenants
     SET current_period_start = _period_start,
         current_period_end   = COALESCE(_period_end, current_period_end),
         updated_at           = now()
   WHERE id = _tenant_id;

  _issued := public.issue_plan_allowance(_tenant_id, _period_start);
  PERFORM public.recompute_token_balance(_tenant_id);

  RETURN jsonb_build_object('ok', true, 'issued', _issued);
END;
$$;

-- ── 5. Announcing it once ───────────────────────────────────────────────────
-- Returns the unseen changes for a tenant. Reading is not seeing, so this does
-- not acknowledge: a page that fetched and then failed to render would
-- otherwise swallow the only notice a customer ever gets.
CREATE OR REPLACE FUNCTION public.unseen_plan_changes(_tenant_id UUID)
RETURNS SETOF public.plan_change_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.plan_change_events
   WHERE tenant_id = _tenant_id AND acknowledged_at IS NULL
   ORDER BY created_at DESC
   LIMIT 5
$$;

-- Acknowledging is scoped to the tenant, so possession of an id alone cannot
-- retire someone else's notice.
CREATE OR REPLACE FUNCTION public.acknowledge_plan_change(_tenant_id UUID, _event_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows INTEGER;
BEGIN
  UPDATE public.plan_change_events
     SET acknowledged_at = now()
   WHERE id = _event_id AND tenant_id = _tenant_id AND acknowledged_at IS NULL;
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'acknowledged', _rows > 0);
END;
$$;

-- ── 6. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.apply_seat_plan_change(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_seat_plan_change(UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.advance_tenant_billing_period(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_tenant_billing_period(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

REVOKE ALL ON FUNCTION public.unseen_plan_changes(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unseen_plan_changes(UUID) TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.acknowledge_plan_change(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_plan_change(UUID, UUID) TO service_role, authenticated;

-- ── 7. Prove the seeding landed ─────────────────────────────────────────────
DO $$
DECLARE _bad TEXT;
BEGIN
  SELECT string_agg(x.slug || '=' || COALESCE(bp.monthly_allowance::text, 'missing'), ', ')
    INTO _bad
    FROM (VALUES ('launch', 7000), ('growth', 35000), ('scale', 75000)) AS x(slug, want)
    LEFT JOIN public.billing_plans bp ON bp.slug = x.slug
   WHERE bp.monthly_allowance IS DISTINCT FROM x.want;

  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'tier allowances did not seed correctly: %', _bad;
  END IF;
END $$;
