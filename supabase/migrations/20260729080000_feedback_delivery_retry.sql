-- Make delivery to Make.com survive Make.com being down.
--
-- `feedback_submissions` already carries `forward_attempts`, and already has a
-- partial index whose comment reads "over exactly the rows a retry sweep looks
-- for". There is no retry sweep. So today the sequence is:
--
--   submit → credits granted → POST to Make fails → forward_error recorded → …
--
-- and nothing ever tries again. The customer has their credits and the answer
-- is safe in Postgres, which is the important half and was designed for. But
-- the row never reaches Airtable, and the only way anyone finds out is by
-- noticing a number on an operator screen. A ten-minute Make outage silently
-- costs us every response given during it.
--
-- This adds the missing half: a due time per submission, exponential backoff on
-- failure, and a function that hands the sweep exactly the rows that are ready.

-- ── 1. When may this row next be tried? ──────────────────────────────────────
-- A column rather than arithmetic over created_at + attempts at query time, so
-- the partial index below can be ordered by it and the sweep stays a range
-- scan no matter how many undelivered rows accumulate.
ALTER TABLE public.feedback_submissions
  ADD COLUMN IF NOT EXISTS next_forward_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The old index was on created_at, which is not what the sweep orders by.
DROP INDEX IF EXISTS public.idx_feedback_unforwarded;
CREATE INDEX IF NOT EXISTS idx_feedback_unforwarded
  ON public.feedback_submissions(next_forward_at)
  WHERE forwarded_at IS NULL;

-- ── 2. How long to wait, and when to stop ───────────────────────────────────
-- Doubling from one minute, capped at six hours. The cap matters more than the
-- curve: without it the twentieth retry would be scheduled years out, which is
-- indistinguishable from giving up while still looking like it is trying.
CREATE OR REPLACE FUNCTION public.feedback_forward_backoff(_attempts INT)
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(
    INTERVAL '6 hours',
    INTERVAL '1 minute' * power(2, LEAST(GREATEST(_attempts, 0), 20))
  )
$$;

-- Twenty attempts under that curve spans about three days (roughly 8½ hours of
-- doubling, then eleven six-hourly tries), which is longer than any outage we
-- would still be calling an outage. Past that the row stops
-- being retried and stays visible as undelivered rather than churning forever:
-- a submission that has failed twenty times is not failing for a reason that a
-- twenty-first attempt fixes, and it should be looked at by a person.
CREATE OR REPLACE FUNCTION public.feedback_forward_max_attempts()
RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;

-- ── 3. Record the outcome, and schedule the next go ─────────────────────────
-- Replaces the previous version, which incremented attempts and nothing else.
CREATE OR REPLACE FUNCTION public.mark_feedback_forwarded(
  _submission_id UUID,
  _ok BOOLEAN,
  _error TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.feedback_submissions
     SET forwarded_at     = CASE WHEN _ok THEN now() ELSE forwarded_at END,
         forward_error    = CASE WHEN _ok THEN NULL ELSE left(_error, 500) END,
         forward_attempts = forward_attempts + 1,
         -- On success this is inert: the partial index and every query below
         -- filter on forwarded_at IS NULL, so a delivered row is never a
         -- candidate again whatever this says.
         next_forward_at  = CASE
           WHEN _ok THEN next_forward_at
           ELSE now() + public.feedback_forward_backoff(forward_attempts + 1)
         END
   WHERE id = _submission_id
$$;

-- ── 4. What the sweep should pick up ────────────────────────────────────────
-- Returns identifiers only. The payload is rebuilt by the server from the same
-- code path that built it the first time, so a replay cannot drift into a
-- different shape than the original attempt — which is the whole point of a
-- replay and the easiest thing to get wrong by storing a rendered copy here.
CREATE OR REPLACE FUNCTION public.feedback_pending_forward(_limit INT DEFAULT 25)
RETURNS TABLE (submission_id UUID, attempts SMALLINT, last_error TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, forward_attempts, forward_error
    FROM public.feedback_submissions
   WHERE forwarded_at IS NULL
     AND next_forward_at <= now()
     AND forward_attempts < public.feedback_forward_max_attempts()
   ORDER BY next_forward_at ASC
   LIMIT GREATEST(LEAST(COALESCE(_limit, 25), 200), 1)
$$;

-- Operator-facing: how healthy is delivery right now. Cheap enough to put on a
-- screen that refreshes, and answers the question the count of undelivered rows
-- cannot — whether the backlog is being worked through or is stuck.
CREATE OR REPLACE FUNCTION public.feedback_delivery_health()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'delivered',   count(*) FILTER (WHERE forwarded_at IS NOT NULL),
    'pending',     count(*) FILTER (WHERE forwarded_at IS NULL),
    'due_now',     count(*) FILTER (
                     WHERE forwarded_at IS NULL
                       AND next_forward_at <= now()
                       AND forward_attempts < public.feedback_forward_max_attempts()),
    'exhausted',   count(*) FILTER (
                     WHERE forwarded_at IS NULL
                       AND forward_attempts >= public.feedback_forward_max_attempts()),
    'oldest_pending', min(created_at) FILTER (WHERE forwarded_at IS NULL)
  )
  FROM public.feedback_submissions
$$;

-- Deliberately operator-invocable: when Make has been fixed, waiting out a
-- six-hour backoff to confirm it is absurd. Clears the clock, not the history —
-- forward_attempts stays, so a row that has been rescued repeatedly still says
-- so.
CREATE OR REPLACE FUNCTION public.feedback_retry_now(_submission_id UUID DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _n INT;
BEGIN
  UPDATE public.feedback_submissions
     SET next_forward_at = now(),
         forward_attempts = 0
   WHERE forwarded_at IS NULL
     AND (_submission_id IS NULL OR id = _submission_id);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- ── 5. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.feedback_pending_forward(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feedback_pending_forward(INT) TO service_role;

REVOKE ALL ON FUNCTION public.mark_feedback_forwarded(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_feedback_forwarded(UUID, BOOLEAN, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.feedback_retry_now(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feedback_retry_now(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.feedback_delivery_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feedback_delivery_health() TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.feedback_forward_backoff(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.feedback_forward_max_attempts() TO service_role;

-- ── 6. Prove the behaviour, not the syntax ──────────────────────────────────
DO $probe$
DECLARE
  _t UUID;
  _s UUID;
  _next TIMESTAMPTZ;
  _n INT;
BEGIN
  INSERT INTO public.tenants (external_ref, display_name, status)
  VALUES ('test:feedback-retry-probe', 'Retry probe', 'active') RETURNING id INTO _t;

  PERFORM public.submit_feedback(_t, '{"origin_user_id":"u1","overall_rating":"4"}'::jsonb);
  SELECT id INTO _s FROM public.feedback_submissions WHERE tenant_id = _t;

  -- A brand-new submission is due immediately: the first attempt happens
  -- inline, but if the process dies between INSERT and POST the sweep must
  -- still pick it up rather than leaving it to be found by hand.
  IF NOT EXISTS (SELECT 1 FROM public.feedback_pending_forward(10) WHERE submission_id = _s) THEN
    RAISE EXCEPTION 'a never-attempted submission must be immediately sweepable';
  END IF;

  -- A failure pushes it into the future; it must not be handed out again on
  -- the very next sweep, which is how a retry loop turns into a hot loop.
  PERFORM public.mark_feedback_forwarded(_s, false, 'make_http_502');
  SELECT next_forward_at INTO _next FROM public.feedback_submissions WHERE id = _s;
  IF _next <= now() THEN
    RAISE EXCEPTION 'a failed delivery must be deferred, got next_forward_at=%', _next;
  END IF;
  IF EXISTS (SELECT 1 FROM public.feedback_pending_forward(10) WHERE submission_id = _s) THEN
    RAISE EXCEPTION 'a deferred submission must not be swept again immediately';
  END IF;

  -- Backoff grows, and stops growing.
  IF public.feedback_forward_backoff(1) >= public.feedback_forward_backoff(4) THEN
    RAISE EXCEPTION 'backoff must increase with attempts';
  END IF;
  IF public.feedback_forward_backoff(50) <> INTERVAL '6 hours' THEN
    RAISE EXCEPTION 'backoff must cap at six hours, got %',
      public.feedback_forward_backoff(50);
  END IF;

  -- The operator override clears the wait.
  SELECT public.feedback_retry_now(_s) INTO _n;
  IF _n <> 1 THEN RAISE EXCEPTION 'retry_now should have released exactly one row, got %', _n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feedback_pending_forward(10) WHERE submission_id = _s) THEN
    RAISE EXCEPTION 'retry_now must make the row immediately sweepable again';
  END IF;

  -- An exhausted row drops out of the sweep instead of churning forever.
  UPDATE public.feedback_submissions
     SET forward_attempts = public.feedback_forward_max_attempts(), next_forward_at = now()
   WHERE id = _s;
  IF EXISTS (SELECT 1 FROM public.feedback_pending_forward(10) WHERE submission_id = _s) THEN
    RAISE EXCEPTION 'a submission past the attempt ceiling must stop being retried';
  END IF;
  IF (public.feedback_delivery_health() ->> 'exhausted')::INT < 1 THEN
    RAISE EXCEPTION 'delivery health must surface exhausted rows so they are not invisible';
  END IF;

  -- Success takes it out of contention permanently.
  UPDATE public.feedback_submissions SET forward_attempts = 0 WHERE id = _s;
  PERFORM public.mark_feedback_forwarded(_s, true);
  IF EXISTS (SELECT 1 FROM public.feedback_pending_forward(10) WHERE submission_id = _s) THEN
    RAISE EXCEPTION 'a delivered submission must never be swept again';
  END IF;
  IF (SELECT forward_error FROM public.feedback_submissions WHERE id = _s) IS NOT NULL THEN
    RAISE EXCEPTION 'a successful delivery must clear the previous error';
  END IF;

  DELETE FROM public.tenants WHERE id = _t;
END $probe$;

-- ── 7. Schedule the sweep ───────────────────────────────────────────────────
-- Same shape as the codex sweeps: read the shared secret and base URL from
-- Vault, then have pg_cron POST to the hook. Ten minutes is chosen against
-- what is actually being protected — feedback is low-volume and nobody is
-- watching Airtable in real time, so a slower sweep costs nothing, while a
-- fast one would hammer Make while it is still down.
DO $$
DECLARE
  v_secret  TEXT;
  v_base    TEXT;
  v_headers TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — POST /hooks/feedback-forward-retry from your scheduler.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;

  IF v_secret IS NULL THEN
    -- Loud, because the failure it guards against is invisible: no sweep means
    -- undelivered feedback accumulates and nothing says so.
    RAISE WARNING 'Vault entry cron_secret not found — feedback retry sweep NOT scheduled. Undelivered submissions will not be replayed until this is set.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_base
  FROM vault.decrypted_secrets WHERE name = 'app_public_url' LIMIT 1;
  v_base := COALESCE(NULLIF(rtrim(v_base, '/'), ''), 'https://aurixa-mission-control.lovable.app');

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_secret
  )::text;

  PERFORM cron.unschedule('feedback-forward-retry')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'feedback-forward-retry');

  PERFORM cron.schedule(
    'feedback-forward-retry', '*/10 * * * *',
    format($f$SELECT net.http_post(
      url:=%L, headers:=%L::jsonb, body:='{}'::jsonb)$f$,
      v_base || '/hooks/feedback-forward-retry', v_headers)
  );
EXCEPTION WHEN OTHERS THEN
  -- Scheduling is the one part of this migration that depends on things
  -- outside the schema — vault, pg_net, cron privileges. None of them are
  -- worth failing the whole migration over, because the functions above are
  -- what actually make a replay possible and they are already committed.
  -- Warned rather than swallowed: a sweep that was never scheduled is exactly
  -- the silent failure this file exists to remove.
  RAISE WARNING 'feedback retry sweep NOT scheduled (%). Replay the backlog with POST /hooks/feedback-forward-retry until this is fixed.', SQLERRM;
END $$;
