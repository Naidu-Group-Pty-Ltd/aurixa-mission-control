ALTER TABLE public.modules
  ADD COLUMN IF NOT EXISTS edge_functions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS database_tables text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS database_rpcs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS storage_buckets text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cron_jobs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS required_secrets text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS required_migrations text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS backend_file_globs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS external_hosts text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS backend_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'fullstack';

COMMENT ON COLUMN public.modules.required_secrets IS
  'Secret NAMES only. Values never leave the prime; clones get empty shells.';
COMMENT ON COLUMN public.modules.backend_file_globs IS
  'Backend globs merged into file_globs at cascade time so edge functions and migrations reach the clone repo.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'modules_layer_check') THEN
    ALTER TABLE public.modules
      ADD CONSTRAINT modules_layer_check
      CHECK (layer IN ('frontend', 'backend', 'fullstack', 'shared'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_modules_layer ON public.modules(layer);
CREATE INDEX IF NOT EXISTS idx_modules_edge_functions ON public.modules USING GIN(edge_functions);
CREATE INDEX IF NOT EXISTS idx_modules_database_tables ON public.modules USING GIN(database_tables);

ALTER TABLE public.module_detection_runs
  ADD COLUMN IF NOT EXISTS edge_function_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS migration_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS database_object_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS secret_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backend_module_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backend_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.module_backend_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_run_id uuid REFERENCES public.module_detection_runs(id) ON DELETE CASCADE,
  module_id uuid REFERENCES public.modules(id) ON DELETE CASCADE,
  module_slug text NOT NULL,
  artifact_kind text NOT NULL,
  identifier text NOT NULL,
  file_path text,
  link_reason text,
  confidence text NOT NULL DEFAULT 'direct',
  shared_with_modules text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.module_backend_artifacts TO authenticated;
GRANT ALL ON public.module_backend_artifacts TO service_role;

CREATE INDEX IF NOT EXISTS idx_mba_run ON public.module_backend_artifacts(detection_run_id);
CREATE INDEX IF NOT EXISTS idx_mba_module ON public.module_backend_artifacts(module_id);
CREATE INDEX IF NOT EXISTS idx_mba_kind_ident ON public.module_backend_artifacts(artifact_kind, identifier);

ALTER TABLE public.module_backend_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view backend artifacts" ON public.module_backend_artifacts;
CREATE POLICY "Operators can view backend artifacts"
  ON public.module_backend_artifacts FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators can write backend artifacts" ON public.module_backend_artifacts;
CREATE POLICY "Operators can write backend artifacts"
  ON public.module_backend_artifacts FOR ALL
  TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

CREATE TABLE IF NOT EXISTS public.repo_blob_analysis (
  blob_sha text PRIMARY KEY,
  path text NOT NULL,
  kind text NOT NULL,
  analysis jsonb NOT NULL,
  byte_size integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.repo_blob_analysis TO authenticated;
GRANT ALL ON public.repo_blob_analysis TO service_role;

CREATE INDEX IF NOT EXISTS idx_repo_blob_analysis_last_seen ON public.repo_blob_analysis(last_seen_at);

ALTER TABLE public.repo_blob_analysis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can read blob analysis" ON public.repo_blob_analysis;
CREATE POLICY "Operators can read blob analysis"
  ON public.repo_blob_analysis FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators can write blob analysis" ON public.repo_blob_analysis;
CREATE POLICY "Operators can write blob analysis"
  ON public.repo_blob_analysis FOR ALL
  TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

CREATE OR REPLACE FUNCTION public.prune_repo_blob_analysis()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.repo_blob_analysis WHERE last_seen_at < now() - interval '90 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;