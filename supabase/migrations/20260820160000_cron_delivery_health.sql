-- A green cron run is not a delivered request.
--
-- pg_cron records whether the SQL it ran succeeded. Every scheduled job in this
-- deployment runs exactly one statement — `SELECT net.http_post(...)` — which
-- succeeds by QUEUEING a request. It returns a request id, not a response. So
-- `cron.job_run_details` says "succeeded" whether the endpoint answered 200,
-- 401, 404, or never answered at all.
--
-- Nothing in this repository has ever read `cron.job_run_details` or
-- `net._http_response`. There has been no way to answer "is cron actually
-- reaching us", which is exactly the question that matters after a domain
-- change, a rotated `CRON_SECRET`, or a job whose URL was wrong from the start.
--
-- Both catalogs live in schemas PostgREST does not expose, so this is a
-- SECURITY DEFINER function in `public` that joins them and returns one row per
-- job: when it last ran, what pg_cron thought, and what the HTTP call actually
-- came back with.
CREATE OR REPLACE FUNCTION public.cron_delivery_health(_since_hours INT DEFAULT 24)
RETURNS TABLE (
  jobname          TEXT,
  schedule         TEXT,
  active           BOOLEAN,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  runs             BIGINT,
  last_http_status INT,
  last_http_error  TEXT,
  delivered        BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net
AS $$
DECLARE
  _cutoff TIMESTAMPTZ := now() - make_interval(hours => GREATEST(COALESCE(_since_hours, 24), 1));
BEGIN
  RETURN QUERY
  WITH runs AS (
    SELECT d.jobid,
           max(d.start_time)                          AS last_run_at,
           count(*)                                   AS run_count,
           (array_agg(d.status ORDER BY d.start_time DESC))[1] AS last_status,
           -- pg_cron stores the statement's result; for these jobs that is the
           -- net.http_post request id, which is what links to the response.
           (array_agg(d.return_message ORDER BY d.start_time DESC))[1] AS last_message
      FROM cron.job_run_details d
     WHERE d.start_time >= _cutoff
     GROUP BY d.jobid
  ),
  resp AS (
    SELECT r.id, r.status_code, r.error_msg, r.created
      FROM net._http_response r
     WHERE r.created >= _cutoff
  ),
  latest_resp AS (
    SELECT DISTINCT ON (1) 1 AS k, status_code, error_msg
      FROM resp ORDER BY 1, created DESC
  )
  SELECT j.jobname::TEXT,
         j.schedule::TEXT,
         j.active,
         runs.last_run_at,
         runs.last_status::TEXT,
         COALESCE(runs.run_count, 0),
         lr.status_code,
         lr.error_msg::TEXT,
         -- Delivered means an HTTP response actually came back in the 2xx range.
         -- NULL, not false, when there is nothing to judge: "we do not know" and
         -- "it failed" are different answers and only one of them is alarming.
         CASE WHEN lr.status_code IS NULL THEN NULL
              ELSE lr.status_code BETWEEN 200 AND 299 END
    FROM cron.job j
    LEFT JOIN runs ON runs.jobid = j.jobid
    LEFT JOIN LATERAL (
      SELECT rp.status_code, rp.error_msg
        FROM resp rp
       WHERE runs.last_message IS NOT NULL
         AND rp.id::TEXT = regexp_replace(runs.last_message, '\D', '', 'g')
       LIMIT 1
    ) lr ON TRUE
   ORDER BY j.jobname;
END $$;

REVOKE ALL ON FUNCTION public.cron_delivery_health(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cron_delivery_health(INT) TO service_role;
