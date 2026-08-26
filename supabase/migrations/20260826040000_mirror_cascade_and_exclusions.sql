-- A cascade that can reach a mirror clone, and a list of what it must not touch.
--
-- WHAT WAS ALREADY TRUE. `/hooks/github` has verified and accepted every push
-- to prime's default branch since 2026-04-23, and fired a cascade for each one.
-- All 1,553 of them were skipped by `createCascadeForAllClones` with the same
-- reason, recorded in audit_log: "No clones registered". `cascade_events` has
-- zero rows. The pipeline is not broken and never was; it has been running into
-- an empty registry for four months, which is why 159 files of drift
-- accumulated between prime and npc-client-dashboard and had to be moved by
-- hand.
--
-- WHY REGISTERING A CLONE IS NOT ENOUGH. The engine cascades the file globs of
-- the modules INSTALLED on a clone. A mirror has no modules — it is the whole
-- application with one build flag flipped — so a registered mirror with no
-- `clone_modules` rows still skips, now saying "No installed modules". Scope
-- has to be able to say "the whole tree".
--
-- AND WHY THE WHOLE TREE IS DANGEROUS. Inside that tree are files whose entire
-- purpose is to differ. `src/integrations/supabase/env.ts` names the Supabase
-- project the deployment talks to, and its own header records what happened the
-- last time it resolved to prime's: the deployed client dashboard served the
-- PRIME's production database and signing in authenticated against real staff
-- accounts. A cascade that overwrites it does not fail — it succeeds, reports
-- green, and redeploys. So the exclusions are a table an operator can read,
-- enforced before the blob is written, and read fail-closed: an exclusion set
-- that could not be READ is not an empty one.

-- ── Scope ───────────────────────────────────────────────────────────────────
-- Deliberately a CHECK rather than an enum: `cascade_mode` and `sync_status`
-- are enums this schema already ships, and adding a value to a Postgres enum
-- cannot be done inside the same transaction that uses it, which has bitten
-- this repo's migration replay before.
ALTER TABLE public.clones
  ADD COLUMN IF NOT EXISTS sync_scope TEXT NOT NULL DEFAULT 'modules';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clones_sync_scope_check'
  ) THEN
    ALTER TABLE public.clones
      ADD CONSTRAINT clones_sync_scope_check
      CHECK (sync_scope IN ('modules', 'mirror'));
  END IF;
END $$;

COMMENT ON COLUMN public.clones.sync_scope IS
  'modules = cascade only the file globs of installed modules (the default, and '
  'what every clone did before this column existed). mirror = cascade the whole '
  'prime tree by blob-SHA diff, minus clone_sync_exclusions.';

-- ── What the cascade must not write ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clone_sync_exclusions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clone_id UUID NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  -- Same glob dialect the cascade uses to SELECT files (`lib/module-globs`),
  -- imported by both sides rather than re-implemented.
  pattern TEXT NOT NULL,
  -- protected        = the clone owns this file; a difference is not news.
  -- manual_reconcile = the clone's version is a deliberate superset of prime's;
  --                    withheld from the commit AND named in the pull request,
  --                    because silently skipping it means the clone never
  --                    learns about a new route.
  reason TEXT NOT NULL DEFAULT 'protected',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clone_sync_exclusions_reason_check
    CHECK (reason IN ('protected', 'manual_reconcile')),
  CONSTRAINT clone_sync_exclusions_pattern_not_blank
    CHECK (length(btrim(pattern)) > 0),
  CONSTRAINT clone_sync_exclusions_unique UNIQUE (clone_id, pattern)
);

ALTER TABLE public.clone_sync_exclusions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can read clone_sync_exclusions" ON public.clone_sync_exclusions;
CREATE POLICY "Operators can read clone_sync_exclusions"
  ON public.clone_sync_exclusions FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators can write clone_sync_exclusions" ON public.clone_sync_exclusions;
CREATE POLICY "Operators can write clone_sync_exclusions"
  ON public.clone_sync_exclusions FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP TRIGGER IF EXISTS update_clone_sync_exclusions_updated_at ON public.clone_sync_exclusions;
CREATE TRIGGER update_clone_sync_exclusions_updated_at
  BEFORE UPDATE ON public.clone_sync_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Read on every cascade, per clone. WP-27 indexed the cascade-bearing foreign
-- keys for exactly this reason.
CREATE INDEX IF NOT EXISTS idx_clone_sync_exclusions_clone_id
  ON public.clone_sync_exclusions(clone_id);

-- ── One cascade per prime commit ────────────────────────────────────────────
-- A merged pull request produces BOTH a `pull_request.closed` delivery and the
-- `push` that the merge itself makes, and both now create cascades. They carry
-- the same head SHA, so the SHA is what decides: whichever delivery arrives
-- first creates the event and the second finds it and stands down. Direct
-- pushes (this prime takes them from Lovable constantly) keep working because
-- they simply have no earlier event to find.
--
-- Scoped to `commit` on purpose. A MANUAL re-run of the same prime SHA is a
-- normal operator act -- it is how you retry a cascade after correcting an
-- exclusion -- and a unique index that refused it would turn a repair into a
-- constraint violation. Only the automated path is deduplicated.
--
-- Safe to create: `cascade_events` currently holds zero rows, so there is no
-- historical duplicate for this to fail on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cascade_events_commit_sha
  ON public.cascade_events (source_sha)
  WHERE source_sha IS NOT NULL AND "trigger" = 'commit';

COMMENT ON INDEX public.uq_cascade_events_commit_sha IS
  'One automatic cascade per prime SHA. The webhook looks for an existing event '
  'before inserting; this is the backstop for two deliveries racing, and the '
  'insert path treats its violation as "already cascaded" rather than an error.';
