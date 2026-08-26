-- Bring every mirror clone's exclusion policy up to the current default set.
--
-- ## Why this migration exists at all
--
-- `DEFAULT_MIRROR_EXCLUSIONS` in `src/server/cascade/syncExclusions.pure.ts`
-- is the list this platform says a mirror needs, and `assertMirrorPolicy`'s own
-- refusal message tells an operator to "seed it from DEFAULT_MIRROR_EXCLUSIONS
-- before cascading" -- but nothing in the application ever did. The constant had
-- no caller outside its test. The rows in `clone_sync_exclusions` today were put
-- there by hand, which is exactly why they were incomplete.
--
-- Two paths were missing, and both were reverted by the mirror cascade of
-- prime@14af87a on 26 Aug 2026:
--
--   public/lead-magnet-embed.html
--       Served verbatim out of `public/`. Prime's copy hard-codes prime's
--       Supabase URL and prime's anon key, so between that cascade merging and
--       the repair, the lead-capture form on the clone's own domain posted
--       names, emails and phone numbers into the PRIME's database. The clone had
--       fixed this two days earlier; the cascade wrote prime's copy back over it
--       because no rule here named the path.
--
--   src/lib/reportTemplate/__tests__/renderAssetNormalisation.spec.ts
--       The clone derives the fixture's project from SUPABASE_URL; prime
--       hard-codes its own. On any clone with its own backend prime's literal is
--       a foreign origin, the compiler correctly drops it, and the assertion
--       fails -- which is how this was found: the `verify` job going red.
--
-- `.gitleaks.toml` is here for the same class of reason: it allowlists THIS
-- deployment's publishable anon key by literal, so prime's copy would allow
-- prime's key and re-flag the clone's.
--
-- ## The list is generated, not transcribed
--
-- Every row below is emitted from `DEFAULT_MIRROR_EXCLUSIONS`, and
-- `syncExclusions.test.ts` re-reads this file and fails if the two disagree.
-- A hand-maintained second copy of a safety list is how the first two gaps got
-- there; there is one authority and this is a projection of it.
--
-- ## Idempotent, additive, and it removes nothing
--
-- `ON CONFLICT DO NOTHING` on the (clone_id, pattern) unique constraint, so an
-- operator's own additions and any hand edit to an existing note both survive a
-- replay. Nothing is deleted: an exclusion an operator added deliberately is not
-- this migration's to withdraw.

INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT c.id, d.pattern, d.reason, d.note
FROM public.clones c
CROSS JOIN (VALUES
    ('src/integrations/supabase/env.ts', 'protected', 'Names the Supabase project this deployment talks to. Prime''s version points at prime''s database.'),
    ('supabase/config.toml', 'protected', 'Carries the clone''s own project ref and per-function verify_jwt declarations.'),
    ('supabase/.temp/**', 'protected', 'Tracked upstream and holds the prime''s project ref; backendIsolation.spec.ts asserts it stays untracked here.'),
    ('vite.config.ts', 'protected', 'Pins VITE_CLIENT_FACING and defines __CLIENT_FACING__ for this repository.'),
    ('vercel.json', 'protected', 'This deployment''s hosting config.'),
    ('.env.example', 'protected', 'Documents the clone''s own variables.'),
    ('.gitignore', 'protected', 'Keeps supabase/.temp untracked here.'),
    ('.gitleaks.toml', 'protected', 'Allowlists THIS deployment''s own publishable anon key by literal. Prime''s copy would allow prime''s key and re-flag the clone''s.'),
    ('.github/workflows/deploy-supabase-functions.yml', 'protected', 'Fail-closed guard against deploying into the wrong project.'),
    ('.github/workflows/apply-migration.yml', 'protected', 'Fail-closed guard against applying migrations to the wrong project.'),
    ('docs/CLIENT_FACING_MODE.md', 'protected', 'Describes this repository, not prime.'),
    ('src/App.tsx', 'manual_reconcile', 'Clone carries RouteExcludedFromBuild and __CLIENT_FACING__ gates prime does not. New upstream routes have to be brought across by hand.'),
    ('src/lib/clientFacing.ts', 'manual_reconcile', 'Clone hides a strict superset of prime''s paths.'),
    ('src/lib/__tests__/clientFacing.test.ts', 'manual_reconcile', 'Asserts the clone''s hiding decisions, which contradict prime''s.'),
    ('src/components/call-logs/CleanupTestCalls.tsx', 'manual_reconcile', 'Clone reads VITE_TEST_CALL_NUMBERS instead of hardcoding staff mobiles.'),
    ('public/lead-magnet-embed.html', 'manual_reconcile', 'Served verbatim from public/ and hard-codes a Supabase URL and anon key. Prime''s pair is prime''s project — this embed captured leads into the prime''s database from the clone''s own domain until it was fixed, and the next cascade wrote prime''s copy straight back over it.'),
    ('src/lib/reportTemplate/__tests__/renderAssetNormalisation.spec.ts', 'manual_reconcile', 'Clone derives PROJECT from SUPABASE_URL; prime hard-codes its own project. compileTemplateHtmlForPdf admits SUPABASE_URL and nothing else, so prime''s literal is a FOREIGN origin here and the fixture is correctly dropped — the assertion fails on any clone with its own backend.')
) AS d(pattern, reason, note)
WHERE c.sync_scope = 'mirror'
ON CONFLICT (clone_id, pattern) DO NOTHING;
