-- @asserts none:removes default table grants; a GRANT is not observable through PostgREST, so nothing here can be asserted by effect
--
-- Take back what `pg_default_acl` handed out.
--
-- `20260828020000` created `public.migration_assertion_checks` and granted
-- `SELECT` to `authenticated`, intending that to be the whole story. It was
-- not. Measured immediately after it applied:
--
--   relacl = {postgres=arwdDxtm/postgres,
--             anon=arwdDxtm/postgres,
--             authenticated=arwdDxtm/postgres,
--             service_role=arwdDxtm/postgres,
--             sandbox_exec=ar/postgres}
--
-- `ALTER DEFAULT PRIVILEGES` on this database grants **ALL** on every new
-- `public` table to `anon`, `authenticated`, `service_role` and `sandbox_exec`.
-- Writing a `GRANT` does not narrow that; only a `REVOKE` does. This is the
-- same landmine `20260828030000` documents at length and then defuses for the
-- migration queue -- and the very next table forgot it, which is precisely why
-- that migration says a control which must be remembered every time is not a
-- control.
--
-- NOT A LIVE HOLE, AND THAT DISTINCTION MATTERS. The table has RLS on with one
-- policy (`FOR SELECT TO authenticated USING (is_admin(auth.uid()))`), so
-- `anon` reads nothing and no API role can write: with RLS enabled, a command
-- no policy covers is denied. What the stray grants create is a table one
-- careless future policy away from being writable by the browser -- and this is
-- evidence about whether migrations applied, so anyone who can edit it can make
-- a missing migration look present.
--
-- Grants are the belt; RLS is the braces. Shipping only the braces because they
-- happen to hold is how the belt is never noticed missing.

REVOKE ALL ON public.migration_assertion_checks FROM PUBLIC;
DO $revoke$
DECLARE
  v_role text;
BEGIN
  -- Conditionally, because this corpus replays onto clone databases and
  -- `sandbox_exec` is a Lovable Cloud role a plain Supabase project does not
  -- have. `REVOKE ... FROM <missing role>` aborts the whole replay.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'sandbox_exec']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.migration_assertion_checks FROM %I', v_role);
    END IF;
  END LOOP;
END $revoke$;

-- What was intended in the first place. `authenticated` reads, and the RLS
-- policy decides which rows; the grant confers the privilege and the policy
-- decides the scope, and this table needs both to be narrow. The worker writes
-- as `service_role`, which RLS does not filter -- so its grants are the only
-- thing bounding it, and they stop at what the worker actually does.
GRANT SELECT ON public.migration_assertion_checks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.migration_assertion_checks TO service_role;

-- Editing a verdict edits the evidence. Nothing but the drift worker has any
-- business writing here, and it holds service_role.
