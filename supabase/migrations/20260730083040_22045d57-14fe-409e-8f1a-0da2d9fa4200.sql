-- ============ Client Fit Analysis ============

CREATE TYPE public.crm_fit_verdict AS ENUM (
  'strong_fit', 'fit', 'conditional', 'poor_fit', 'decline'
);

CREATE TYPE public.crm_fit_status AS ENUM (
  'queued', 'running', 'complete', 'failed'
);

-- ---- Rubric (tunable weights + bands) ----
CREATE TABLE public.crm_fit_rubric (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dimension TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  weight NUMERIC NOT NULL DEFAULT 10 CHECK (weight >= 0 AND weight <= 100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_fit_rubric TO authenticated;
GRANT ALL ON public.crm_fit_rubric TO service_role;
ALTER TABLE public.crm_fit_rubric ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can view fit rubric"
  ON public.crm_fit_rubric FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

CREATE POLICY "Admins can manage fit rubric"
  ON public.crm_fit_rubric FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---- Analyses ----
CREATE TABLE public.crm_fit_analyses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES public.waitlist_leads(id) ON DELETE CASCADE,
  subject_name TEXT NOT NULL DEFAULT '',
  subject_email TEXT,
  subject_website TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status public.crm_fit_status NOT NULL DEFAULT 'queued',
  score NUMERIC,
  grade TEXT,
  verdict public.crm_fit_verdict,
  confidence NUMERIC,
  headline TEXT,
  research_summary TEXT,
  correlation_map JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_response JSONB,
  model TEXT,
  tokens_used INTEGER,
  error TEXT,
  override_verdict public.crm_fit_verdict,
  override_reason TEXT,
  override_by UUID,
  override_at TIMESTAMPTZ,
  requested_by UUID,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_fit_subject_required CHECK (account_id IS NOT NULL OR lead_id IS NOT NULL)
);

CREATE INDEX crm_fit_analyses_account_idx ON public.crm_fit_analyses (account_id, created_at DESC);
CREATE INDEX crm_fit_analyses_lead_idx ON public.crm_fit_analyses (lead_id, created_at DESC);
CREATE INDEX crm_fit_analyses_created_idx ON public.crm_fit_analyses (created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_fit_analyses TO authenticated;
GRANT ALL ON public.crm_fit_analyses TO service_role;
ALTER TABLE public.crm_fit_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can view fit analyses"
  ON public.crm_fit_analyses FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

CREATE POLICY "Admins can manage fit analyses"
  ON public.crm_fit_analyses FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---- Per-dimension scores ----
CREATE TABLE public.crm_fit_dimension_scores (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  analysis_id UUID NOT NULL REFERENCES public.crm_fit_analyses(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  label TEXT NOT NULL,
  weight NUMERIC NOT NULL DEFAULT 0,
  raw_score NUMERIC NOT NULL DEFAULT 0,
  weighted_score NUMERIC NOT NULL DEFAULT 0,
  rationale TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, dimension)
);

CREATE INDEX crm_fit_dimension_scores_analysis_idx ON public.crm_fit_dimension_scores (analysis_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_fit_dimension_scores TO authenticated;
GRANT ALL ON public.crm_fit_dimension_scores TO service_role;
ALTER TABLE public.crm_fit_dimension_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can view fit dimension scores"
  ON public.crm_fit_dimension_scores FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

CREATE POLICY "Admins can manage fit dimension scores"
  ON public.crm_fit_dimension_scores FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---- updated_at triggers ----
CREATE TRIGGER update_crm_fit_rubric_updated_at
  BEFORE UPDATE ON public.crm_fit_rubric
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_crm_fit_analyses_updated_at
  BEFORE UPDATE ON public.crm_fit_analyses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- Seed default rubric ----
INSERT INTO public.crm_fit_rubric (dimension, label, description, weight, sort_order) VALUES
  ('problem_solution', 'Problem–solution fit', 'Do their stated bottlenecks map to Aurixa modules?', 30, 1),
  ('segment', 'Segment fit', 'Entity classification versus our ideal customer profile.', 15, 2),
  ('scale', 'Scale fit', 'Transaction volume versus tier capacity.', 15, 3),
  ('technical', 'Technical fit', 'Their stack versus our integration surface.', 15, 4),
  ('commercial', 'Commercial fit', 'Implied contract value and viability.', 15, 5),
  ('risk', 'Risk & red flags', 'Unverifiable entity, regulated edge cases, churn signals.', 10, 6)
ON CONFLICT (dimension) DO NOTHING;
