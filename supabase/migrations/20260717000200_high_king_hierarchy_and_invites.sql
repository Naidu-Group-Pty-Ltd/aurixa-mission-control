-- ============================================================================
-- THE HIGH KING SEAT + CLOSED-SYSTEM INVITES
--
-- Hierarchy becomes:
--   high_king   (1000) — singular sovereign seat; full oversight of all tiers
--   super_admin  (100) — full admin controls; may issue outbound invites
--   admin         (80)
--   operator      (50)
--   user          (10)
--
-- Sign-up is deprecated: new accounts are created exclusively through invite
-- links minted by super_admins (and the High King). The founding super_admin
-- is promoted to the High King seat.
-- ============================================================================

-- ─── 1. Role levels ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.role_level(_role public.app_role)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  RETURN CASE _role::text
    WHEN 'high_king'   THEN 1000
    WHEN 'super_admin' THEN 100
    WHEN 'admin'       THEN 80
    WHEN 'operator'    THEN 50
    WHEN 'user'        THEN 10
    ELSE 0
  END;
END;
$$;

-- ─── 2. has_role becomes hierarchy-aware ────────────────────────────────────
-- Previously an exact row match, which meant a super_admin (whose only row is
-- 'super_admin') FAILED every has_role(uid,'admin') policy across ~30 tables.
-- A role check now passes when the caller's highest tier meets or exceeds the
-- required tier, which matches how every policy in this schema actually uses
-- it. All existing has_role(...) policies inherit the fix without a rewrite.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.highest_role_level(_user_id) >= public.role_level(_role)
$$;

-- ─── 3. Tier predicates as level checks ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_operator(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.highest_role_level(_user_id) >= 50
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.highest_role_level(_user_id) >= 80
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.highest_role_level(_user_id) >= 100
$$;

CREATE OR REPLACE FUNCTION public.is_high_king(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.highest_role_level(_user_id) >= 1000
$$;

-- ─── 4. Bootstrap: the first user takes the High King seat ──────────────────
CREATE OR REPLACE FUNCTION public.bootstrap_first_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE role IN ('high_king', 'super_admin')
  ) THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'high_king');
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 5. Retire the super_admin guards, crown the founding super_admin ───────
-- The old guards protected "the last super_admin". With a High King above the
-- super_admins, continuity of the realm is anchored to the throne instead —
-- super_admins become grantable/revocable seats.
DROP TRIGGER IF EXISTS guard_last_super_admin_delete ON public.user_roles;
DROP TRIGGER IF EXISTS guard_last_super_admin_update ON public.user_roles;
DROP FUNCTION IF EXISTS public.guard_last_super_admin();

UPDATE public.user_roles
SET role = 'high_king', assigned_by = NULL, assigned_at = now()
WHERE id = (
  SELECT id FROM public.user_roles
  WHERE role = 'super_admin'
  ORDER BY created_at ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'high_king');

-- ─── 6. Guard the throne ────────────────────────────────────────────────────
-- (a) The system must never be left without a High King.
CREATE OR REPLACE FUNCTION public.guard_last_high_king()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.role = 'high_king' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE role = 'high_king' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'The High King seat cannot be vacated — the system must always have a High King';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_last_high_king_delete ON public.user_roles;
CREATE TRIGGER guard_last_high_king_delete
  BEFORE DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.guard_last_high_king();

DROP TRIGGER IF EXISTS guard_last_high_king_update ON public.user_roles;
CREATE TRIGGER guard_last_high_king_update
  BEFORE UPDATE ON public.user_roles
  FOR EACH ROW
  WHEN (OLD.role = 'high_king' AND NEW.role <> 'high_king')
  EXECUTE FUNCTION public.guard_last_high_king();

-- (b) The seat is singular: it can never be granted while occupied, even by
-- the service role. Succession is a deliberate database operation, not an
-- application feature.
CREATE OR REPLACE FUNCTION public.guard_singular_high_king()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE role = 'high_king' AND user_id <> NEW.user_id
  ) THEN
    RAISE EXCEPTION 'The High King seat is singular — it cannot be granted while occupied';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_singular_high_king ON public.user_roles;
CREATE TRIGGER guard_singular_high_king
  BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW
  WHEN (NEW.role = 'high_king')
  EXECUTE FUNCTION public.guard_singular_high_king();

-- ─── 7. Closed-system invites ───────────────────────────────────────────────
-- Outbound invite links minted by super_admins (and the High King). The raw
-- token is shown once at mint time; only its SHA-256 hash is stored. Accepting
-- an invite is handled server-side with the service role (no anon sign-up).
CREATE TABLE public.user_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  -- Optional lock: when set, only this email may redeem the invite.
  email TEXT,
  -- Role granted on acceptance. Never high_king (the seat is seeded, not granted).
  role public.app_role NOT NULL DEFAULT 'user' CHECK (role <> 'high_king'),
  note TEXT,
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.user_invites ENABLE ROW LEVEL SECURITY;

-- Issuers can only mint invites for roles they outrank (same rule as direct
-- role assignment): super_admin (100) may invite up to admin; high_king (1000)
-- may invite up to super_admin.
CREATE POLICY "Super admins can read invites"
  ON public.user_invites FOR SELECT TO authenticated
  USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Super admins can issue invites within their rank"
  ON public.user_invites FOR INSERT TO authenticated
  WITH CHECK (
    public.is_super_admin(auth.uid())
    AND invited_by = auth.uid()
    AND public.can_assign_role(auth.uid(), role)
  );

CREATE POLICY "Super admins can revoke invites"
  ON public.user_invites FOR UPDATE TO authenticated
  USING (public.is_super_admin(auth.uid()));

CREATE TRIGGER update_user_invites_updated_at
  BEFORE UPDATE ON public.user_invites
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_user_invites_created ON public.user_invites(created_at DESC);
CREATE INDEX idx_user_invites_expires ON public.user_invites(expires_at);
