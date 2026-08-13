-- Support-assistant activity feed.
--
-- The Support Portal's screening assistant now forwards every ask —
-- answered, refused, or escalated — with the workspace and user identity
-- the portal carried from the dashboard. One row per question gives
-- operators per-tenant deflection visibility: what people ask, what the
-- assistant did about it, and which conversations turned into tickets.
-- Signed machine-to-machine only (the same support-portal ingest key as
-- tickets); nothing here is browser-writable.

CREATE TABLE IF NOT EXISTS public.support_assistant_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  user_external_id TEXT,
  question TEXT NOT NULL,
  mode TEXT NOT NULL,
  escalated BOOLEAN NOT NULL DEFAULT false,
  escalate_reason TEXT,
  latency_ms INT,
  source TEXT,
  verified_source BOOLEAN NOT NULL DEFAULT false,
  asked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_assistant_activity_created_idx
  ON public.support_assistant_activity(created_at DESC);

CREATE INDEX IF NOT EXISTS support_assistant_activity_workspace_idx
  ON public.support_assistant_activity(workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

GRANT SELECT ON public.support_assistant_activity TO authenticated;
GRANT ALL ON public.support_assistant_activity TO service_role;
ALTER TABLE public.support_assistant_activity ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "support_assistant_activity read operator+" ON public.support_assistant_activity
    FOR SELECT TO authenticated
    USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Writes come only from the ingest route via the service role.

-- Questions age out: 90 days is enough to spot deflection patterns and
-- recurring pain, and support text should not accumulate indefinitely.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE WARNING 'pg_cron not installed - assistant activity purge NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('support-assistant-activity-purge')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'support-assistant-activity-purge');

  PERFORM cron.schedule(
    'support-assistant-activity-purge', '25 3 * * *',
    $purge$
    DELETE FROM public.support_assistant_activity WHERE created_at < now() - interval '90 days';
    $purge$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'assistant activity purge NOT scheduled (%).', SQLERRM;
END $$;
