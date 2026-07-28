-- Report cost index: adopt the reviewed credit values.
--
-- Eight of the twenty-one metered products move; the other thirteen were
-- reviewed and left where they are. Verified before writing that every
-- "current" figure in the review matched the live table exactly, so these
-- deltas apply to the prices actually in force rather than to a stale copy.
--
--   Scenario Model                          4  ->  5
--   Investment Report - Compass            12  -> 13
--   Investment Report - Snapshot            4  ->  5
--   Suburb Report - Compass                10  -> 13
--   Postcode Report - Compass              10  -> 13
--   AML - Identity Check                    4  ->  5
--   AML - Screening Check                   4  ->  5
--   Market Intelligence Report              6  ->  8
--
-- Both `credit_cost` and `metadata.default_credit_cost` move together,
-- because these are the final values rather than a temporary override. Moving
-- only the first would leave every changed row showing as "off default" in
-- Mission Control forever, and the per-row Reset button would quietly restore
-- the old price.
--
-- `updated_at` is stamped explicitly: the public catalog derives its
-- reports_version from MAX(updated_at), and that version is how clones decide
-- whether a refresh actually changed anything. Without it a clone could keep
-- serving the old prices from cache.

WITH reviewed(slug, credit_cost) AS (
  VALUES
    ('scenario-model', 5)  -- Scenario Model: 4 -> 5,
    ('report.investment.compass', 13)  -- Investment Report — Compass: 12 -> 13,
    ('report.investment.snapshot', 5)  -- Investment Report — Snapshot: 4 -> 5,
    ('report.suburb.compass', 13)  -- Suburb Report — Compass: 10 -> 13,
    ('report.postcode.compass', 13)  -- Postcode Report — Compass: 10 -> 13,
    ('aml_identity_check', 5)  -- AML — Identity Check: 4 -> 5,
    ('aml_screening_check', 5)  -- AML — Screening Check: 4 -> 5,
    ('report.market-intelligence', 8)  -- Market Intelligence Report: 6 -> 8
)
UPDATE public.report_credit_costs AS r
   SET credit_cost = v.credit_cost,
       metadata    = COALESCE(r.metadata, '{}'::jsonb)
                     || jsonb_build_object('default_credit_cost', v.credit_cost),
       updated_at  = now()
  FROM reviewed AS v
 WHERE r.slug = v.slug
   AND (r.credit_cost IS DISTINCT FROM v.credit_cost
        OR r.metadata->>'default_credit_cost' IS DISTINCT FROM v.credit_cost::text);

-- Fail loudly rather than ship a half-applied price list: every reviewed slug
-- must exist and now hold its reviewed value.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(v.slug::text, ', ')
    INTO missing
    FROM (VALUES
    ('scenario-model', 5)  -- Scenario Model: 4 -> 5,
    ('report.investment.compass', 13)  -- Investment Report — Compass: 12 -> 13,
    ('report.investment.snapshot', 5)  -- Investment Report — Snapshot: 4 -> 5,
    ('report.suburb.compass', 13)  -- Suburb Report — Compass: 10 -> 13,
    ('report.postcode.compass', 13)  -- Postcode Report — Compass: 10 -> 13,
    ('aml_identity_check', 5)  -- AML — Identity Check: 4 -> 5,
    ('aml_screening_check', 5)  -- AML — Screening Check: 4 -> 5,
    ('report.market-intelligence', 8)  -- Market Intelligence Report: 6 -> 8
    ) AS v(slug, credit_cost)
    LEFT JOIN public.report_credit_costs r ON r.slug = v.slug
   WHERE r.slug IS NULL OR r.credit_cost <> v.credit_cost;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'report cost index not fully applied for: %', missing;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
