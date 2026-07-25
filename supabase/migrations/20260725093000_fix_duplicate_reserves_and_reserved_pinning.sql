-- Fix duplicated token charges + reserved-token pinning for NULL-clone installs.
--
-- Two defects, one root cause: SQL NULL comparison semantics around
-- report_jobs.clone_id (NULL for the prime install's API key since
-- 20260518143534 dropped NOT NULL).
--
--   1. reserve_tokens' idempotency lookup used `clone_id = _clone_id`, which
--      never matches when _clone_id is NULL, and the UNIQUE (clone_id,
--      idempotency_key) constraint treats NULLs as distinct so it never
--      protected those rows either. Every reserve call from the prime clone
--      therefore created a NEW job and every commit debited AGAIN — chunked
--      report generation (one edge call per section) charged per chunk
--      instead of once per report, silently draining the balance.
--   2. recompute_token_balance derived `reserved` from the raw ledger sum.
--      Reservations orphaned by crashed / timed-out generators (never
--      committed or canceled — no sweeper runs) pin `reserved` forever and
--      clamp `available` to 0, swallowing operator gifts exactly like the
--      2026-07-14 incident.
--
-- Repair + hardening, in order:
--   a. Refund duplicate completed jobs (same idempotency_key, clone_id NULL),
--      keeping the earliest charge per key.
--   b. Cancel expired 'reserved' jobs (releases their reservations).
--   c. Cancel later duplicates among still-live reservations so the new
--      unique index can be created.
--   d. Replace the NULL-blind uniqueness rule with a partial NULLS NOT
--      DISTINCT unique index over live jobs (reserved/completed) — canceled
--      or refunded jobs never block a legitimate retry from re-reserving the
--      same key.
--   e. reserve_tokens: NULL-safe idempotency lookup that only reuses live
--      jobs (a canceled reservation must not make every later run free).
--   f. recompute_token_balance: derive `reserved` from live, unexpired
--      report_jobs so orphaned reservations self-heal instead of pinning
--      available at 0.
--   g. Recompute every tenant's cached balance.

-- ── a. Refund duplicate completed NULL-clone jobs ────────────────────────────
DO $$
DECLARE _dup RECORD;
BEGIN
  FOR _dup IN
    SELECT id, tenant_id, kind, charged_tokens
    FROM (
      SELECT j.id, j.tenant_id, j.kind, j.charged_tokens,
             ROW_NUMBER() OVER (
               PARTITION BY j.idempotency_key
               ORDER BY j.created_at, j.id
             ) AS rn
      FROM public.report_jobs j
      WHERE j.clone_id IS NULL AND j.status = 'completed'
    ) t
    WHERE t.rn > 1
  LOOP
    IF COALESCE(_dup.charged_tokens, 0) > 0 THEN
      INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
      VALUES (_dup.tenant_id, 'refund', _dup.charged_tokens, 'manual', _dup.kind, _dup.id,
              'duplicate_reservation_repair');
    END IF;
    UPDATE public.report_jobs
       SET status = 'refunded', completed_at = COALESCE(completed_at, now())
     WHERE id = _dup.id;
  END LOOP;
END;
$$;

-- ── b. Sweep expired reservations that were never committed or canceled ─────
DO $$
DECLARE _j UUID;
BEGIN
  FOR _j IN
    SELECT id FROM public.report_jobs
    WHERE status = 'reserved'
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at < now()
  LOOP
    PERFORM public.cancel_token_reservation(_j, 'stale_reservation_sweep');
  END LOOP;
END;
$$;

-- ── c. Cancel later duplicates among still-live jobs ────────────────────────
-- Window prefers a completed job as the canonical row for its key, so only
-- redundant live reservations are canceled.
DO $$
DECLARE _j RECORD;
BEGIN
  FOR _j IN
    SELECT id, status
    FROM (
      SELECT j.id, j.status,
             ROW_NUMBER() OVER (
               PARTITION BY j.clone_id, j.idempotency_key
               ORDER BY (j.status = 'completed') DESC, j.created_at, j.id
             ) AS rn
      FROM public.report_jobs j
      WHERE j.status IN ('reserved', 'completed')
    ) t
    WHERE t.rn > 1
  LOOP
    IF _j.status = 'reserved' THEN
      PERFORM public.cancel_token_reservation(_j.id, 'duplicate_reservation_repair');
    END IF;
  END LOOP;
END;
$$;

-- ── d. NULL-safe uniqueness over live jobs only ──────────────────────────────
ALTER TABLE public.report_jobs
  DROP CONSTRAINT IF EXISTS report_jobs_clone_id_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS report_jobs_live_idem_uidx
  ON public.report_jobs (clone_id, idempotency_key) NULLS NOT DISTINCT
  WHERE status IN ('reserved', 'completed');

-- ── e. reserve_tokens: NULL-safe, live-job-only idempotency ──────────────────
CREATE OR REPLACE FUNCTION public.reserve_tokens(
  _tenant_id UUID, _clone_id UUID, _kind TEXT, _estimated_tokens INTEGER,
  _idempotency_key TEXT, _ttl_seconds INTEGER DEFAULT 600,
  _request_payload JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _existing public.report_jobs%ROWTYPE;
  _job_id UUID;
  _available INTEGER;
  _plan_overage public.overage_policy;
  _exempt BOOLEAN;
BEGIN
  IF _estimated_tokens IS NULL OR _estimated_tokens < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_estimate');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_tenant_id::text, 0));
  -- IS NOT DISTINCT FROM: the prime install's key carries clone_id NULL and
  -- `clone_id = NULL` never matches, which is what allowed duplicate charges.
  -- Only live jobs count — a canceled reservation must not turn every retry
  -- of the same key into a free (or phantom) run.
  SELECT * INTO _existing FROM public.report_jobs
   WHERE clone_id IS NOT DISTINCT FROM _clone_id
     AND idempotency_key = _idempotency_key
     AND status IN ('reserved', 'completed')
   ORDER BY (status = 'completed') DESC, created_at, id
   LIMIT 1;
  IF FOUND THEN
    SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _existing.tenant_id;
    RETURN jsonb_build_object('ok', true, 'job_id', _existing.id,
      'reserved_tokens', _existing.estimated_tokens,
      'available_after', COALESCE(_available, 0),
      'idempotent', true, 'status', _existing.status);
  END IF;
  PERFORM public.recompute_token_balance(_tenant_id);
  SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _tenant_id;
  _available := COALESCE(_available, 0);
  SELECT bp.overage_policy, t.billing_exempt INTO _plan_overage, _exempt
    FROM public.tenants t LEFT JOIN public.billing_plans bp ON bp.id = t.plan_id
   WHERE t.id = _tenant_id;
  -- Billing-exempt tenants (the prime install) are never funds-gated; every
  -- other tenant keeps the existing plan/overage enforcement.
  IF NOT COALESCE(_exempt, false) THEN
    _plan_overage := COALESCE(_plan_overage, 'block');
    IF _available < _estimated_tokens AND _plan_overage = 'block' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'insufficient_funds',
        'available', _available, 'required', _estimated_tokens);
    END IF;
  END IF;
  INSERT INTO public.report_jobs (
    tenant_id, clone_id, kind, status, estimated_tokens,
    idempotency_key, request_payload, reservation_expires_at
  ) VALUES (
    _tenant_id, _clone_id, _kind, 'reserved', _estimated_tokens,
    _idempotency_key, _request_payload, now() + make_interval(secs => _ttl_seconds)
  ) RETURNING id INTO _job_id;
  INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
  VALUES (_tenant_id, 'reserve', _estimated_tokens, 'report', _kind, _job_id, 'reservation');
  SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _tenant_id;
  RETURN jsonb_build_object('ok', true, 'job_id', _job_id,
    'reserved_tokens', _estimated_tokens, 'available_after', COALESCE(_available, 0));
END;
$$;

-- ── f. recompute_token_balance: reserved from live jobs, not the raw ledger ──
-- Keeps the chronological zero-clamped replay from 20260714171500 for
-- available/lifetime figures; only the `reserved` derivation changes so that
-- expired or orphaned reservations stop pinning `available` at 0.
CREATE OR REPLACE FUNCTION public.recompute_token_balance(_tenant_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row RECORD;
  _running BIGINT := 0;
  _reserved BIGINT;
  _granted BIGINT := 0;
  _spent BIGINT := 0;
BEGIN
  -- Replay credits/debits in order, clamping at zero. A debit taken while the
  -- balance is empty (permitted under non-'block' overage policies) is not
  -- carried forward as debt against future grants.
  FOR _row IN
    SELECT kind, tokens
    FROM public.token_ledger
    WHERE tenant_id = _tenant_id
      AND (expires_at IS NULL OR expires_at > now())
      AND kind IN ('grant', 'topup', 'refund', 'adjustment', 'debit', 'expiry')
    ORDER BY created_at, id
  LOOP
    IF _row.kind IN ('grant', 'topup', 'refund', 'adjustment') THEN
      _running := GREATEST(0, _running + _row.tokens);
      IF _row.kind IN ('grant', 'topup') THEN
        _granted := _granted + _row.tokens;
      END IF;
    ELSE -- debit / expiry
      _running := GREATEST(0, _running - ABS(_row.tokens));
      IF _row.kind = 'debit' THEN
        _spent := _spent + ABS(_row.tokens);
      END IF;
    END IF;
  END LOOP;

  -- Reserved = live, unexpired reservations only. Orphans (crashed generators
  -- that never committed/canceled) age out with their TTL instead of pinning
  -- `available` at 0 forever and swallowing gifts.
  SELECT COALESCE(SUM(estimated_tokens), 0) INTO _reserved
  FROM public.report_jobs
  WHERE tenant_id = _tenant_id
    AND status = 'reserved'
    AND (reservation_expires_at IS NULL OR reservation_expires_at > now());
  _reserved := GREATEST(0, LEAST(_reserved, 2147483647));

  INSERT INTO public.token_balances (tenant_id, available, reserved, lifetime_granted, lifetime_spent, updated_at)
  VALUES (
    _tenant_id,
    GREATEST(0, LEAST(_running - _reserved, 2147483647))::int,
    _reserved::int,
    LEAST(_granted, 2147483647)::int,
    LEAST(_spent, 2147483647)::int,
    now()
  )
  ON CONFLICT (tenant_id) DO UPDATE
    SET available = EXCLUDED.available,
        reserved = EXCLUDED.reserved,
        lifetime_granted = EXCLUDED.lifetime_granted,
        lifetime_spent = EXCLUDED.lifetime_spent,
        updated_at = now();
END;
$$;

-- ── g. Recompute every tenant's cached balance against the repaired state ───
DO $$
DECLARE _t UUID;
BEGIN
  FOR _t IN
    SELECT id FROM public.tenants
  LOOP
    PERFORM public.recompute_token_balance(_t);
  END LOOP;
END;
$$;
