
-- Codex scan job status
DO $$ BEGIN
  CREATE TYPE public.codex_scan_status AS ENUM ('queued','running','completed','failed','canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.codex_scan_kind AS ENUM ('manual','nightly_full','pr_open','targeted_path','post_merge_revalidate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.codex_finding_severity AS ENUM ('critical','high','medium','low','info');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.codex_finding_state AS ENUM ('open','triaging','fix_drafted','pr_open','fix_merged','resolved','dismissed','false_positive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- codex_scan_jobs
CREATE TABLE IF NOT EXISTS public.codex_scan_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind public.codex_scan_kind NOT NULL DEFAULT 'manual',
  target_kind TEXT NOT NULL DEFAULT 'prime', -- 'prime' | 'clone'
  clone_id UUID REFERENCES public.clones(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  ref TEXT,
  path_globs TEXT[],
  status public.codex_scan_status NOT NULL DEFAULT 'queued',
  external_scan_id TEXT,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codex_scan_jobs_status_idx ON public.codex_scan_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS codex_scan_jobs_target_idx ON public.codex_scan_jobs(target_kind, clone_id);

GRANT SELECT, INSERT, UPDATE ON public.codex_scan_jobs TO authenticated;
GRANT ALL ON public.codex_scan_jobs TO service_role;
ALTER TABLE public.codex_scan_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "codex_scan_jobs read operator+"
  ON public.codex_scan_jobs FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));
CREATE POLICY "codex_scan_jobs write admin"
  ON public.codex_scan_jobs FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- codex_scan_events (append-only)
CREATE TABLE IF NOT EXISTS public.codex_scan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.codex_scan_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codex_scan_events_job_idx ON public.codex_scan_events(job_id, created_at DESC);

GRANT SELECT ON public.codex_scan_events TO authenticated;
GRANT ALL ON public.codex_scan_events TO service_role;
ALTER TABLE public.codex_scan_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "codex_scan_events read operator+"
  ON public.codex_scan_events FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

-- codex_findings
CREATE TABLE IF NOT EXISTS public.codex_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_job_id UUID NOT NULL REFERENCES public.codex_scan_jobs(id) ON DELETE CASCADE,
  clone_id UUID REFERENCES public.clones(id) ON DELETE CASCADE,
  codex_finding_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity public.codex_finding_severity NOT NULL DEFAULT 'medium',
  state public.codex_finding_state NOT NULL DEFAULT 'open',
  description TEXT,
  affected_file TEXT,
  affected_line INT,
  cwe TEXT,
  cvss NUMERIC(3,1),
  auto_fix_confidence NUMERIC(3,2),
  remediation_pr_url TEXT,
  remediation_pr_state TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scan_job_id, codex_finding_id)
);
CREATE INDEX IF NOT EXISTS codex_findings_severity_idx ON public.codex_findings(severity, state);
CREATE INDEX IF NOT EXISTS codex_findings_clone_idx ON public.codex_findings(clone_id);

GRANT SELECT, INSERT, UPDATE ON public.codex_findings TO authenticated;
GRANT ALL ON public.codex_findings TO service_role;
ALTER TABLE public.codex_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "codex_findings read operator+"
  ON public.codex_findings FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));
CREATE POLICY "codex_findings write admin"
  ON public.codex_findings FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- updated_at triggers
DROP TRIGGER IF EXISTS trg_codex_scan_jobs_updated ON public.codex_scan_jobs;
CREATE TRIGGER trg_codex_scan_jobs_updated BEFORE UPDATE ON public.codex_scan_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_codex_findings_updated ON public.codex_findings;
CREATE TRIGGER trg_codex_findings_updated BEFORE UPDATE ON public.codex_findings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
