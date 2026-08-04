-- Market News Feed (market-updates) bundling correction.
--
-- The tiered-entitlement rollout fixes the commercial rule for Market
-- Updates: included in SCALE only, independently purchasable as an add-on by
-- Launch and Growth (matching Commercial / Industrial). The catalogue row
-- previously said Growth included it, which the code catalogue
-- (src/lib/pricing/aurixa-catalog.ts) no longer does — this keeps the DB
-- row in step.
--
-- Idempotent and reversible: re-running is a no-op; restoring the old rule
-- is a single UPDATE back to '{growth,scale}'. Existing clone_addon_purchases
-- rows are untouched — a Growth workspace that separately bought the add-on
-- keeps it, and a Growth workspace relying on tier bundling should be
-- granted the add-on by an operator before this ships (see the rollout notes
-- in the PR).

UPDATE public.addon_modules
SET included_in_plans = ARRAY['scale']::text[]
WHERE slug = 'market-updates'
  AND included_in_plans IS DISTINCT FROM ARRAY['scale']::text[];

-- Keep the plan/sub-module entitlement matrix consistent where it exists.
-- (plan_module_entitlements rows are per sub-module; market-updates has no
-- sub-module rows today, so nothing to change there.)
