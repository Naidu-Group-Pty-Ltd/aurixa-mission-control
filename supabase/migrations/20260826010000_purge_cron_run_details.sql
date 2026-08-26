-- The purge covers twelve log tables and misses the one that grows fastest.
--
-- `purge_log_tables()` runs daily and trims ai_usage_log, audit_log,
-- cloudflare_audit, push_delivery_log, route_errors, stripe_events,
-- token_api_rate_limits, token_webhook_deliveries, fleet_digests,
-- module_detection_runs, cascade_events and cascade_results. Every one of them
-- is in `public`. Nothing trims `cron.job_run_details`, which pg_cron appends to
-- on every run of every job and never prunes itself.
--
-- Measured against the 27 jobs now scheduled — five of them every minute after
-- 20260826000000 scheduled the two cloning engines — that table takes about
-- 10,200 rows a day, 307,000 a month, 3.7 million a year, for ever.
--
-- WHY IT MATTERS MORE THAN ITS SIZE. `cron_delivery_health()` reads it. That
-- function is this platform's answer to the rule it keeps relearning — a green
-- cron run is not a delivered request, so ask `job_run_details` and
-- `net._http_response` rather than believing the scheduler — and it filters on
-- `start_time` with no index behind it. So the tool that tells an operator
-- whether a worker is actually being delivered gets slower every day it is not
-- needed, and is at its slowest the first time it is. An observability function
-- that degrades until it times out reports nothing, which reads exactly like
-- nothing being wrong.
--
-- Thirty days is chosen against that function rather than against disk: its
-- default window is 24 hours and its widest sensible use is a monthly review.
--
-- THE DELETE IS WRAPPED, and that is the point of the change rather than an
-- afterthought. `cron.job_run_details` is not in `public` and its ownership
-- differs between a Supabase project and a local replay. If the statement
-- raises — insufficient privilege, or no pg_cron at all — an unwrapped DELETE
-- aborts the whole function and takes the twelve purges that DO work down with
-- it. One new line must not be able to stop the twelve.
CREATE OR REPLACE FUNCTION public.purge_log_tables()
RETURNS TABLE(table_name text, deleted_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE
  r bigint;
BEGIN
  DELETE FROM public.ai_usage_log             WHERE created_at  < now() - interval '90 days';  GET DIAGNOSTICS r = ROW_COUNT; table_name := 'ai_usage_log';            deleted_rows := r; RETURN NEXT;
  DELETE FROM public.audit_log                WHERE created_at  < now() - interval '365 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'audit_log';               deleted_rows := r; RETURN NEXT;
  DELETE FROM public.cloudflare_audit         WHERE created_at  < now() - interval '180 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'cloudflare_audit';        deleted_rows := r; RETURN NEXT;
  DELETE FROM public.push_delivery_log        WHERE created_at  < now() - interval '60 days';  GET DIAGNOSTICS r = ROW_COUNT; table_name := 'push_delivery_log';       deleted_rows := r; RETURN NEXT;
  DELETE FROM public.route_errors             WHERE created_at  < now() - interval '90 days';  GET DIAGNOSTICS r = ROW_COUNT; table_name := 'route_errors';            deleted_rows := r; RETURN NEXT;
  DELETE FROM public.stripe_events            WHERE created_at  < now() - interval '180 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'stripe_events';           deleted_rows := r; RETURN NEXT;
  DELETE FROM public.token_api_rate_limits    WHERE window_start < now() - interval '14 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'token_api_rate_limits';   deleted_rows := r; RETURN NEXT;
  DELETE FROM public.token_webhook_deliveries WHERE created_at  < now() - interval '90 days';  GET DIAGNOSTICS r = ROW_COUNT; table_name := 'token_webhook_deliveries'; deleted_rows := r; RETURN NEXT;
  DELETE FROM public.fleet_digests            WHERE created_at  < now() - interval '365 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'fleet_digests';           deleted_rows := r; RETURN NEXT;
  DELETE FROM public.module_detection_runs    WHERE completed_at IS NOT NULL AND completed_at < now() - interval '180 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'module_detection_runs'; deleted_rows := r; RETURN NEXT;
  DELETE FROM public.cascade_events           WHERE completed_at IS NOT NULL AND completed_at < now() - interval '180 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'cascade_events';        deleted_rows := r; RETURN NEXT;
  DELETE FROM public.cascade_results          WHERE completed_at IS NOT NULL AND completed_at < now() - interval '180 days'; GET DIAGNOSTICS r = ROW_COUNT; table_name := 'cascade_results';       deleted_rows := r; RETURN NEXT;

  -- pg_cron's own run log. Reported as its own row either way, so a deployment
  -- where this is not permitted says so in the result rather than looking like
  -- a table that had nothing to trim.
  BEGIN
    DELETE FROM cron.job_run_details WHERE start_time < now() - interval '30 days';
    GET DIAGNOSTICS r = ROW_COUNT;
    table_name := 'cron.job_run_details'; deleted_rows := r; RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'purge_log_tables: could not trim cron.job_run_details (%)', SQLERRM;
    table_name := 'cron.job_run_details (skipped)'; deleted_rows := -1; RETURN NEXT;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_log_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_log_tables() TO service_role;
