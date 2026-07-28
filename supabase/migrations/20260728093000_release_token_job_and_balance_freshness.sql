-- Make a failed report cost the tenant nothing — end to end.
--
-- Three defects, all of which leave credits consumed (or merely *looking*
-- consumed) after a report generation that never produced a report:
--
--   1. `cancel_token_reservation` is a no-op on a job that already reached
--      'completed'. Clone-side chunked generation calls its edge function once
--      per report section, and every intermediate call returned HTTP 200 — so
--      the reservation was committed after section 1 and a failure in any later
--      section could no longer be canceled. `refund_job` exists but is operator
--      -only (no public endpoint), so those charges were never reversed. This
--      adds `release_token_job`: one idempotent entry point that cancels a live
--      reservation OR refunds an already-committed job, whichever applies.
--
--   2. `commit_tokens` and `cancel_token_reservation` write their ledger rows
--      BEFORE flipping `report_jobs.status`. Since 20260725093000 derived
--      `reserved` from live jobs, the AFTER-INSERT recompute trigger therefore
--      ran while the job was still 'reserved' and re-pinned the reservation
--      into the cached balance; nothing recomputed afterwards. The tenant's
--      `available` stayed depressed by the full estimate until the next
--      reserve call happened to refresh it — indistinguishable, from the
--      dashboard, from having been charged. Both now flip status first and
--      recompute explicitly at the end.
--
--   3. Nothing refreshes the cached balance when an orphaned reservation ages
--      past its TTL (an abandoned run, a closed tab). `refresh_token_balance`
--      lets the read path repair a stale cache cheaply.
--
-- Finally the tenant balances are recomputed once so any balance currently
-- carrying a stale reservation from defect 2 is corrected on deploy.

-- ── 1. commit_tokens: flip status before the ledger writes, then recompute ───
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

  -- Status first: the ledger AFTER-INSERT trigger recomputes `reserved` from
  -- live jobs, so writing the release row while this job was still 'reserved'
  -- put the reservation straight back into the cached balance.
  UPDATE public.report_jobs
     SET status = 'completed',
         charged_tokens = _actual_tokens,
         result_meta = _result_meta,
         completed_at = now(),
         reservation_expires_at = NULL
   WHERE id = _job_id;

  -- Release reservation
  INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
  VALUES (_job.tenant_id, 'release', _job.estimated_tokens, 'report', _job.kind, _job.id, 'commit_release');

  -- Debit actual
  IF _actual_tokens > 0 THEN
    INSERT INTO public.token_ledger (tenant_id, kind, tokens, source, source_ref, report_job_id, reason)
    VALUES (_job.tenant_id, 'debit', _actual_tokens, 'report', _job.kind, _job.id, 'commit_debit');
  END IF;

  PERFORM public.recompute_token_balance(_job.tenant_id);
  SELECT available INTO _available FROM public.token_balances WHERE tenant_id = _job.tenant_id;
  RETURN jsonb_build_object('ok', true, 'charged_tokens', _actual_tokens, 'available_after', COALESCE(_available, 0));
END;
$$;

-- ── 2. cancel_token_reservation: same ordering fix ───────────────────────────
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

-- ── 3. refund_job: recompute after the status flip ───────────────────────────
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

-- ── 4. release_token_job: cancel-or-refund, idempotent ───────────────────────
-- The clone calls this on ANY generation failure. It must be safe to call
-- repeatedly (chunk retries, a client-side give-up landing after the server
-- already released) and must never double-refund.
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

  -- Serialize against concurrent reserves for the same tenant, matching
  -- reserve_tokens' locking so a release and a reserve cannot interleave
  -- between the status flip and the recompute.
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
    -- An earlier call in the same run already committed this job. The run has
    -- since failed, so reverse the debit.
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
    -- Already canceled / refunded / failed. Idempotent no-op.
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

-- ── 5. refresh_token_balance: cheap staleness repair for the read path ───────
-- Reservations orphaned by an abandoned run stop counting once they expire,
-- but nothing rewrites the cache until the next ledger insert. Without this a
-- tenant can stare at a depressed `available` long after the credits are free.
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

-- ── 6. Grants — same posture as the sibling RPCs ─────────────────────────────
REVOKE EXECUTE ON FUNCTION public.release_token_job(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.refresh_token_balance(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_token_job(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_token_balance(UUID, INTEGER) TO authenticated, service_role;

-- ── 7. Repair balances left stale by the old commit/cancel ordering ──────────
DO $$
DECLARE _t UUID;
BEGIN
  FOR _t IN SELECT id FROM public.tenants LOOP
    PERFORM public.recompute_token_balance(_t);
  END LOOP;
END;
$$;
