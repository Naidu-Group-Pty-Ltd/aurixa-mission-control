-- ────────────────────────────────────────────────────────────────────────
-- Codex remediation: record HOW a fix was produced and whether it holds up.
--
-- Until now a remediation row said only "a PR exists". Nothing recorded
-- which engine wrote the patch, whether the patched tree still compiles or
-- passes its own tests, how much of the repo the patch touched, or whether
-- the fix re-introduced a secret. Reviewers were approving a black box.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE public.codex_remediations
  -- Provenance of the patch author.
  ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'codex_cli',
  ADD COLUMN IF NOT EXISTS model TEXT,
  -- Results of the repo's own checks run against the patched tree, plus the
  -- secret-leak scan. Shape: { checks: [{name, ok, skipped, detail}],
  -- secrets_clean: bool, ok: bool }
  ADD COLUMN IF NOT EXISTS verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- NULL = not reported yet (older rows, or a run that died early).
  ADD COLUMN IF NOT EXISTS verified BOOLEAN,
  -- Blast radius of the patch, so a "smallest possible change" that touched
  -- 40 files is visible before anyone approves it.
  ADD COLUMN IF NOT EXISTS files_changed INTEGER,
  ADD COLUMN IF NOT EXISTS lines_added INTEGER,
  ADD COLUMN IF NOT EXISTS lines_removed INTEGER,
  -- Set when a post-merge / PR scan confirms the finding's fingerprint is
  -- gone from the patched ref.
  ADD COLUMN IF NOT EXISTS fix_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fix_confirmed_by_job_id UUID
    REFERENCES public.codex_scan_jobs(id) ON DELETE SET NULL;

-- Findings ingested from a partner/scanner intake have no scan job, and
-- `codex_findings.scan_job_id` became nullable in 20260727140000. A
-- remediation for one of those findings could not be inserted at all.
ALTER TABLE public.codex_remediations
  ALTER COLUMN scan_job_id DROP NOT NULL;

-- Reviewers filter on "what still needs a decision".
CREATE INDEX IF NOT EXISTS codex_remediations_open_idx
  ON public.codex_remediations(created_at DESC)
  WHERE status IN ('queued', 'dispatched', 'pr_opened', 'pr_updated', 'changes_requested');

-- Confirming a fix looks up the remediation by its branch.
CREATE INDEX IF NOT EXISTS codex_remediations_branch_idx
  ON public.codex_remediations(repo_full_name, branch_name);
