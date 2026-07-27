-- ────────────────────────────────────────────────────────────────────────
-- Codex Security: bring the scan pipeline live.
--
-- 1. Add the two `clones` columns the application already queries but that
--    were never created (every affected select returned a PostgREST error,
--    which is why clone scans, clone remediations, and the Actions secret
--    sync silently did nothing).
-- 2. Record which engine ran a scan and where its workflow run lives.
-- 3. Extend findings with scanner provenance + a stable fingerprint so runs
--    can be diffed and fixed issues auto-resolved.
-- 4. Aggregate the fleet overview server-side instead of pulling 500 job
--    rows and every open finding into the app on each poll.
-- 5. Schedule the stalled-scan sweeper.
-- ────────────────────────────────────────────────────────────────────────

-- ── 1. clones: columns the app already expects ──────────────────────────

-- Per-clone GitHub App installation. NULL keeps the previous behaviour of
-- falling back to GITHUB_APP_INSTALLATION_ID, so nothing changes for fleets
-- that live under a single installation.
ALTER TABLE public.clones
  ADD COLUMN IF NOT EXISTS github_app_installation_id TEXT;

-- Generated so it can never drift from owner/repo. Several call sites read
-- `clones.repo_full_name` directly (scan target resolution, nightly fan-out,
-- remediation dispatch); they all start working the moment this exists.
DO $$ BEGIN
  ALTER TABLE public.clones
    ADD COLUMN repo_full_name TEXT
    GENERATED ALWAYS AS (github_owner || '/' || github_repo) STORED;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS clones_repo_full_name_idx
  ON public.clones(repo_full_name);

-- ── 2. codex_scan_jobs: engine provenance ───────────────────────────────

ALTER TABLE public.codex_scan_jobs
  ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'github_actions',
  ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT,
  ADD COLUMN IF NOT EXISTS workflow_run_url TEXT;

-- The sweeper scans for stranded work by (status, created_at) and
-- (status, started_at); both are hot on every sweep.
CREATE INDEX IF NOT EXISTS codex_scan_jobs_sweep_queued_idx
  ON public.codex_scan_jobs(created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS codex_scan_jobs_sweep_running_idx
  ON public.codex_scan_jobs(started_at)
  WHERE status = 'running';

-- ── 3. codex_findings: scanner provenance + fingerprints ────────────────

-- Intake-sourced findings (Snyk, manual, ticketing bridges) have no scan
-- job. The adapter has always inserted scan_job_id = NULL, which the NOT
-- NULL constraint rejected outright.
ALTER TABLE public.codex_findings
  ALTER COLUMN scan_job_id DROP NOT NULL;

ALTER TABLE public.codex_findings
  ADD COLUMN IF NOT EXISTS scanner TEXT,
  ADD COLUMN IF NOT EXISTS rule_id TEXT,
  ADD COLUMN IF NOT EXISTS fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS snippet TEXT,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill the fingerprint from the scanner-supplied id for existing rows.
UPDATE public.codex_findings
   SET fingerprint = codex_finding_id
 WHERE fingerprint IS NULL;

-- UNIQUE (scan_job_id, codex_finding_id) does not constrain rows where
-- scan_job_id IS NULL (NULLs are distinct), so intake findings need their
-- own guard to stay idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS codex_findings_intake_unique_idx
  ON public.codex_findings(codex_finding_id)
  WHERE scan_job_id IS NULL;

-- Cross-run diffing: "which findings from the previous scan of this repo
-- are still present in this one?"
CREATE INDEX IF NOT EXISTS codex_findings_fingerprint_idx
  ON public.codex_findings(fingerprint);

CREATE INDEX IF NOT EXISTS codex_findings_job_state_idx
  ON public.codex_findings(scan_job_id, state);

-- Fleet overview only ever counts open findings per clone.
CREATE INDEX IF NOT EXISTS codex_findings_open_by_clone_idx
  ON public.codex_findings(clone_id, severity)
  WHERE state = 'open';

-- ── 4. Fleet overview aggregation ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.codex_fleet_overview()
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  repo_full_name TEXT,
  github_owner TEXT,
  github_repo TEXT,
  codex_nightly_enabled BOOLEAN,
  sync_status TEXT,
  last_scan JSONB,
  open_findings JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY DEFINER bypasses RLS, so re-assert the read gate that the
  -- underlying tables' policies would have applied.
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator or admin required';
  END IF;

  RETURN QUERY
  WITH last_jobs AS (
    SELECT DISTINCT ON (j.clone_id)
      j.clone_id,
      jsonb_build_object(
        'id', j.id,
        'kind', j.kind,
        'status', j.status,
        'engine', j.engine,
        'started_at', j.started_at,
        'completed_at', j.completed_at,
        'created_at', j.created_at,
        'workflow_run_url', j.workflow_run_url,
        'last_error', j.last_error,
        'result_summary', j.result_summary
      ) AS last_scan
    FROM public.codex_scan_jobs j
    WHERE j.clone_id IS NOT NULL
    ORDER BY j.clone_id, j.created_at DESC
  ),
  finding_counts AS (
    SELECT
      f.clone_id,
      jsonb_build_object(
        'critical', count(*) FILTER (WHERE f.severity = 'critical'),
        'high',     count(*) FILTER (WHERE f.severity = 'high'),
        'medium',   count(*) FILTER (WHERE f.severity = 'medium'),
        'low',      count(*) FILTER (WHERE f.severity = 'low'),
        'info',     count(*) FILTER (WHERE f.severity = 'info')
      ) AS open_findings
    FROM public.codex_findings f
    WHERE f.state = 'open' AND f.clone_id IS NOT NULL
    GROUP BY f.clone_id
  )
  SELECT
    c.id,
    c.name,
    c.slug,
    c.repo_full_name,
    c.github_owner,
    c.github_repo,
    c.codex_nightly_enabled,
    c.sync_status::TEXT,
    lj.last_scan,
    COALESCE(
      fc.open_findings,
      '{"critical":0,"high":0,"medium":0,"low":0,"info":0}'::jsonb
    )
  FROM public.clones c
  LEFT JOIN last_jobs lj ON lj.clone_id = c.id
  LEFT JOIN finding_counts fc ON fc.clone_id = c.id
  ORDER BY c.name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.codex_fleet_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.codex_fleet_overview() TO authenticated;

-- ── 5. Stalled-scan sweeper schedule ────────────────────────────────────
-- Also re-points the nightly job at the vault-configured public URL when
-- one is present; the original migration hardcoded a single deployment
-- hostname that no longer matches every environment.

DO $$
DECLARE
  v_secret TEXT;
  v_base   TEXT;
  v_headers TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'Vault entry cron_secret not found; skipping codex cron scheduling.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_base
  FROM vault.decrypted_secrets WHERE name = 'app_public_url' LIMIT 1;
  v_base := COALESCE(NULLIF(rtrim(v_base, '/'), ''), 'https://aurixa-mission-control.lovable.app');

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_secret
  )::text;

  PERFORM cron.unschedule('codex-security-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'codex-security-nightly');

  PERFORM cron.schedule(
    'codex-security-nightly', '0 7 * * *',
    format($f$SELECT net.http_post(
      url:=%L, headers:=%L::jsonb, body:='{}'::jsonb)$f$,
      v_base || '/hooks/codex-nightly', v_headers)
  );

  PERFORM cron.unschedule('codex-security-sweep')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'codex-security-sweep');

  -- Every 10 minutes: re-dispatch scans whose dispatch was lost and retire
  -- workflow runs that died without reporting a terminal callback.
  PERFORM cron.schedule(
    'codex-security-sweep', '*/10 * * * *',
    format($f$SELECT net.http_post(
      url:=%L, headers:=%L::jsonb, body:='{}'::jsonb)$f$,
      v_base || '/hooks/codex-sweep', v_headers)
  );
END $$;
