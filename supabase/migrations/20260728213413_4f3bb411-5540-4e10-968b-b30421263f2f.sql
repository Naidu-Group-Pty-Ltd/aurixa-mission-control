CREATE TABLE IF NOT EXISTS public.storefront_access_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT NOT NULL,
  note         TEXT,
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  use_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storefront_access_grants_live_idx
  ON public.storefront_access_grants (created_at DESC)
  WHERE revoked_at IS NULL;

REVOKE ALL ON public.storefront_access_grants FROM PUBLIC, anon;
GRANT SELECT ON public.storefront_access_grants TO authenticated;
GRANT ALL    ON public.storefront_access_grants TO service_role;

ALTER TABLE public.storefront_access_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read storefront access grants"
  ON public.storefront_access_grants;
CREATE POLICY "Operators read storefront access grants"
  ON public.storefront_access_grants FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP TRIGGER IF EXISTS storefront_access_grants_updated_at
  ON public.storefront_access_grants;
CREATE TRIGGER storefront_access_grants_updated_at
  BEFORE UPDATE ON public.storefront_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.storefront_access_grants IS
  'Operator-issued access to the restricted pricing sections. The row id is the token used in ?access=.';

NOTIFY pgrst, 'reload schema';