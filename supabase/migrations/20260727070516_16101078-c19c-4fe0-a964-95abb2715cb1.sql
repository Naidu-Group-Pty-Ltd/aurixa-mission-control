
DO $$ BEGIN
  CREATE TYPE public.codex_remediation_status AS ENUM (
    'queued','dispatched','pr_opened','pr_updated','merged','closed','failed','canceled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.codex_remediations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id UUID NOT NULL REFERENCES public.codex_findings(id) ON DELETE CASCADE,
  scan_job_id UUID NOT NULL REFERENCES public.codex_scan_jobs(id) ON DELETE CASCADE,
  clone_id UUID REFERENCES public.clones(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  branch_name TEXT,
  workflow_run_id BIGINT,
  workflow_run_url TEXT,
  pr_number INT,
  pr_url TEXT,
  pr_state TEXT,
  status public.codex_remediation_status NOT NULL DEFAULT 'queued',
  dispatch_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codex_remediations_finding_idx ON public.codex_remediations(finding_id);
CREATE INDEX IF NOT EXISTS codex_remediations_job_idx ON public.codex_remediations(scan_job_id);
CREATE INDEX IF NOT EXISTS codex_remediations_status_idx ON public.codex_remediations(status, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.codex_remediations TO authenticated;
GRANT ALL ON public.codex_remediations TO service_role;
ALTER TABLE public.codex_remediations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "codex_remediations read operator+"
  ON public.codex_remediations FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

CREATE POLICY "codex_remediations write admin"
  ON public.codex_remediations FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS trg_codex_remediations_updated ON public.codex_remediations;
CREATE TRIGGER trg_codex_remediations_updated BEFORE UPDATE ON public.codex_remediations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
