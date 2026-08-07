-- ─────────────────────────────────────────────────────────────────────────────
-- Per-tenant metering and billing for the prime's third-party API keys.
--
-- A clone provisioned by Mission Control boots with the prime's own vendor
-- keys forwarded into its Supabase project (see `prime_secret_forwards` and
-- `syncCloneSecrets`). That is a real cost to us — every OpenAI token, Resend
-- email, Domain lookup and AML verification a clone makes on a forwarded key
-- is billed to *our* account. This schema makes that cost attributable and
-- rechargeable, and it makes the opposite case — a clone that supplies its own
-- key — provably free.
--
-- The billability rule is deliberately not a flag anyone sets by hand. It is
-- read from `clone_backend_secrets.status`, which provisioning and the operator
-- "set secret" action already maintain:
--
--     inherited  → the clone is running on OUR key      → BILLABLE
--     set        → the operator/clone wrote their own   → NOT billable (BYOK)
--     missing    → no key on the clone at all           → NOT billable
--     failed     → the sync errored, no key landed      → NOT billable
--     (no row)   → we never lent this clone a key       → NOT billable
--
-- The last case matters: an event we cannot tie to a key we lent is recorded
-- and surfaced, never charged. We do not bill on a guess.
--
-- Money is carried in *micros* (1e-6 of a currency unit) because per-token
-- rates are far below a cent — AUD 0.0000006 per Gemini Flash input token
-- rounds to zero in cents and would meter as free forever. Micros are
-- converted to cents exactly once, at settlement.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Provider rate catalog ────────────────────────────────────────────────
--
-- One row per *secret name*, because the secret name is the only identifier
-- shared by all three parties: the prime's edge functions read it from
-- `Deno.env`, `prime_secret_forwards` whitelists it, and `clone_backend_secrets`
-- records whose key is behind it. Provider slug is a display grouping, not a
-- key — GOOGLE_MAPS_API_KEY and GOOGLE_API_KEY are separate spend.

CREATE TABLE IF NOT EXISTS public.api_provider_rates (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_name             text NOT NULL UNIQUE,
  provider                text NOT NULL,
  display_name            text NOT NULL,
  category                text NOT NULL DEFAULT 'other'
    CHECK (category IN ('ai','email','data','maps','voice','documents','crm','marketing','infra','render','compliance','other')),
  -- What one unit of this provider is. Drives the UI's unit label and the
  -- prime's reporter contract; a mismatch is rejected at ingest.
  unit                    text NOT NULL DEFAULT 'request'
    CHECK (unit IN ('request','token','email','minute','document','page','render','verification','message','lookup')),
  -- Our wholesale cost, for margin reporting only — never charged.
  cost_micros_per_unit    numeric(18,6) NOT NULL DEFAULT 0 CHECK (cost_micros_per_unit >= 0),
  -- What a piggybacking tenant pays per unit. Zero = metered but not charged.
  resale_micros_per_unit  numeric(18,6) NOT NULL DEFAULT 0 CHECK (resale_micros_per_unit >= 0),
  -- Units forgiven per tenant per billing period before anything is charged.
  included_free_units     numeric(18,4) NOT NULL DEFAULT 0 CHECK (included_free_units >= 0),
  currency                text NOT NULL DEFAULT 'AUD',
  -- Off for keys we forward but never recharge (shared infra, our own
  -- webhook secrets, free-tier services). Metering still happens.
  is_billable             boolean NOT NULL DEFAULT true,
  is_active               boolean NOT NULL DEFAULT true,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_provider_rates_provider
  ON public.api_provider_rates(provider);
CREATE INDEX IF NOT EXISTS idx_api_provider_rates_active
  ON public.api_provider_rates(is_active, is_billable);

GRANT SELECT ON public.api_provider_rates TO authenticated;
GRANT ALL    ON public.api_provider_rates TO service_role;
ALTER TABLE public.api_provider_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read api_provider_rates" ON public.api_provider_rates;
CREATE POLICY "Operators read api_provider_rates" ON public.api_provider_rates
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins write api_provider_rates" ON public.api_provider_rates;
CREATE POLICY "Admins write api_provider_rates" ON public.api_provider_rates
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS api_provider_rates_updated_at ON public.api_provider_rates;
CREATE TRIGGER api_provider_rates_updated_at
  BEFORE UPDATE ON public.api_provider_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── 2. Raw usage events ─────────────────────────────────────────────────────
--
-- Every reported call, billable or not. Kept so a disputed invoice can be
-- answered with the calls behind it, and so BYOK savings are demonstrable
-- rather than asserted.

CREATE TABLE IF NOT EXISTS public.api_usage_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id          uuid REFERENCES public.clones(id) ON DELETE SET NULL,
  secret_name       text NOT NULL,
  provider          text NOT NULL,
  unit              text NOT NULL,
  quantity          numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  model             text,
  feature           text,
  call_status       text NOT NULL DEFAULT 'success' CHECK (call_status IN ('success','error')),
  -- Rating outcome, decided once at ingest and never recomputed.
  billable          boolean NOT NULL DEFAULT false,
  billing_reason    text NOT NULL
    CHECK (billing_reason IN ('inherited','byok','no_key','unknown_secret','not_billable','error_call','rate_missing')),
  -- quantity × resale rate, at the rate in force when the call happened.
  rated_micros      numeric(18,6) NOT NULL DEFAULT 0 CHECK (rated_micros >= 0),
  cost_micros       numeric(18,6) NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  currency          text NOT NULL DEFAULT 'AUD',
  -- The tenant billing period this event lands in, resolved at ingest so a
  -- later plan change cannot move history between invoices.
  period_start      date NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  idempotency_key   text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_events_tenant_period
  ON public.api_usage_events(tenant_id, period_start, secret_name);
CREATE INDEX IF NOT EXISTS idx_api_usage_events_clone_occurred
  ON public.api_usage_events(clone_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_events_occurred
  ON public.api_usage_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_events_unattributed
  ON public.api_usage_events(secret_name, occurred_at DESC)
  WHERE billing_reason IN ('unknown_secret','rate_missing');

GRANT SELECT ON public.api_usage_events TO authenticated;
GRANT ALL    ON public.api_usage_events TO service_role;
ALTER TABLE public.api_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read api_usage_events" ON public.api_usage_events;
CREATE POLICY "Operators read api_usage_events" ON public.api_usage_events
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

-- ─── 3. Per-period rollups ───────────────────────────────────────────────────
--
-- The event table answers "which calls"; this one answers "how much", without
-- scanning millions of rows to draw a dashboard. Maintained inside the ingest
-- RPC so it can never drift from the events that produced it.

CREATE TABLE IF NOT EXISTS public.api_usage_rollups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id            uuid REFERENCES public.clones(id) ON DELETE SET NULL,
  period_start        date NOT NULL,
  secret_name         text NOT NULL,
  provider            text NOT NULL,
  unit                text NOT NULL,
  currency            text NOT NULL DEFAULT 'AUD',
  -- Everything reported, whoever's key it was.
  gross_quantity      numeric(18,4) NOT NULL DEFAULT 0,
  -- The slice that ran on our key.
  billable_quantity   numeric(18,4) NOT NULL DEFAULT 0,
  -- The slice the tenant's own key covered — the BYOK saving, shown back to
  -- them as the reason to bring their own.
  byok_quantity       numeric(18,4) NOT NULL DEFAULT 0,
  event_count         integer NOT NULL DEFAULT 0,
  error_count         integer NOT NULL DEFAULT 0,
  gross_charge_micros numeric(18,6) NOT NULL DEFAULT 0,
  cost_micros         numeric(18,6) NOT NULL DEFAULT 0,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, secret_name)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_rollups_period
  ON public.api_usage_rollups(period_start DESC, tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_rollups_clone
  ON public.api_usage_rollups(clone_id, period_start DESC);

GRANT SELECT ON public.api_usage_rollups TO authenticated;
GRANT ALL    ON public.api_usage_rollups TO service_role;
ALTER TABLE public.api_usage_rollups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read api_usage_rollups" ON public.api_usage_rollups;
CREATE POLICY "Operators read api_usage_rollups" ON public.api_usage_rollups
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

-- ─── 4. Settled charges ──────────────────────────────────────────────────────
--
-- Closing a period freezes its rollups into an immutable charge: the free
-- allowance is applied once, micros become cents once, and the result is what
-- goes to Stripe. Re-closing an already-closed period is a no-op rather than a
-- second charge — settlement runs on a cron and retries.

CREATE TABLE IF NOT EXISTS public.api_usage_charges (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id              uuid REFERENCES public.clones(id) ON DELETE SET NULL,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  currency              text NOT NULL DEFAULT 'AUD',
  amount_cents          integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  amount_micros         numeric(18,6) NOT NULL DEFAULT 0 CHECK (amount_micros >= 0),
  cost_micros           numeric(18,6) NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed','invoiced','waived','failed')),
  stripe_invoice_item_id text,
  stripe_customer_id    text,
  last_error            text,
  closed_at             timestamptz,
  invoiced_at           timestamptz,
  waived_by             uuid,
  waived_reason         text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_charges_status
  ON public.api_usage_charges(status, period_start DESC);

GRANT SELECT ON public.api_usage_charges TO authenticated;
GRANT ALL    ON public.api_usage_charges TO service_role;
ALTER TABLE public.api_usage_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read api_usage_charges" ON public.api_usage_charges;
CREATE POLICY "Operators read api_usage_charges" ON public.api_usage_charges
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins write api_usage_charges" ON public.api_usage_charges;
CREATE POLICY "Admins write api_usage_charges" ON public.api_usage_charges
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS api_usage_charges_updated_at ON public.api_usage_charges;
CREATE TRIGGER api_usage_charges_updated_at
  BEFORE UPDATE ON public.api_usage_charges
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-secret breakdown of a settled charge. This is the invoice's supporting
-- detail; without it "API usage — $412.60" is unanswerable when queried.
CREATE TABLE IF NOT EXISTS public.api_usage_charge_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id            uuid NOT NULL REFERENCES public.api_usage_charges(id) ON DELETE CASCADE,
  secret_name          text NOT NULL,
  provider             text NOT NULL,
  display_name         text NOT NULL,
  unit                 text NOT NULL,
  billable_quantity    numeric(18,4) NOT NULL DEFAULT 0,
  free_units_applied   numeric(18,4) NOT NULL DEFAULT 0,
  charged_quantity     numeric(18,4) NOT NULL DEFAULT 0,
  rate_micros_per_unit numeric(18,6) NOT NULL DEFAULT 0,
  amount_micros        numeric(18,6) NOT NULL DEFAULT 0,
  byok_quantity        numeric(18,4) NOT NULL DEFAULT 0,
  UNIQUE (charge_id, secret_name)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_charge_lines_charge
  ON public.api_usage_charge_lines(charge_id);

GRANT SELECT ON public.api_usage_charge_lines TO authenticated;
GRANT ALL    ON public.api_usage_charge_lines TO service_role;
ALTER TABLE public.api_usage_charge_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read api_usage_charge_lines" ON public.api_usage_charge_lines;
CREATE POLICY "Operators read api_usage_charge_lines" ON public.api_usage_charge_lines
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));

-- ─── 5. Billability resolver ─────────────────────────────────────────────────
--
-- Split out from the ingest RPC so the rule can be read — and tested — on its
-- own. Returns the `billing_reason` the event will carry.

CREATE OR REPLACE FUNCTION public.resolve_api_key_billability(
  _clone_id uuid,
  _secret_name text
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _status text;
BEGIN
  -- A tenant with no clone is the prime itself: our own project, our own key,
  -- nothing to recharge.
  IF _clone_id IS NULL THEN
    RETURN 'no_key';
  END IF;

  SELECT status INTO _status
    FROM public.clone_backend_secrets
   WHERE clone_id = _clone_id AND name = _secret_name;

  IF _status IS NULL THEN
    -- We have no record of lending this clone this key. Record, don't charge.
    RETURN 'unknown_secret';
  END IF;

  RETURN CASE _status
    WHEN 'inherited' THEN 'inherited'   -- piggybacking on ours → billable
    WHEN 'set'       THEN 'byok'        -- their own key → free
    ELSE 'no_key'                       -- 'missing' | 'failed'
  END;
END;
$$;

-- ─── 6. Ingest ───────────────────────────────────────────────────────────────
--
-- One call per reported event. Idempotent on (tenant_id, idempotency_key): a
-- retried batch returns the original rating instead of double-charging.

CREATE OR REPLACE FUNCTION public.record_api_usage_event(
  _tenant_id uuid,
  _clone_id uuid,
  _secret_name text,
  _quantity numeric,
  _idempotency_key text,
  _model text DEFAULT NULL,
  _feature text DEFAULT NULL,
  _call_status text DEFAULT 'success',
  _occurred_at timestamptz DEFAULT now(),
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _rate         public.api_provider_rates%ROWTYPE;
  _existing     public.api_usage_events%ROWTYPE;
  _reason       text;
  _billable     boolean := false;
  _rated        numeric(18,6) := 0;
  _cost         numeric(18,6) := 0;
  _period       date;
  _provider     text;
  _unit         text;
  _currency     text := 'AUD';
  _event_id     uuid;
  _qty          numeric(18,4) := GREATEST(COALESCE(_quantity, 0), 0);
  _when         timestamptz := COALESCE(_occurred_at, now());
BEGIN
  IF _tenant_id IS NULL OR _secret_name IS NULL OR _idempotency_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_required_argument');
  END IF;

  -- Idempotent replay: return what we decided the first time.
  SELECT * INTO _existing
    FROM public.api_usage_events
   WHERE tenant_id = _tenant_id AND idempotency_key = _idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true, 'event_id', _existing.id,
      'billable', _existing.billable, 'billing_reason', _existing.billing_reason,
      'rated_micros', _existing.rated_micros
    );
  END IF;

  -- The billing period this call belongs to. Anchored on the tenant's own
  -- cycle so usage lands on the same invoice as its subscription; tenants
  -- without a cycle fall back to calendar months.
  SELECT COALESCE(t.current_period_start::date, date_trunc('month', _when)::date)
    INTO _period
    FROM public.tenants t WHERE t.id = _tenant_id;
  IF _period IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found');
  END IF;
  -- A call that predates the current cycle belongs to the month it happened in,
  -- not to the open cycle — late-arriving batches must not inflate this period.
  IF _when::date < _period THEN
    _period := date_trunc('month', _when)::date;
  END IF;

  SELECT * INTO _rate
    FROM public.api_provider_rates
   WHERE secret_name = _secret_name AND is_active;

  IF NOT FOUND THEN
    -- An un-catalogued key. Metered so the gap is visible on the dashboard,
    -- charged at nothing until an operator prices it.
    _provider := 'unknown';
    _unit     := 'request';
    _reason   := 'rate_missing';
  ELSE
    _provider := _rate.provider;
    _unit     := _rate.unit;
    _currency := _rate.currency;
    _reason   := public.resolve_api_key_billability(_clone_id, _secret_name);

    IF NOT _rate.is_billable THEN
      _reason := 'not_billable';
    ELSIF _call_status = 'error' THEN
      -- A failed vendor call is metered but never charged. Providers do not
      -- bill us for most 4xx/5xx, and charging for a call that returned the
      -- tenant nothing is indefensible on an invoice.
      _reason := 'error_call';
    END IF;

    IF _reason = 'inherited' THEN
      _billable := true;
      _rated := ROUND(_qty * _rate.resale_micros_per_unit, 6);
    END IF;
    -- Cost is tracked for every call on our key, charged or not, so margin
    -- and error-waste are both visible.
    IF _reason IN ('inherited','error_call','not_billable') THEN
      _cost := ROUND(_qty * _rate.cost_micros_per_unit, 6);
    END IF;
  END IF;

  INSERT INTO public.api_usage_events (
    tenant_id, clone_id, secret_name, provider, unit, quantity, model, feature,
    call_status, billable, billing_reason, rated_micros, cost_micros, currency,
    period_start, occurred_at, idempotency_key, metadata
  ) VALUES (
    _tenant_id, _clone_id, _secret_name, _provider, _unit, _qty, _model, _feature,
    COALESCE(_call_status, 'success'), _billable, _reason, _rated, _cost, _currency,
    _period, _when, _idempotency_key, COALESCE(_metadata, '{}'::jsonb)
  )
  RETURNING id INTO _event_id;

  INSERT INTO public.api_usage_rollups (
    tenant_id, clone_id, period_start, secret_name, provider, unit, currency,
    gross_quantity, billable_quantity, byok_quantity, event_count, error_count,
    gross_charge_micros, cost_micros, first_seen_at, last_seen_at
  ) VALUES (
    _tenant_id, _clone_id, _period, _secret_name, _provider, _unit, _currency,
    _qty,
    CASE WHEN _billable THEN _qty ELSE 0 END,
    CASE WHEN _reason = 'byok' THEN _qty ELSE 0 END,
    1,
    CASE WHEN _call_status = 'error' THEN 1 ELSE 0 END,
    _rated, _cost, _when, _when
  )
  ON CONFLICT (tenant_id, period_start, secret_name) DO UPDATE SET
    gross_quantity      = public.api_usage_rollups.gross_quantity + EXCLUDED.gross_quantity,
    billable_quantity   = public.api_usage_rollups.billable_quantity + EXCLUDED.billable_quantity,
    byok_quantity       = public.api_usage_rollups.byok_quantity + EXCLUDED.byok_quantity,
    event_count         = public.api_usage_rollups.event_count + 1,
    error_count         = public.api_usage_rollups.error_count + EXCLUDED.error_count,
    gross_charge_micros = public.api_usage_rollups.gross_charge_micros + EXCLUDED.gross_charge_micros,
    cost_micros         = public.api_usage_rollups.cost_micros + EXCLUDED.cost_micros,
    clone_id            = COALESCE(public.api_usage_rollups.clone_id, EXCLUDED.clone_id),
    last_seen_at        = GREATEST(public.api_usage_rollups.last_seen_at, EXCLUDED.last_seen_at);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false, 'event_id', _event_id,
    'billable', _billable, 'billing_reason', _reason,
    'rated_micros', _rated, 'period_start', _period
  );
END;
$$;

-- ─── 7. Settlement ───────────────────────────────────────────────────────────
--
-- Freeze one tenant-period into a charge. The free allowance is applied here
-- and only here: it is a per-period concept, so applying it per event would
-- forgive the allowance once per call.

CREATE OR REPLACE FUNCTION public.close_api_usage_period(
  _tenant_id uuid,
  _period_start date
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _charge      public.api_usage_charges%ROWTYPE;
  _row         RECORD;
  _charge_id   uuid;
  _total       numeric(18,6) := 0;
  _cost_total  numeric(18,6) := 0;
  _currency    text := 'AUD';
  _clone_id    uuid;
  _period_end  date;
  _charged_qty numeric(18,4);
  _free        numeric(18,4);
  _line_amount numeric(18,6);
  _lines       integer := 0;
BEGIN
  SELECT * INTO _charge
    FROM public.api_usage_charges
   WHERE tenant_id = _tenant_id AND period_start = _period_start;

  -- Already settled: return it untouched. Cron retries must not re-charge.
  -- Read `_charge.id` rather than `FOUND` from here on — every SELECT INTO
  -- below resets FOUND, and a stale read of it would append a second set of
  -- lines to an existing charge.
  IF _charge.id IS NOT NULL AND _charge.status <> 'open' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_closed', true, 'charge_id', _charge.id,
      'status', _charge.status, 'amount_cents', _charge.amount_cents
    );
  END IF;

  SELECT clone_id INTO _clone_id
    FROM public.api_usage_rollups
   WHERE tenant_id = _tenant_id AND period_start = _period_start
   LIMIT 1;

  -- The tenant's own cycle end, but only when this period IS that cycle.
  -- Reaching for `current_period_end` while closing an older month would stamp
  -- a back-dated charge with today's cycle boundary.
  SELECT CASE
           WHEN t.current_period_start::date = _period_start AND t.current_period_end IS NOT NULL
             THEN t.current_period_end::date
           ELSE (_period_start + interval '1 month')::date
         END
    INTO _period_end
    FROM public.tenants t WHERE t.id = _tenant_id;
  _period_end := COALESCE(_period_end, (_period_start + interval '1 month')::date);

  IF _charge.id IS NOT NULL THEN
    _charge_id := _charge.id;
    DELETE FROM public.api_usage_charge_lines WHERE charge_id = _charge_id;
  ELSE
    INSERT INTO public.api_usage_charges (tenant_id, clone_id, period_start, period_end)
    VALUES (_tenant_id, _clone_id, _period_start, _period_end)
    ON CONFLICT (tenant_id, period_start) DO UPDATE SET clone_id = EXCLUDED.clone_id
    RETURNING id INTO _charge_id;
  END IF;

  FOR _row IN
    SELECT r.secret_name, r.provider, r.unit, r.currency,
           r.billable_quantity, r.byok_quantity, r.cost_micros,
           COALESCE(pr.included_free_units, 0)    AS free_units,
           COALESCE(pr.resale_micros_per_unit, 0) AS rate,
           COALESCE(pr.display_name, r.secret_name) AS display_name
      FROM public.api_usage_rollups r
      LEFT JOIN public.api_provider_rates pr ON pr.secret_name = r.secret_name
     WHERE r.tenant_id = _tenant_id AND r.period_start = _period_start
     ORDER BY r.secret_name
  LOOP
    _cost_total := _cost_total + COALESCE(_row.cost_micros, 0);

    -- Lines with nothing billable still earn a row when the tenant saved on
    -- their own key — that saving is the argument for BYOK and belongs on the
    -- statement.
    _free        := LEAST(_row.free_units, _row.billable_quantity);
    _charged_qty := GREATEST(_row.billable_quantity - _free, 0);
    _line_amount := ROUND(_charged_qty * _row.rate, 6);

    IF _charged_qty > 0 OR _row.byok_quantity > 0 THEN
      INSERT INTO public.api_usage_charge_lines (
        charge_id, secret_name, provider, display_name, unit,
        billable_quantity, free_units_applied, charged_quantity,
        rate_micros_per_unit, amount_micros, byok_quantity
      ) VALUES (
        _charge_id, _row.secret_name, _row.provider, _row.display_name, _row.unit,
        _row.billable_quantity, _free, _charged_qty,
        _row.rate, _line_amount, _row.byok_quantity
      );
      _lines := _lines + 1;
    END IF;

    _total := _total + _line_amount;
    IF _row.currency IS NOT NULL THEN _currency := _row.currency; END IF;
  END LOOP;

  UPDATE public.api_usage_charges
     SET amount_micros = _total,
         -- Micros → cents, once. Round half-up on the total rather than per
         -- line, so a thousand sub-cent calls bill as their sum.
         amount_cents  = FLOOR(_total / 10000 + 0.5)::integer,
         cost_micros   = _cost_total,
         currency      = _currency,
         status        = 'closed',
         closed_at     = now(),
         period_end    = _period_end
   WHERE id = _charge_id;

  RETURN jsonb_build_object(
    'ok', true, 'already_closed', false, 'charge_id', _charge_id,
    'status', 'closed', 'lines', _lines,
    'amount_micros', _total,
    'amount_cents', FLOOR(_total / 10000 + 0.5)::integer,
    'currency', _currency
  );
END;
$$;

-- ─── 8. Read models ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.api_usage_tenant_summary(
  _tenant_id uuid,
  _period_start date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _period date;
  _out jsonb;
BEGIN
  _period := COALESCE(
    _period_start,
    (SELECT COALESCE(current_period_start::date, date_trunc('month', now())::date)
       FROM public.tenants WHERE id = _tenant_id)
  );

  SELECT jsonb_build_object(
    'tenant_id', _tenant_id,
    'period_start', _period,
    'currency', COALESCE(MAX(r.currency), 'AUD'),
    'event_count', COALESCE(SUM(r.event_count), 0),
    'error_count', COALESCE(SUM(r.error_count), 0),
    'billable_micros', COALESCE(SUM(r.gross_charge_micros), 0),
    'cost_micros', COALESCE(SUM(r.cost_micros), 0),
    'providers_used', COUNT(DISTINCT r.provider),
    'byok_secrets', COUNT(*) FILTER (WHERE r.byok_quantity > 0),
    'lines', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'secret_name', r.secret_name,
          'provider', r.provider,
          'display_name', COALESCE(pr.display_name, r.secret_name),
          'unit', r.unit,
          'gross_quantity', r.gross_quantity,
          'billable_quantity', r.billable_quantity,
          'byok_quantity', r.byok_quantity,
          'event_count', r.event_count,
          'error_count', r.error_count,
          'charge_micros', r.gross_charge_micros,
          'cost_micros', r.cost_micros
        ) ORDER BY r.gross_charge_micros DESC, r.secret_name
      ) FILTER (WHERE r.secret_name IS NOT NULL),
      '[]'::jsonb
    )
  ) INTO _out
  FROM public.api_usage_rollups r
  LEFT JOIN public.api_provider_rates pr ON pr.secret_name = r.secret_name
  WHERE r.tenant_id = _tenant_id AND r.period_start = _period;

  RETURN COALESCE(_out, jsonb_build_object(
    'tenant_id', _tenant_id, 'period_start', _period, 'currency', 'AUD',
    'event_count', 0, 'error_count', 0, 'billable_micros', 0, 'cost_micros', 0,
    'providers_used', 0, 'byok_secrets', 0, 'lines', '[]'::jsonb
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.api_usage_fleet_summary(
  _period_start date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _period date := COALESCE(_period_start, date_trunc('month', now())::date);
BEGIN
  RETURN jsonb_build_object(
    'period_start', _period,
    'tenants', COALESCE((
      -- Order on the numeric total, not on the JSON text of it: `'900' > '1080'`
      -- lexicographically, which would put the biggest spender mid-table.
      SELECT jsonb_agg(x ORDER BY sort_key DESC)
      FROM (
        SELECT SUM(r.gross_charge_micros) AS sort_key,
               jsonb_build_object(
                 'tenant_id', r.tenant_id,
                 'clone_id', r.clone_id,
                 'tenant_name', COALESCE(t.display_name, t.external_ref),
                 'clone_name', c.name,
                 'currency', MAX(r.currency),
                 'event_count', SUM(r.event_count),
                 'error_count', SUM(r.error_count),
                 'charge_micros', SUM(r.gross_charge_micros),
                 'cost_micros', SUM(r.cost_micros),
                 'byok_quantity', SUM(r.byok_quantity),
                 'providers', COUNT(DISTINCT r.provider)
               ) AS x
          FROM public.api_usage_rollups r
          JOIN public.tenants t ON t.id = r.tenant_id
          LEFT JOIN public.clones c ON c.id = r.clone_id
         WHERE r.period_start = _period
         GROUP BY r.tenant_id, r.clone_id, t.display_name, t.external_ref, c.name
      ) s
    ), '[]'::jsonb),
    'providers', COALESCE((
      SELECT jsonb_agg(x ORDER BY sort_key DESC)
      FROM (
        SELECT SUM(r.gross_charge_micros) AS sort_key,
               jsonb_build_object(
                 'provider', r.provider,
                 'secret_name', r.secret_name,
                 'unit', r.unit,
                 'gross_quantity', SUM(r.gross_quantity),
                 'billable_quantity', SUM(r.billable_quantity),
                 'byok_quantity', SUM(r.byok_quantity),
                 'charge_micros', SUM(r.gross_charge_micros),
                 'cost_micros', SUM(r.cost_micros),
                 'tenant_count', COUNT(DISTINCT r.tenant_id)
               ) AS x
          FROM public.api_usage_rollups r
         WHERE r.period_start = _period
         GROUP BY r.provider, r.secret_name, r.unit
      ) s
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_api_usage_event(uuid, uuid, text, numeric, text, text, text, text, timestamptz, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.close_api_usage_period(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.record_api_usage_event(uuid, uuid, text, numeric, text, text, text, text, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_api_usage_period(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_api_key_billability(uuid, text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.api_usage_tenant_summary(uuid, date) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.api_usage_fleet_summary(date) TO service_role, authenticated;

-- ─── 9. Seed: every metered key the prime's edge functions actually read ─────
--
-- Taken from a scan of all 412 functions in npc-property-dashbord for
-- `Deno.env.get("…")`. Config values, feature flags, our own internal HMACs and
-- the Supabase-injected names are deliberately absent — they cost nothing and
-- charging for them would be indefensible. Rates are opening positions for an
-- operator to tune in Billing → API Usage, not fixed prices: `cost` is roughly
-- what the vendor charges us, `resale` carries the platform margin.
--
-- Token-priced models are rated on a blended per-token figure rather than
-- split input/output, because the prime reports one total. Where the split
-- matters, the reporter sends prompt/completion in metadata for later repricing.

INSERT INTO public.api_provider_rates
  (secret_name, provider, display_name, category, unit,
   cost_micros_per_unit, resale_micros_per_unit, included_free_units, is_billable, notes)
VALUES
  -- ── AI / LLM (per token) ──
  ('LOVABLE_API_KEY','lovable','Lovable AI Gateway','ai','token',
   0.30, 0.60, 100000, true, 'Gateway in front of Gemini/GPT. 35 call sites — the prime''s busiest key.'),
  ('OPENAI_API_KEY','openai','OpenAI','ai','token',
   0.90, 1.80, 0, true, 'Chat completions, embeddings and Whisper transcription.'),
  ('ANTHROPIC_API_KEY','anthropic','Anthropic','ai','token',
   1.20, 2.40, 0, true, 'Investment report section generation and document reconstruction.'),
  ('PERPLEXITY_API_KEY','perplexity','Perplexity','ai','token',
   1.50, 3.00, 0, true, 'Market intelligence research with citations.'),
  ('OPENROUTER_API_KEY','openrouter','OpenRouter','ai','token',
   1.00, 2.00, 0, true, 'Fallback model routing.'),
  ('GEMINI_API_KEY','google-gemini','Google Gemini','ai','token',
   0.30, 0.60, 0, true, 'Direct Gemini access outside the Lovable gateway.'),
  ('GOOGLE_API_KEY','google-ai','Google AI','ai','token',
   0.30, 0.60, 0, true, 'Generative Language API.'),

  -- ── Email ──
  ('RESEND_API_KEY','resend','Resend','email','email',
   400, 900, 100, true, 'Transactional and scheduled email. 17 call sites.'),
  ('MICROSOFT_CLIENT_SECRET','microsoft-graph','Microsoft Graph','email','request',
   0, 200, 1000, true, 'Outlook mailbox sync and send-as. Licence cost is per-seat, not per-call.'),

  -- ── Property data ──
  ('DOMAIN_API_KEY','domain','Domain.com.au','data','lookup',
   12000, 25000, 0, true, 'Listing and comparable-sales lookups. Metered hard by the vendor.'),
  ('COTALITY_API_KEY','cotality','Cotality (CoreLogic)','data','lookup',
   45000, 90000, 0, true, 'Valuation and property attribute data — the most expensive per call.'),
  ('AIRTABLE_TOKEN','airtable','Airtable','data','request',
   0, 50, 5000, true, 'Property Intake Master reads/writes. Rate-limited, not per-call priced.'),
  ('FIRECRAWL_API_KEY','firecrawl','Firecrawl','data','page',
   1500, 3200, 20, true, 'Listing and market-source scraping. Priced per page crawled.'),

  -- ── Maps ──
  ('GOOGLE_MAPS_API_KEY','google-maps','Google Maps Platform','maps','request',
   7000, 14000, 200, true, 'Geocoding, Places and Street View. Daily caps are set per-deployment.'),

  -- ── Voice ──
  ('VAPI_API_KEY','vapi','Vapi','voice','minute',
   90000, 180000, 0, true, 'Outbound/inbound voice agent, priced per call minute.'),

  -- ── Documents / rendering ──
  ('GAMMA_API_KEY','gamma','Gamma','documents','document',
   50000, 110000, 0, true, 'Generated presentation decks.'),
  ('API2PDF_API_KEY','api2pdf','API2PDF','render','render',
   1500, 3500, 25, true, 'Fallback PDF rendering.'),
  ('WEASYPRINT_SERVICE_TOKEN','weasyprint','WeasyPrint render service','render','render',
   800, 2000, 250, true, 'Our own Cloud Run container — the cost is compute, and it is real.'),
  ('PDF_PARSE_SERVICE_TOKEN','pdf-parse','PDF parse service','render','document',
   900, 2200, 100, true, 'Sidecar document extraction service.'),
  ('DOCUSIGN_INTEGRATION_KEY','docusign','DocuSign','documents','document',
   150000, 300000, 0, true, 'Envelope sends. Priced per envelope by the vendor.'),

  -- ── Compliance ──
  ('AML_VERIFICATION_SERVICE_TOKEN','aml','AML verification service','compliance','verification',
   250000, 500000, 0, true, 'Identity and sanctions screening — charged per verification.'),

  -- ── CRM / marketing ──
  ('GOHIGHLEVEL_API_KEY','gohighlevel','GoHighLevel','crm','request',
   0, 40, 2000, true, 'CRM sync. Seat-priced by the vendor; the charge here covers our relay.'),
  ('GOHIGHLEVEL_API_KEY_NEW','gohighlevel','GoHighLevel (new location)','crm','request',
   0, 40, 2000, true, 'Second GHL location credential.'),
  ('MANYCHAT_API_KEY','manychat','ManyChat','marketing','message',
   0, 60, 500, true, 'Conversational messaging relay.'),
  ('META_ADS_ACCESS_TOKEN','meta-ads','Meta Ads','marketing','request',
   0, 30, 2000, true, 'Ad insights pulls. Ad spend itself is never billed through here.'),

  -- ── Infra: forwarded, metered, not recharged ──
  ('TURNSTILE_SECRET_KEY','cloudflare','Cloudflare Turnstile','infra','request',
   0, 0, 0, false, 'Free tier. Metered for abuse detection only.'),
  ('CLOUDFLARE_API_TOKEN','cloudflare','Cloudflare API','infra','request',
   0, 0, 0, false, 'Zone/DNS management on our account — platform overhead, not tenant usage.'),
  ('FIGMA_TOKEN','figma','Figma','infra','request',
   0, 0, 0, false, 'Design token sync. Seat-priced, never per-tenant.'),
  ('MCP_ACCESS_TOKEN','mcp','MCP server','infra','request',
   0, 0, 0, false, 'Internal tooling bridge.')
ON CONFLICT (secret_name) DO NOTHING;

-- Anything in this catalog that a clone can piggyback on must also be
-- forwardable, otherwise the clone gets an empty shell and the meter never
-- sees a call. Seed the forwarding whitelist for the metered vendor keys that
-- are safe to share, leaving the ones that must stay per-tenant alone.
INSERT INTO public.prime_secret_forwards (name, inherit, description)
SELECT r.secret_name, true,
       'Metered vendor key — usage recharged per tenant (' || r.display_name || ')'
  FROM public.api_provider_rates r
 WHERE r.is_billable
   AND r.secret_name NOT IN (
     -- Per-tenant by nature: a shared credential here would cross-contaminate
     -- mailboxes, CRM locations and signing identities between agencies.
     'MICROSOFT_CLIENT_SECRET','GOHIGHLEVEL_API_KEY','GOHIGHLEVEL_API_KEY_NEW',
     'DOCUSIGN_INTEGRATION_KEY','META_ADS_ACCESS_TOKEN','MANYCHAT_API_KEY',
     'AIRTABLE_TOKEN'
   )
ON CONFLICT (name) DO NOTHING;

-- ─── 10. Retention ───────────────────────────────────────────────────────────
--
-- Rollups and charges are the billing record and are kept indefinitely. Raw
-- events are the supporting detail — 400 days covers any plausible dispute
-- window plus a full year-on-year comparison, then they go.

CREATE OR REPLACE FUNCTION public.purge_api_usage_events()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _deleted integer;
BEGIN
  DELETE FROM public.api_usage_events WHERE created_at < now() - interval '400 days';
  GET DIAGNOSTICS _deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', _deleted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_api_usage_events() TO service_role;
