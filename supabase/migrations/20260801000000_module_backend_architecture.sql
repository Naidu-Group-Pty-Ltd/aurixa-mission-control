-- Module backend architecture detection.
--
-- Until now `modules` described only the frontend: file_globs pointed at
-- src/routes and src/components, and resolved_files came from an ES import
-- walk. The edge functions a page invokes, the tables those functions read,
-- the migrations that create those tables, and the secrets they need were
-- never recorded — so a cascade pushed UI to a clone with no backend behind it.
--
-- These columns carry the resolved backend surface per module.

ALTER TABLE public.modules
  -- Edge function slugs this module needs deployed.
  ADD COLUMN IF NOT EXISTS edge_functions text[] NOT NULL DEFAULT '{}',
  -- Tables/views read or written (schema-qualified when not `public`).
  ADD COLUMN IF NOT EXISTS database_tables text[] NOT NULL DEFAULT '{}',
  -- Postgres functions invoked via .rpc().
  ADD COLUMN IF NOT EXISTS database_rpcs text[] NOT NULL DEFAULT '{}',
  -- Storage buckets touched.
  ADD COLUMN IF NOT EXISTS storage_buckets text[] NOT NULL DEFAULT '{}',
  -- pg_cron job names defined by this module's migrations.
  ADD COLUMN IF NOT EXISTS cron_jobs text[] NOT NULL DEFAULT '{}',
  -- Secret / env var NAMES required (never values).
  ADD COLUMN IF NOT EXISTS required_secrets text[] NOT NULL DEFAULT '{}',
  -- Migration file paths that declare this module's schema objects.
  ADD COLUMN IF NOT EXISTS required_migrations text[] NOT NULL DEFAULT '{}',
  -- Globs covering backend files, kept separate from file_globs so an operator
  -- can see (and the cascade can opt out of) the backend half.
  ADD COLUMN IF NOT EXISTS backend_file_globs text[] NOT NULL DEFAULT '{}',
  -- Third-party hosts this module's backend calls out to.
  ADD COLUMN IF NOT EXISTS external_hosts text[] NOT NULL DEFAULT '{}',
  -- Full linkage trace + counts, for UI drill-down and debugging.
  ADD COLUMN IF NOT EXISTS backend_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- frontend | backend | fullstack — backend-only modules have no route.
  ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'fullstack';

COMMENT ON COLUMN public.modules.required_secrets IS
  'Secret NAMES only. Values never leave the prime; clones get empty shells.';
COMMENT ON COLUMN public.modules.backend_file_globs IS
  'Backend globs merged into file_globs at cascade time so edge functions and migrations reach the clone repo.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'modules_layer_check'
  ) THEN
    ALTER TABLE public.modules
      ADD CONSTRAINT modules_layer_check
      CHECK (layer IN ('frontend', 'backend', 'fullstack', 'shared'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_modules_layer ON public.modules(layer);
CREATE INDEX IF NOT EXISTS idx_modules_edge_functions
  ON public.modules USING GIN(edge_functions);
CREATE INDEX IF NOT EXISTS idx_modules_database_tables
  ON public.modules USING GIN(database_tables);

-- ── Detection run counters ───────────────────────────────────────────

ALTER TABLE public.module_detection_runs
  ADD COLUMN IF NOT EXISTS edge_function_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS migration_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS database_object_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS secret_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backend_module_count integer NOT NULL DEFAULT 0,
  -- Repo-wide backend inventory summary for this run.
  ADD COLUMN IF NOT EXISTS backend_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Per-artifact linkage rows ────────────────────────────────────────
-- One row per (module, backend artifact). Lets the UI answer both
-- "what backend does this module need?" and "which modules share this table?"

CREATE TABLE IF NOT EXISTS public.module_backend_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_run_id uuid REFERENCES public.module_detection_runs(id) ON DELETE CASCADE,
  module_id uuid REFERENCES public.modules(id) ON DELETE CASCADE,
  module_slug text NOT NULL,
  -- edge_function | table | rpc | migration | secret | storage_bucket | cron_job | external_host
  artifact_kind text NOT NULL,
  identifier text NOT NULL,
  file_path text,
  -- How the link was established (call site, invoked-by chain, slug literal…).
  link_reason text,
  -- 'direct' when unambiguous, 'indirect' for slug-literal matches.
  confidence text NOT NULL DEFAULT 'direct',
  -- Other module slugs that also claim this artifact.
  shared_with_modules text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mba_run ON public.module_backend_artifacts(detection_run_id);
CREATE INDEX IF NOT EXISTS idx_mba_module ON public.module_backend_artifacts(module_id);
CREATE INDEX IF NOT EXISTS idx_mba_kind_ident
  ON public.module_backend_artifacts(artifact_kind, identifier);

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

-- ── Content-addressed parse cache ────────────────────────────────────
-- A full backend scan of the prime reads ~1,400 blobs (756 migrations +
-- 619 function files). Blobs are content-addressed, so a parse result keyed
-- by git blob SHA stays valid forever and re-runs only pay for what changed.

CREATE TABLE IF NOT EXISTS public.repo_blob_analysis (
  blob_sha text PRIMARY KEY,
  -- Last path this blob was seen at (informational; the SHA is the key).
  path text NOT NULL,
  -- migration | edge_function | edge_shared | frontend | config
  kind text NOT NULL,
  analysis jsonb NOT NULL,
  byte_size integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_repo_blob_analysis_last_seen
  ON public.repo_blob_analysis(last_seen_at);

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

-- Prune analyses not seen in 90 days; blobs that still exist get re-parsed
-- once and re-cached.
CREATE OR REPLACE FUNCTION public.prune_repo_blob_analysis()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.repo_blob_analysis
    WHERE last_seen_at < now() - interval '90 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
