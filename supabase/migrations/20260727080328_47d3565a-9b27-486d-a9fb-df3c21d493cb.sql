
-- 1) security_intake_sources
CREATE TABLE IF NOT EXISTS public.security_intake_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('codex','manual','ticketing','generic')),
  hmac_secret TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_intake_sources TO authenticated;
GRANT ALL ON public.security_intake_sources TO service_role;

ALTER TABLE public.security_intake_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intake_sources_admin_read" ON public.security_intake_sources;
CREATE POLICY "intake_sources_admin_read" ON public.security_intake_sources
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "intake_sources_admin_write" ON public.security_intake_sources;
CREATE POLICY "intake_sources_admin_write" ON public.security_intake_sources
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS update_security_intake_sources_updated_at ON public.security_intake_sources;
CREATE TRIGGER update_security_intake_sources_updated_at
  BEFORE UPDATE ON public.security_intake_sources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) security_external_tickets
CREATE TABLE IF NOT EXISTS public.security_external_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codex_finding_id UUID REFERENCES public.codex_findings(id) ON DELETE CASCADE,
  source_slug TEXT NOT NULL REFERENCES public.security_intake_sources(slug) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_slug, provider, external_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_external_tickets TO authenticated;
GRANT ALL ON public.security_external_tickets TO service_role;

ALTER TABLE public.security_external_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "external_tickets_operator_read" ON public.security_external_tickets;
CREATE POLICY "external_tickets_operator_read" ON public.security_external_tickets
  FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "external_tickets_admin_write" ON public.security_external_tickets;
CREATE POLICY "external_tickets_admin_write" ON public.security_external_tickets
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS update_security_external_tickets_updated_at ON public.security_external_tickets;
CREATE TRIGGER update_security_external_tickets_updated_at
  BEFORE UPDATE ON public.security_external_tickets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3) Extend codex_findings
ALTER TABLE public.codex_findings
  ADD COLUMN IF NOT EXISTS source_slug TEXT,
  ADD COLUMN IF NOT EXISTS external_ticket_url TEXT;

-- 4) Seed built-in sources (codex + manual). Do not overwrite HMAC secrets if already set.
INSERT INTO public.security_intake_sources (slug, name, kind, active, metadata)
VALUES
  ('codex', 'Codex Security (built-in)', 'codex', true, '{"built_in": true}'::jsonb),
  ('manual', 'Manual operator intake', 'manual', true, '{"built_in": true}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
