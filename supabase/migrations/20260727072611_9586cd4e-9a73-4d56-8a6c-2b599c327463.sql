-- Add new statuses (enum add must be committed before use in same tx; use ALTER TYPE ADD VALUE IF NOT EXISTS)
ALTER TYPE public.codex_remediation_status ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE public.codex_remediation_status ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE public.codex_remediation_status ADD VALUE IF NOT EXISTS 'changes_requested';

ALTER TABLE public.codex_remediations
  ADD COLUMN IF NOT EXISTS approvals_required INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS merged_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS merge_commit_sha TEXT,
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

CREATE TABLE IF NOT EXISTS public.codex_remediation_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remediation_id UUID NOT NULL REFERENCES public.codex_remediations(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES auth.users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','changes_requested')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (remediation_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_crr_remediation ON public.codex_remediation_reviews(remediation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.codex_remediation_reviews TO authenticated;
GRANT ALL ON public.codex_remediation_reviews TO service_role;

ALTER TABLE public.codex_remediation_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can read remediation reviews"
  ON public.codex_remediation_reviews FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

CREATE POLICY "Admins can insert their own reviews"
  ON public.codex_remediation_reviews FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin(auth.uid()) AND reviewer_id = auth.uid());

CREATE POLICY "Reviewers can update their own review"
  ON public.codex_remediation_reviews FOR UPDATE
  TO authenticated
  USING (reviewer_id = auth.uid() AND public.is_admin(auth.uid()))
  WITH CHECK (reviewer_id = auth.uid());

CREATE POLICY "Reviewers can delete their own review"
  ON public.codex_remediation_reviews FOR DELETE
  TO authenticated
  USING (reviewer_id = auth.uid() AND public.is_admin(auth.uid()));
