-- Carry the buyer's contact details into Stripe so checkout is prefilled.
ALTER TABLE public.billing_handoffs
  ADD COLUMN IF NOT EXISTS contact_email      text,
  ADD COLUMN IF NOT EXISTS contact_first_name text,
  ADD COLUMN IF NOT EXISTS contact_last_name  text,
  ADD COLUMN IF NOT EXISTS contact_phone      text,
  ADD COLUMN IF NOT EXISTS contact_company    text;

COMMENT ON COLUMN public.billing_handoffs.contact_email IS
  'Buyer email supplied by the clone when minting the handoff. Seeds the Stripe Customer (never overwrites an existing billing email) and becomes the purchase receipt address.';
COMMENT ON COLUMN public.billing_handoffs.contact_company IS
  'Buyer organisation name. Used for the Stripe Customer name when the tenant has none.';

ALTER TABLE public.payment_methods
  ADD COLUMN IF NOT EXISTS billing_name  text,
  ADD COLUMN IF NOT EXISTS billing_email text;

COMMENT ON COLUMN public.payment_methods.billing_name IS
  'Cardholder name from the payment method billing_details. Display only — no card data is ever stored here.';

-- ABN capture on checkout.
ALTER TABLE public.billing_handoffs
  ADD COLUMN IF NOT EXISTS contact_tax_id      text,
  ADD COLUMN IF NOT EXISTS contact_tax_id_type text;

COMMENT ON COLUMN public.billing_handoffs.contact_tax_id IS
  'Business tax ID (ABN, digits only) supplied by the clone. Validated before use; an invalid value is dropped so Checkout asks the buyer instead.';
COMMENT ON COLUMN public.billing_handoffs.contact_tax_id_type IS
  'Stripe tax ID type for contact_tax_id. Defaults to au_abn when omitted.';

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS tax_id_type          text,
  ADD COLUMN IF NOT EXISTS tax_id_value         text,
  ADD COLUMN IF NOT EXISTS tax_id_business_name text,
  ADD COLUMN IF NOT EXISTS tax_id_captured_at   timestamptz;

COMMENT ON COLUMN public.tenants.tax_id_value IS
  'Business tax ID as held by Stripe for this tenant''s Customer. Mirrored by the checkout webhook; Stripe remains authoritative.';
COMMENT ON COLUMN public.tenants.tax_id_business_name IS
  'Legal entity name the buyer declared alongside the tax ID. Recorded only — Customer.name stays the workspace name.';

CREATE INDEX IF NOT EXISTS tenants_tax_id_value_idx
  ON public.tenants (tax_id_value)
  WHERE tax_id_value IS NOT NULL;

-- Report cost index seed.
INSERT INTO public.report_credit_costs
  (slug, name, category, description, credit_cost, sort_order, metadata)
VALUES
  ('report.investment.compass', 'Investment Report — Compass', 'report',
   'Full Compass-40 property investment report.', 12, 10,
   '{"token_kind":"report.investment.compass","default_credit_cost":12,"complexity":"high"}'::jsonb),
  ('report.investment.executive', 'Investment Report — Executive', 'report',
   'Executive-tier property investment report.', 8, 20,
   '{"token_kind":"report.investment.executive","default_credit_cost":8,"complexity":"medium"}'::jsonb),
  ('report.investment.financial', 'Investment Report — Financial Analysis', 'report',
   'Financial-analysis tier property investment report.', 5, 30,
   '{"token_kind":"report.investment.financial","default_credit_cost":5,"complexity":"medium"}'::jsonb),
  ('report.investment.snapshot', 'Investment Report — Snapshot', 'report',
   'Short-form property snapshot.', 4, 40,
   '{"token_kind":"report.investment.snapshot","default_credit_cost":4,"complexity":"low"}'::jsonb),
  ('report.suburb.compass', 'Suburb Report — Compass', 'report',
   'Suburb-scope Compass report.', 10, 50,
   '{"token_kind":"report.suburb.compass","default_credit_cost":10,"complexity":"high"}'::jsonb),
  ('report.postcode.compass', 'Postcode Report — Compass', 'report',
   'Postcode-scope Compass report.', 10, 60,
   '{"token_kind":"report.postcode.compass","default_credit_cost":10,"complexity":"high"}'::jsonb),
  ('report.market-intelligence', 'Market Intelligence Report', 'report',
   'Market intelligence / market pulse report.', 6, 70,
   '{"token_kind":"report.market-intelligence","default_credit_cost":6,"complexity":"medium"}'::jsonb),
  ('report.portfolio-review', 'Portfolio Analysis', 'report',
   'Client portfolio review and projections.', 8, 80,
   '{"token_kind":"report.portfolio-review","default_credit_cost":8,"complexity":"medium"}'::jsonb),
  ('report.bulk-item', 'Bulk Report — Per Item', 'report',
   'One item within a bulk generation run.', 8, 90,
   '{"token_kind":"report.bulk-item","default_credit_cost":8,"complexity":"medium"}'::jsonb),
  ('report.chart-analysis', 'Chart Analysis', 'report',
   'AI commentary on a single chart.', 2, 100,
   '{"token_kind":"report.chart-analysis","default_credit_cost":2,"complexity":"low"}'::jsonb),
  ('report.qualitative-regen', 'Qualitative Regeneration', 'report',
   'Re-runs the qualitative sections of an existing report.', 3, 110,
   '{"token_kind":"report.qualitative-regen","default_credit_cost":3,"complexity":"low"}'::jsonb),
  ('aml_identity_check', 'AML — Identity Check', 'compliance',
   'Provider-backed identity verification.', 4, 200,
   '{"token_kind":"aml_identity_check","default_credit_cost":4,"complexity":"low"}'::jsonb),
  ('aml_screening_check', 'AML — Screening Check', 'compliance',
   'Sanctions / PEP / adverse-media screening.', 4, 210,
   '{"token_kind":"aml_screening_check","default_credit_cost":4,"complexity":"low"}'::jsonb)
ON CONFLICT (slug) DO UPDATE
  SET name        = EXCLUDED.name,
      category    = EXCLUDED.category,
      description = COALESCE(public.report_credit_costs.description, EXCLUDED.description),
      sort_order  = EXCLUDED.sort_order,
      metadata    = public.report_credit_costs.metadata || EXCLUDED.metadata;

DROP POLICY IF EXISTS "Admins write report_credit_costs" ON public.report_credit_costs;
DROP POLICY IF EXISTS "Super admins write report_credit_costs" ON public.report_credit_costs;
CREATE POLICY "Super admins write report_credit_costs"
  ON public.report_credit_costs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

CREATE TABLE IF NOT EXISTS public.report_cost_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        bigint GENERATED ALWAYS AS IDENTITY,
  published_by   uuid,
  note           text,
  costs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  changes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cascade_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_cost_revisions_created_idx
  ON public.report_cost_revisions (created_at DESC);

ALTER TABLE public.report_cost_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read report_cost_revisions" ON public.report_cost_revisions;
CREATE POLICY "Operators read report_cost_revisions"
  ON public.report_cost_revisions FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));
REVOKE ALL ON public.report_cost_revisions FROM PUBLIC, anon;
GRANT SELECT ON public.report_cost_revisions TO authenticated;
GRANT ALL    ON public.report_cost_revisions TO service_role;

COMMENT ON TABLE public.report_cost_revisions IS
  'Audit trail of report cost index publishes, including the per-clone cascade outcome.';

-- Token metering fixes: commit_tokens ordering.
CREATE OR REPLACE FUNCTION public.commit_tokens(
  _job_id UUID,
  _actual_tokens INTEGER,
  _result_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job public.report_jobs%ROWTYPE;
  _available INTEGER;
BEGIN
  SELECT * INTO _job FROM public.report_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;
  IF _job.status = 'completed' THEN
    SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _job.tenant_id;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'charged_tokens', _job.charged_tokens, 'available_after', COALESCE(_available,0));
  END IF;
  IF _job.status <> 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_reservable', 'status', _job.status);
  END IF;
  IF _actual_tokens IS NULL OR _actual_tokens < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_actual');
  END IF;

  UPDATE public.report_jobs
     SET status = 'completed',
         charged_tokens = _actual_tokens,
         result_meta = _result_meta,
         completed_at = now(),
         reservation_expires_at = NULL
   WHERE id = _job_id;

  INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
  VALUES (_job.tenant_id, 'release', _job.estimated_tokens, 'report', _job.kind, _job.id, 'commit_release');

  IF _actual_tokens > 0 THEN
    INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
    VALUES (_job.tenant_id, 'debit', _actual_tokens, 'report', _job.kind, _job.id, 'commit_debit');
  END IF;

  PERFORM public.recompute_token_balance(_job.tenant_id);
  SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _job.tenant_id;
  RETURN jsonb_build_object('ok', true, 'charged_tokens', _actual_tokens, 'available_after', COALESCE(_available, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_token_reservation(_job_id UUID, _reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job public.report_jobs%ROWTYPE;
  _available INTEGER;
BEGIN
  SELECT * INTO _job FROM public.report_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;
  IF _job.status <> 'reserved' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'outcome', 'noop',
      'released_tokens', 0, 'status', _job.status);
  END IF;

  UPDATE public.report_jobs
     SET status = 'canceled', error = _reason, reservation_expires_at = NULL, completed_at = now()
   WHERE id = _job_id;

  INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
  VALUES (_job.tenant_id, 'release', _job.estimated_tokens, 'report', _job.kind, _job.id, COALESCE(_reason, 'canceled'));

  PERFORM public.recompute_token_balance(_job.tenant_id);
  SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _job.tenant_id;
  RETURN jsonb_build_object('ok', true, 'outcome', 'canceled',
    'released_tokens', _job.estimated_tokens, 'available_after', COALESCE(_available, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_job(_job_id UUID, _reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _job public.report_jobs%ROWTYPE;
BEGIN
  SELECT * INTO _job FROM public.report_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'job_not_found'); END IF;
  IF _job.status <> 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refundable', 'status', _job.status);
  END IF;
  UPDATE public.report_jobs SET status = 'refunded', completed_at = now() WHERE id = _job_id;
  IF _job.charged_tokens > 0 THEN
    INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason, created_by)
    VALUES (_job.tenant_id, 'refund', _job.charged_tokens, 'manual', _job.kind, _job.id, COALESCE(_reason, 'manual_refund'), auth.uid());
  END IF;
  PERFORM public.recompute_token_balance(_job.tenant_id);
  RETURN jsonb_build_object('ok', true, 'refunded_tokens', _job.charged_tokens);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_token_job(_job_id UUID, _reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job public.report_jobs%ROWTYPE;
  _outcome TEXT;
  _released INTEGER := 0;
  _available INTEGER;
BEGIN
  SELECT * INTO _job FROM public.report_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_job.tenant_id::text, 0));

  IF _job.status = 'reserved' THEN
    UPDATE public.report_jobs
       SET status = 'canceled',
           error = COALESCE(_reason, 'generation_failed'),
           reservation_expires_at = NULL,
           completed_at = now()
     WHERE id = _job_id;

    INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
    VALUES (_job.tenant_id, 'release', _job.estimated_tokens, 'report', _job.kind, _job.id,
            COALESCE(_reason, 'generation_failed'));

    _outcome := 'canceled';
    _released := _job.estimated_tokens;

  ELSIF _job.status = 'completed' THEN
    UPDATE public.report_jobs
       SET status = 'refunded',
           error = COALESCE(_job.error, _reason, 'generation_failed'),
           completed_at = now()
     WHERE id = _job_id;

    IF _job.charged_tokens > 0 THEN
      INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
      VALUES (_job.tenant_id, 'refund', _job.charged_tokens, 'report', _job.kind, _job.id,
              COALESCE(_reason, 'generation_failed'));
    END IF;

    _outcome := 'refunded';
    _released := _job.charged_tokens;

  ELSE
    _outcome := 'noop';
  END IF;

  PERFORM public.recompute_token_balance(_job.tenant_id);
  SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _job.tenant_id;

  RETURN jsonb_build_object(
    'ok', true,
    'outcome', _outcome,
    'released_tokens', _released,
    'status', CASE WHEN _outcome = 'noop' THEN _job.status::text ELSE _outcome END,
    'available_after', COALESCE(_available, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_token_balance(
  _tenant_id UUID,
  _max_age_seconds INTEGER DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _updated_at TIMESTAMPTZ;
  _did BOOLEAN := false;
BEGIN
  SELECT updated_at INTO _updated_at FROM public.token_balances WHERE tenant_id = _tenant_id;
  IF _updated_at IS NULL
     OR _updated_at < now() - make_interval(secs => GREATEST(COALESCE(_max_age_seconds, 60), 5)) THEN
    PERFORM public.recompute_token_balance(_tenant_id);
    _did := true;
  END IF;
  RETURN jsonb_build_object('ok', true, 'recomputed', _did);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_token_job(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.refresh_token_balance(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_token_job(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_token_balance(UUID, INTEGER) TO authenticated, service_role;

-- 30-day token expiry, with rollover.
CREATE OR REPLACE FUNCTION public.token_expiry_days()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT 30
$$;

COMMENT ON FUNCTION public.token_expiry_days() IS
  'Platform token lifetime in days. Change here and every issuance path follows.';

CREATE OR REPLACE FUNCTION public.recompute_token_balance(_tenant_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _live      BIGINT := 0;
  _reserved  BIGINT := 0;
  _granted   BIGINT := 0;
  _spent     BIGINT := 0;
BEGIN
  SELECT
    COALESCE(SUM(tokens) FILTER (WHERE kind IN ('grant', 'topup')), 0),
    COALESCE(SUM(ABS(tokens)) FILTER (WHERE kind = 'debit'), 0)
  INTO _granted, _spent
  FROM public.token_ledger
  WHERE tenant_id = _tenant_id;

  WITH lots AS (
    SELECT id, tokens AS amount, expires_at, created_at
      FROM public.token_ledger
     WHERE tenant_id = _tenant_id
       AND kind IN ('grant', 'topup', 'refund', 'adjustment')
       AND tokens > 0
  ),
  ordered AS (
    SELECT
      amount,
      expires_at,
      SUM(amount) OVER (
        ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS cum_after
    FROM lots
  ),
  spend AS (
    SELECT COALESCE(SUM(ABS(tokens)), 0) AS total
      FROM public.token_ledger
     WHERE tenant_id = _tenant_id
       AND kind = 'debit'
  )
  SELECT COALESCE(SUM(GREATEST(0, LEAST(o.amount, o.cum_after - s.total))), 0)
    INTO _live
    FROM ordered o CROSS JOIN spend s
   WHERE o.expires_at IS NULL OR o.expires_at > now();

  SELECT COALESCE(SUM(estimated_tokens), 0) INTO _reserved
  FROM public.report_jobs
  WHERE tenant_id = _tenant_id
    AND status = 'reserved'
    AND (reservation_expires_at IS NULL OR reservation_expires_at > now());
  _reserved := GREATEST(0, LEAST(_reserved, 2147483647));

  INSERT INTO public.token_balances
    (tenant_id, available, reserved, lifetime_granted, lifetime_spent, updated_at)
  VALUES (
    _tenant_id,
    GREATEST(0, LEAST(_live - _reserved, 2147483647))::int,
    _reserved::int,
    LEAST(_granted, 2147483647)::int,
    LEAST(_spent, 2147483647)::int,
    now()
  )
  ON CONFLICT (tenant_id) DO UPDATE
    SET available        = EXCLUDED.available,
        reserved         = EXCLUDED.reserved,
        lifetime_granted = EXCLUDED.lifetime_granted,
        lifetime_spent   = EXCLUDED.lifetime_spent,
        updated_at       = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_tokens(
  _tenant_id UUID, _tokens INTEGER, _reason TEXT, _expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _expires TIMESTAMPTZ;
BEGIN
  IF _tokens IS NULL OR _tokens <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  _expires := COALESCE(_expires_at, now() + make_interval(days => public.token_expiry_days()));

  INSERT INTO public.token_ledger
    (tenant_id, kind, tokens, source, reason, expires_at, created_by, metadata)
  VALUES (
    _tenant_id, 'grant', _tokens, 'manual', _reason, _expires, auth.uid(),
    jsonb_build_object('expiry_overridden', _expires_at IS NOT NULL)
  );
  RETURN jsonb_build_object('ok', true, 'expires_at', _expires);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_topup(
  _tenant_id UUID, _pack_id UUID, _source_ref TEXT DEFAULT NULL,
  _metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _pack public.topup_packs%ROWTYPE; _expires TIMESTAMPTZ; _days INTEGER;
BEGIN
  SELECT * INTO _pack FROM public.topup_packs WHERE id = _pack_id AND is_active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'pack_not_found'); END IF;

  IF _source_ref IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.token_ledger
     WHERE tenant_id = _tenant_id AND kind = 'topup' AND source_ref = _source_ref
  ) THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'tokens', _pack.tokens);
  END IF;

  _days := LEAST(COALESCE(_pack.expires_after_days, public.token_expiry_days()),
                 public.token_expiry_days());
  _expires := now() + make_interval(days => _days);

  INSERT INTO public.token_ledger
    (tenant_id, kind, tokens, source, source_ref, reason, expires_at, created_by, metadata)
  VALUES
    (_tenant_id, 'topup', _pack.tokens, 'topup', COALESCE(_source_ref, _pack.slug),
     'topup_' || _pack.slug, _expires, auth.uid(), COALESCE(_metadata, '{}'::jsonb));

  RETURN jsonb_build_object('ok', true, 'tokens', _pack.tokens, 'expires_at', _expires);
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_plan_allowance(
  _tenant_id UUID,
  _period_start TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _tenant     public.tenants%ROWTYPE;
  _allowance  INTEGER;
  _start      TIMESTAMPTZ;
  _ref        TEXT;
  _expires    TIMESTAMPTZ;
BEGIN
  SELECT * INTO _tenant FROM public.tenants WHERE id = _tenant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;
  IF _tenant.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tenant_inactive');
  END IF;

  SELECT bp.monthly_allowance INTO _allowance
    FROM public.billing_plans bp WHERE bp.id = _tenant.plan_id;
  IF COALESCE(_allowance, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'no_allowance');
  END IF;

  _start := COALESCE(_period_start, _tenant.current_period_start, date_trunc('month', now()));
  _ref   := 'plan:' || COALESCE(_tenant.plan_id::text, 'none') || ':' || to_char(_start, 'YYYY-MM-DD');

  IF EXISTS (
    SELECT 1 FROM public.token_ledger
     WHERE tenant_id = _tenant_id AND kind = 'grant' AND source_ref = _ref
  ) THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'tokens', _allowance);
  END IF;

  _expires := now() + make_interval(days => public.token_expiry_days());

  INSERT INTO public.token_ledger
    (tenant_id, kind, tokens, source, source_ref, reason, expires_at, metadata)
  VALUES (
    _tenant_id, 'grant', _allowance, 'subscription', _ref,
    'plan_allowance', _expires,
    jsonb_build_object('period_start', _start, 'plan_id', _tenant.plan_id)
  );

  RETURN jsonb_build_object('ok', true, 'tokens', _allowance, 'expires_at', _expires);
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_due_plan_allowances()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _t       RECORD;
  _result  JSONB;
  _issued  INTEGER := 0;
  _skipped INTEGER := 0;
BEGIN
  FOR _t IN
    SELECT id FROM public.tenants
     WHERE status = 'active'
       AND plan_id IS NOT NULL
       AND current_period_start IS NOT NULL
       AND current_period_start >= TIMESTAMPTZ '2026-07-28 00:00:00+00'
  LOOP
    _result := public.issue_plan_allowance(_t.id, NULL);
    IF COALESCE(_result ->> 'tokens', '') <> '' AND (_result ->> 'idempotent') IS NULL THEN
      _issued := _issued + 1;
      PERFORM public.recompute_token_balance(_t.id);
    ELSE
      _skipped := _skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'issued', _issued, 'skipped', _skipped);
END;
$$;

CREATE OR REPLACE FUNCTION public.token_expiry_schedule(_tenant_id UUID)
RETURNS TABLE (expires_at TIMESTAMPTZ, remaining INTEGER, kind TEXT, reason TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lots AS (
    SELECT id, tokens AS amount, token_ledger.expires_at, created_at,
           token_ledger.kind::text AS lot_kind, token_ledger.reason AS lot_reason
      FROM public.token_ledger
     WHERE tenant_id = _tenant_id
       AND token_ledger.kind IN ('grant', 'topup', 'refund', 'adjustment')
       AND tokens > 0
  ),
  ordered AS (
    SELECT amount, lots.expires_at, lot_kind, lot_reason,
           SUM(amount) OVER (
             ORDER BY lots.expires_at ASC NULLS LAST, created_at ASC, id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cum_after
      FROM lots
  ),
  spend AS (
    SELECT COALESCE(SUM(ABS(tokens)), 0) AS total
      FROM public.token_ledger
     WHERE tenant_id = _tenant_id AND token_ledger.kind = 'debit'
  )
  SELECT o.expires_at,
         GREATEST(0, LEAST(o.amount, o.cum_after - s.total))::int AS remaining,
         o.lot_kind,
         o.lot_reason
    FROM ordered o CROSS JOIN spend s
   WHERE (o.expires_at IS NULL OR o.expires_at > now())
     AND GREATEST(0, LEAST(o.amount, o.cum_after - s.total)) > 0
   ORDER BY o.expires_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.token_expiry_schedule(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.token_expiry_schedule(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.issue_plan_allowance(UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_plan_allowance(UUID, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.issue_due_plan_allowances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_due_plan_allowances() TO service_role;
REVOKE ALL ON FUNCTION public.token_expiry_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.token_expiry_days() TO authenticated, service_role;

-- Recompute all tenant balances under the new lot arithmetic.
DO $$
DECLARE _t UUID;
BEGIN
  FOR _t IN SELECT id FROM public.tenants LOOP
    PERFORM public.recompute_token_balance(_t);
  END LOOP;
END;
$$;

-- Schedule hourly allowance issuance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'token-plan-allowances') THEN
      PERFORM cron.unschedule('token-plan-allowances');
    END IF;
    PERFORM cron.schedule(
      'token-plan-allowances', '7 * * * *',
      'SELECT public.issue_due_plan_allowances()'
    );
  ELSE
    RAISE NOTICE 'pg_cron not installed — call public.issue_due_plan_allowances() from your scheduler.';
  END IF;
END $$;

-- Merge split billing tenants from the earlier checkout bug.
DO $$
DECLARE
  _dup     RECORD;
  _target  UUID;
  _moved   INTEGER;
  _targets INTEGER;
BEGIN
  FOR _dup IN
    SELECT t.id, t.clone_id, t.external_ref, t.display_name
      FROM public.tenants t
     WHERE t.clone_id IS NOT NULL
       AND t.external_ref NOT LIKE 'prime:%'
       AND NOT EXISTS (
         SELECT 1 FROM public.token_ledger l
          WHERE l.tenant_id = t.id
            AND l.kind IN ('reserve', 'debit', 'release')
       )
       AND EXISTS (
         SELECT 1 FROM public.token_ledger l
          WHERE l.tenant_id = t.id
            AND l.kind IN ('grant', 'topup', 'refund', 'adjustment')
       )
  LOOP
    SELECT COUNT(*) INTO _targets
      FROM public.tenants p
     WHERE p.clone_id = _dup.clone_id
       AND p.external_ref LIKE 'prime:%';

    IF _targets <> 1 THEN
      RAISE NOTICE 'Skipping tenant % (clone %): found % metering tenants, expected exactly 1.',
        _dup.id, _dup.clone_id, _targets;
      CONTINUE;
    END IF;

    SELECT p.id INTO _target
      FROM public.tenants p
     WHERE p.clone_id = _dup.clone_id
       AND p.external_ref LIKE 'prime:%'
     LIMIT 1;

    UPDATE public.token_ledger
       SET tenant_id = _target,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'merged_from_tenant_id', _dup.id::text,
                  'merged_from_external_ref', _dup.external_ref,
                  'merged_reason', 'split_clone_billing_tenant',
                  'merged_at', now()
                )
     WHERE tenant_id = _dup.id
       AND (metadata ->> 'merged_reason') IS DISTINCT FROM 'split_clone_billing_tenant';
    GET DIAGNOSTICS _moved = ROW_COUNT;

    UPDATE public.purchases   SET tenant_id = _target WHERE tenant_id = _dup.id;
    UPDATE public.report_jobs SET tenant_id = _target WHERE tenant_id = _dup.id;

    UPDATE public.tenants
       SET display_name = COALESCE(display_name, '') || ' (merged)',
           external_ref = _dup.external_ref || ':merged:' || _dup.id::text
     WHERE id = _dup.id
       AND external_ref NOT LIKE '%:merged:%';

    PERFORM public.recompute_token_balance(_target);
    PERFORM public.recompute_token_balance(_dup.id);

    RAISE NOTICE 'Merged % ledger rows from tenant % (%) into metering tenant %.',
      _moved, _dup.id, _dup.external_ref, _target;
  END LOOP;
END;
$$;