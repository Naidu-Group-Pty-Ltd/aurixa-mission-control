-- Store the parity verdict on the backend row.
--
-- Provisioning had no notion of whether the result MATCHED the prime. Its
-- definition of success was that every step it ran reported success, which is
-- a different question: a clone that applied 528 of the prime's 641 tables
-- without a single error reported ready. Reconciling the two numbers was one
-- query and nothing ran it.
--
-- computeParity() already existed but was reachable only from the handoff
-- screens. This column is where provisioning records it, so a backend that
-- came up short is visibly short rather than green.

ALTER TABLE public.clone_backends
  ADD COLUMN IF NOT EXISTS parity_report jsonb,
  ADD COLUMN IF NOT EXISTS parity_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS repo_retarget jsonb;

COMMENT ON COLUMN public.clone_backends.parity_report IS
  'Full ParityResult from the last post-provision comparison against the prime. '
  'blocking_issues being non-empty means the clone is incomplete regardless of status.';
COMMENT ON COLUMN public.clone_backends.parity_checked_at IS
  'When parity_report was produced. NULL means the clone has never been compared '
  'with the prime — which is not the same as matching it.';

COMMENT ON COLUMN public.clone_backends.repo_retarget IS
  'What was rewritten in the clone REPOSITORY so it stops naming the prime: '
  'config.toml project_id, the workflows'' hard-coded SUPABASE_PROJECT_REF '
  'fallback, the checked-in CLI link file, and the repo variable. A failed '
  'entry means that clone can still act on another project once a '
  'SUPABASE_ACCESS_TOKEN is added to it.';
