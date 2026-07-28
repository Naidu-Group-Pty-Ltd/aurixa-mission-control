-- Access grants for the restricted parts of the public pricing page.
--
-- Add-on modules, onboarding packages and report economics are commercial
-- detail. Anyone arriving from a workspace — a `?h=` handoff or a `?uid=`
-- billing link — is already a customer and sees them. Everyone else sees
-- nothing until an operator deliberately lets them in, and this table is how
-- that decision is recorded.
--
-- The grant id IS the token. It is a v4 UUID handed out in a link, so it is
-- unguessable, individually revocable, and every use is attributable to the
-- person the grant was minted for — which a shared password would not be.

CREATE TABLE IF NOT EXISTS public.storefront_access_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who this was issued to. Free text on purpose: a firm name, a person, a
  -- deal — whatever makes it recognisable when deciding whether to revoke.
  label        TEXT NOT NULL,
  note         TEXT,
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- NULL means it does not expire on its own. Prefer setting one.
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

ALTER TABLE public.storefront_access_grants ENABLE ROW LEVEL SECURITY;

-- Operators read; nobody reads it from the browser without a session. The
-- public access check runs service-role inside an edge route, never from a
-- client — a grant list is exactly what an attacker would want to enumerate.
DROP POLICY IF EXISTS "Operators read storefront access grants"
  ON public.storefront_access_grants;
CREATE POLICY "Operators read storefront access grants"
  ON public.storefront_access_grants FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

REVOKE ALL ON public.storefront_access_grants FROM PUBLIC, anon;
GRANT SELECT ON public.storefront_access_grants TO authenticated;
GRANT ALL    ON public.storefront_access_grants TO service_role;

DROP TRIGGER IF EXISTS storefront_access_grants_updated_at
  ON public.storefront_access_grants;
CREATE TRIGGER storefront_access_grants_updated_at
  BEFORE UPDATE ON public.storefront_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.storefront_access_grants IS
  'Operator-issued access to the restricted pricing sections (modules, onboarding, report economics). The row id is the token used in ?access=.';

NOTIFY pgrst, 'reload schema';
