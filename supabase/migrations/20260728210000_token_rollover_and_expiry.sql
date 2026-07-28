-- 30-day token expiry, with rollover.
--
-- Rule: credits live 30 days from the moment they are issued. Plan allowances,
-- top-up packs and operator gifts all obey it. Only a gift may override, via
-- the expiry date `grant_tokens` already accepts — a blank date now means "30
-- days", not "never".
--
-- Rollover falls out of that: nothing is wiped at a period boundary, so unused
-- credits carry across it and simply expire on their own clock. `rollover_cap`
-- stays unused.
--
-- ── Why the balance function had to change ─────────────────────────────────
-- The old recompute replayed the ledger and skipped credit rows whose
-- expires_at had passed. With no expiring credits that was fine. With them it
-- silently under-counts, because the DEBITS taken against an expired credit
-- stay in the replay while the credit that funded them disappears:
--
--     grant  +100 (expired)      → skipped
--     topup   +50 (live)         → +50
--     debit   -30 (spent from the grant)  → -30
--     ⇒ 20, when the honest answer is 50: the 30 was already paid for by the
--       grant, and only the grant's unspent 70 should have been forfeited.
--
-- So credits are now LOTS. Spend consumes them soonest-expiry-first — the
-- use-it-or-lose-it order, which is also the order that is best for the
-- customer — and expiry only ever forfeits a lot's UNCONSUMED remainder.
--
-- The consumption order is by expiry rather than strictly chronological. That
-- is a deliberate simplification: it keeps this as one set-based query instead
-- of a row-by-row replay, and it can only differ from a time-ordered replay
-- when a debit predates the credit it is attributed to — which cannot happen
-- here, because `reserve_tokens` refuses to spend a balance that does not yet
-- exist.

-- ── 1. The policy, in one place ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.token_expiry_days()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT 30
$$;

COMMENT ON FUNCTION public.token_expiry_days() IS
  'Platform token lifetime in days. Change here and every issuance path follows.';

-- ── 2. Lot-based balance ────────────────────────────────────────────────────
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
  -- Lifetime figures are simple sums; they describe history, not what is
  -- spendable, so expiry does not enter into them.
  SELECT
    COALESCE(SUM(tokens) FILTER (WHERE kind IN ('grant', 'topup')), 0),
    COALESCE(SUM(ABS(tokens)) FILTER (WHERE kind = 'debit'), 0)
  INTO _granted, _spent
  FROM public.token_ledger
  WHERE tenant_id = _tenant_id;

  -- Spendable = the unconsumed remainder of every lot that has not expired.
  --
  -- `cum_after` is the running total of credit in soonest-expiry-first order,
  -- so comparing it against total spend tells us how much of each lot survived:
  -- fully consumed when the running total is still below total spend, partially
  -- consumed at the crossover, untouched after it.
  --
  -- 'expiry' rows are deliberately NOT counted as spend. Expiry is derived from
  -- the lots themselves; counting an explicit row too would forfeit the same
  -- credit twice. (Nothing has ever written one — the kind exists in the enum
  -- but has no producer.)
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

  -- Reserved = live, unexpired reservations only (kept from 20260725093000):
  -- orphans from crashed generators age out with their TTL instead of pinning
  -- `available` at 0 forever.
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

-- ── 3. Gifts: 30 days unless the operator names a date ──────────────────────
CREATE OR REPLACE FUNCTION public.grant_tokens(
  _tenant_id UUID, _tokens INTEGER, _reason TEXT, _expires_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _expires TIMESTAMPTZ;
BEGIN
  IF _tokens IS NULL OR _tokens <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  -- The one overridable path. A blank date is the default (30 days), an
  -- explicit date is the operator's deliberate choice — including a far-future
  -- one for a gift that should effectively never lapse.
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

-- ── 4. Top-ups: 30 days, or sooner if the pack says so ──────────────────────
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

  -- 30 days is a ceiling, not a fixed term: a pack that deliberately expires
  -- sooner keeps its shorter window. A pack with no expiry set now gets 30
  -- days rather than lasting forever.
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

-- ── 5. Plan allowances become real credits ──────────────────────────────────
-- Until now `monthly_allowance` was only ever a number on a page: nothing
-- credited it, so a paid tier granted no spendable tokens at all. It is issued
-- here, once per tenant per period, with the same 30-day life as everything
-- else.
--
-- Idempotent on (tenant, period) via source_ref, so re-running the driver — or
-- two workers racing — credits once.
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

/**
 * Driver for the cron. Issues to every active tenant whose current period has
 * not yet been credited.
 *
 * NOTE: this does not back-fill. Only periods that START from here on are
 * issued, so deploying this does not hand every existing tenant a windfall for
 * a month they have already been using.
 */
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
       -- Only periods that began after this feature shipped.
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

-- ── 6. What expires, and when ───────────────────────────────────────────────
-- Powers the "N credits expire in X days" warning. Returns the surviving
-- remainder of each unexpired lot, soonest first — the same lot arithmetic the
-- balance uses, so the two can never disagree.
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

-- ── 7. Existing credits keep their current terms ────────────────────────────
-- Credits already on the ledger have no expires_at and are deliberately left
-- that way: nobody loses a balance they were told they had. The rule applies
-- from here forward. To apply it retroactively, set expires_at on the existing
-- rows in a follow-up — that is a commercial decision, not a migration.

-- Recompute every tenant under the new lot arithmetic. For any tenant with no
-- expiring credits this is a no-op; it exists so the cached balances are
-- consistent with the new function from the moment it ships.
DO $$
DECLARE _t UUID;
BEGIN
  FOR _t IN SELECT id FROM public.tenants LOOP
    PERFORM public.recompute_token_balance(_t);
  END LOOP;
END;
$$;

-- ── 8. Schedule the allowance issuance ──────────────────────────────────────
-- Hourly rather than daily: tenants roll over on their own anniversary, so a
-- once-a-day pass would leave someone up to 24 hours short of the allowance
-- they just paid for. Both functions are idempotent per (tenant, period), so
-- running 24 times a day credits exactly once.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('token-plan-allowances')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'token-plan-allowances');
    PERFORM cron.schedule(
      'token-plan-allowances', '7 * * * *',
      'SELECT public.issue_due_plan_allowances()'
    );
  ELSE
    RAISE NOTICE 'pg_cron not installed — call public.issue_due_plan_allowances() from your scheduler.';
  END IF;
END $$;

-- Expiry itself needs no sweeper: `recompute_token_balance` derives it from the
-- lots every time it runs, and the ledger trigger runs it on every credit or
-- debit. A tenant that goes completely idle keeps a stale cached number until
-- their next activity — `refresh_token_balance` (20260728093000) is what the
-- balance read path already calls to repair exactly that.
