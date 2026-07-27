CREATE TABLE IF NOT EXISTS public.github_secret_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL CHECK (target_kind IN ('prime','clone')),
  clone_id uuid REFERENCES public.clones(id) ON DELETE CASCADE,
  owner text NOT NULL,
  repo text NOT NULL,
  written text[] NOT NULL DEFAULT '{}',
  skipped jsonb NOT NULL DEFAULT '[]'::jsonb,
  failed jsonb NOT NULL DEFAULT '[]'::jsonb,
  ok boolean NOT NULL,
  triggered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger_source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS github_secret_syncs_clone_idx
  ON public.github_secret_syncs(clone_id, created_at DESC);
CREATE INDEX IF NOT EXISTS github_secret_syncs_created_idx
  ON public.github_secret_syncs(created_at DESC);

GRANT SELECT ON public.github_secret_syncs TO authenticated;
GRANT ALL ON public.github_secret_syncs TO service_role;

ALTER TABLE public.github_secret_syncs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read secret syncs" ON public.github_secret_syncs
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY "service role manages secret syncs" ON public.github_secret_syncs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);