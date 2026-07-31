-- Client Fit Analysis — scoring integrity, tunable bands, and a knowledge base.
--
-- Four things the engine could not previously express:
--
--   1. "The model did not assess this dimension." Every rubric dimension the
--      AI omitted was scored 0 and still consumed its full share of the weight,
--      so an incomplete answer read as a bad prospect. The analysis now records
--      how much of the rubric was actually covered.
--   2. "This score is not backed by evidence." The prompt demands evidence for
--      every dimension and says outright that an unevidenced high score is a
--      failure — but nothing enforced it, so a hallucinated 95 outranked an
--      evidenced 80.
--   3. "This is a veto, not a score." The disqualifying-risk gate was found by
--      looking for a dimension literally named `risk`; renaming or deactivating
--      that row removed the veto silently.
--   4. "Here is what we know about our own business." The analyst saw the
--      pricing catalog and nothing else — no ideal-customer profile, no win/loss
--      history, no disqualification policy.

-- ── Rubric: veto semantics and evidence requirements ────────────────────────

ALTER TABLE public.crm_fit_rubric
  ADD COLUMN IF NOT EXISTS is_veto BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS veto_below NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence_required BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS unevidenced_ceiling NUMERIC NOT NULL DEFAULT 55
    CONSTRAINT crm_fit_rubric_ceiling_range CHECK (unevidenced_ceiling >= 0 AND unevidenced_ceiling <= 100);

COMMENT ON COLUMN public.crm_fit_rubric.is_veto IS
  'A veto dimension can decline the whole analysis on its own, whatever the weighted score. Marked explicitly so renaming the row cannot remove the gate.';
COMMENT ON COLUMN public.crm_fit_rubric.veto_below IS
  'Raw score at or below which this veto dimension declines the analysis outright.';
COMMENT ON COLUMN public.crm_fit_rubric.unevidenced_ceiling IS
  'The highest raw score this dimension may hold when the model cited no evidence for it.';

-- The seeded risk dimension is the veto, at the threshold the engine already
-- applied in code.
UPDATE public.crm_fit_rubric
   SET is_veto = true, veto_below = 25
 WHERE dimension = 'risk';

-- ── Tunable grade / verdict bands ───────────────────────────────────────────
-- The rubric table was introduced as "tunable weights + bands", but the bands
-- were hardcoded in TypeScript. They live here now, so changing where a B
-- becomes a C does not need a deploy.

CREATE TABLE IF NOT EXISTS public.crm_fit_bands (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  grade TEXT NOT NULL UNIQUE,
  verdict public.crm_fit_verdict NOT NULL,
  min_score NUMERIC NOT NULL CHECK (min_score >= 0 AND min_score <= 100),
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_fit_bands TO authenticated;
GRANT ALL ON public.crm_fit_bands TO service_role;
ALTER TABLE public.crm_fit_bands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view fit bands" ON public.crm_fit_bands;
CREATE POLICY "Operators can view fit bands"
  ON public.crm_fit_bands FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins can manage fit bands" ON public.crm_fit_bands;
CREATE POLICY "Admins can manage fit bands"
  ON public.crm_fit_bands FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Seeded to the thresholds the engine already used, so behaviour is unchanged
-- until somebody deliberately changes it.
INSERT INTO public.crm_fit_bands (grade, verdict, min_score, label, sort_order) VALUES
  ('A', 'strong_fit',  85, 'Excellent fit',  1),
  ('B', 'fit',         70, 'Good fit',       2),
  ('C', 'conditional', 55, 'Conditional fit', 3),
  ('D', 'poor_fit',    40, 'Weak fit',       4),
  ('F', 'decline',      0, 'Not a fit',      5)
ON CONFLICT (grade) DO NOTHING;

-- ── Analysis: how the number was arrived at ─────────────────────────────────

ALTER TABLE public.crm_fit_analyses
  ADD COLUMN IF NOT EXISTS coverage        NUMERIC,
  ADD COLUMN IF NOT EXISTS samples         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS agreement       NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence_count  INTEGER,
  ADD COLUMN IF NOT EXISTS verified_ratio  NUMERIC,
  ADD COLUMN IF NOT EXISTS confidence_basis JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS integrity       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS knowledge_ids   UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.crm_fit_analyses.coverage IS
  'Percentage of active rubric weight the model actually assessed. A score computed over 60% coverage is not the same claim as one over 100%.';
COMMENT ON COLUMN public.crm_fit_analyses.agreement IS
  'Inter-sample agreement, 0-100. The engine scores each prospect several times independently; wide disagreement means the evidence does not support a confident number.';
COMMENT ON COLUMN public.crm_fit_analyses.confidence_basis IS
  'The measurable signals confidence was derived from, so a number can be argued with rather than taken on faith.';
COMMENT ON COLUMN public.crm_fit_analyses.integrity IS
  'What the engine had to correct: dimensions the model skipped, scores capped for want of evidence, and capability slugs it invented.';

-- ── Per-dimension: was it answered, and was it capped ───────────────────────

ALTER TABLE public.crm_fit_dimension_scores
  ADD COLUMN IF NOT EXISTS answered   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS capped     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_veto    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS raw_spread NUMERIC;

COMMENT ON COLUMN public.crm_fit_dimension_scores.answered IS
  'False when the model returned nothing for this dimension. Unanswered dimensions are excluded from the score rather than counted as zero.';
COMMENT ON COLUMN public.crm_fit_dimension_scores.capped IS
  'True when the raw score was lowered to the dimension ceiling because no evidence was cited.';
COMMENT ON COLUMN public.crm_fit_dimension_scores.raw_spread IS
  'Spread of this dimension score across independent samples. High spread is a warning, not a detail.';

-- ── Knowledge base ──────────────────────────────────────────────────────────
-- What the analyst is allowed to know about Aurixa beyond the price list:
-- the ideal customer profile, positioning, past wins and losses, and the
-- disqualification policy. Retrieval is budgeted, so this grows without
-- silently crowding the prospect's own evidence out of the prompt.

DO $$ BEGIN
  CREATE TYPE public.crm_fit_knowledge_kind AS ENUM (
    'icp',
    'case_study',
    'positioning',
    'disqualification',
    'pricing',
    'objection',
    'process',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.crm_fit_knowledge (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  kind public.crm_fit_knowledge_kind NOT NULL DEFAULT 'other',
  -- The text that actually reaches the analyst. A row with no content is a
  -- stored file and nothing more; the engine never guesses at binary formats.
  content TEXT NOT NULL DEFAULT '',
  summary TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  -- Provenance for an uploaded document. The file is kept whether or not its
  -- text could be extracted, so the source of a claim stays auditable.
  file_path TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  active BOOLEAN NOT NULL DEFAULT true,
  -- Pinned entries are always included, ahead of relevance ranking. Use for
  -- the things that apply to every prospect: the ICP, the decline policy.
  pinned BOOLEAN NOT NULL DEFAULT false,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_fit_knowledge_active_idx
  ON public.crm_fit_knowledge (active, pinned DESC, kind);
CREATE INDEX IF NOT EXISTS crm_fit_knowledge_tags_idx
  ON public.crm_fit_knowledge USING GIN (tags);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_fit_knowledge TO authenticated;
GRANT ALL ON public.crm_fit_knowledge TO service_role;
ALTER TABLE public.crm_fit_knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view fit knowledge" ON public.crm_fit_knowledge;
CREATE POLICY "Operators can view fit knowledge"
  ON public.crm_fit_knowledge FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins can manage fit knowledge" ON public.crm_fit_knowledge;
CREATE POLICY "Admins can manage fit knowledge"
  ON public.crm_fit_knowledge FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS update_crm_fit_knowledge_updated_at ON public.crm_fit_knowledge;
CREATE TRIGGER update_crm_fit_knowledge_updated_at
  BEFORE UPDATE ON public.crm_fit_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_crm_fit_bands_updated_at ON public.crm_fit_bands;
CREATE TRIGGER update_crm_fit_bands_updated_at
  BEFORE UPDATE ON public.crm_fit_bands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Source documents ────────────────────────────────────────────────────────
-- Private: these are internal sales and positioning documents. Only operators
-- read them, only admins write them, and nothing is ever served publicly.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'fit-knowledge',
  'fit-knowledge',
  false,
  26214400, -- 25 MB
  ARRAY[
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'application/json',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "Operators read fit knowledge files" ON storage.objects;
CREATE POLICY "Operators read fit knowledge files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'fit-knowledge' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins write fit knowledge files" ON storage.objects;
CREATE POLICY "Admins write fit knowledge files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'fit-knowledge' AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins update fit knowledge files" ON storage.objects;
CREATE POLICY "Admins update fit knowledge files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'fit-knowledge' AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins delete fit knowledge files" ON storage.objects;
CREATE POLICY "Admins delete fit knowledge files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'fit-knowledge' AND public.is_admin(auth.uid()));

-- ── Stage 2 answers on the lead ─────────────────────────────────────────────
-- The Business Readiness Questionnaire is the most substantial qualification
-- data the business collects — systems in use, integration needs, migration
-- scope, security requirements, budget — and the fit engine could not see any
-- of it. The mirrored response now lands here so it can.

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage2_summary TEXT,
  ADD COLUMN IF NOT EXISTS stage2_answers JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.waitlist_leads.stage2_answers IS
  'The Stage 2 questionnaire answers, keyed by question. Read by the client-fit engine as the prospect''s own account of their operation.';
