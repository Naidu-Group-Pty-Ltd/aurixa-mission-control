ALTER TABLE public.codex_remediations
  ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'codex_cli',
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN,
  ADD COLUMN IF NOT EXISTS files_changed INTEGER,
  ADD COLUMN IF NOT EXISTS lines_added INTEGER,
  ADD COLUMN IF NOT EXISTS lines_removed INTEGER,
  ADD COLUMN IF NOT EXISTS fix_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fix_confirmed_by_job_id UUID
    REFERENCES public.codex_scan_jobs(id) ON DELETE SET NULL;

ALTER TABLE public.codex_remediations
  ALTER COLUMN scan_job_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS codex_remediations_open_idx
  ON public.codex_remediations(created_at DESC)
  WHERE status IN ('queued', 'dispatched', 'pr_opened', 'pr_updated', 'changes_requested');

CREATE INDEX IF NOT EXISTS codex_remediations_branch_idx
  ON public.codex_remediations(repo_full_name, branch_name);