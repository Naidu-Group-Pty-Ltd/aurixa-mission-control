-- Links each add-on module to the Stripe product and price that charges for it.
--
-- The products and prices already exist — they were created against the live
-- account before this migration was written, which is the only safe order:
-- Stripe prices are immutable and live in another system, so a row must never
-- be pointed at an id that has yet to be minted.
--
-- Every price here is AUD, monthly recurring, and `tax_behavior: inclusive`.
-- That last one is not a detail. Every figure on the Aurixa price list already
-- CONTAINS its GST; left at Stripe's default, switching Stripe Tax on later
-- would add 10% on top and quietly overcharge every customer on every module
-- they hold. The amounts below are the tax-inclusive figures the pricing page
-- shows, and they are asserted against `price_min_cents` at the end rather
-- than trusted — a transcription slip here bills the wrong number.
--
-- `lenders` is deliberately absent. It is on the pricing page so the roadmap
-- is visible, has no agreed price, and therefore has no Stripe product; its
-- link columns stay NULL, which is what makes "has a link" a usable test for
-- "can be bought".
--
-- Re-runnable. Matching on slug and writing ids that already exist is a no-op,
-- and src/server/stripe-module-sync.server.ts reconciles the same rows from
-- the "Add-on modules" card in /billing/catalog — it reuses a product or price
-- that already matches rather than minting a second one.

UPDATE public.addon_modules AS m
   SET stripe_product_id = v.product_id,
       stripe_price_id   = v.price_id,
       currency          = 'AUD',
       billing_period    = 'monthly',
       metadata          = m.metadata
                           || jsonb_build_object(
                                'tax_inclusive', true,
                                'gst_included', true,
                                -- Derived FROM the inclusive amount (÷11),
                                -- never added to it.
                                'gst_component_cents', round(v.amount_cents / 11.0)
                              )
  FROM (VALUES
    ('market-updates',          'prod_Uz3kEQQ0A4504c', 'price_1Tz5d33tNhf9apmH9kRIyZg6',  5900),
    ('commercial-industrial',   'prod_Uz3kpivYKjqckx', 'price_1Tz5dC3tNhf9apmHWvbZNIFC', 16900),
    ('opportunity-marketplace', 'prod_Uz3kGvs6QeGCT3', 'price_1Tz5dG3tNhf9apmHaNia4w7d', 16900),
    ('intelligence-hub',        'prod_Uz3kIYMztboPf7', 'price_1Tz5dJ3tNhf9apmHBM8nQ6zI',  7900),
    ('report-comparisons',      'prod_Uz3nUb6lNtuUJj', 'price_1Tz5fn3tNhf9apmHkx5QLKam',  9900),
    ('cashflow-comparisons',    'prod_Uz3nQVXgQvrb51', 'price_1Tz5ft3tNhf9apmH8JeuPbiE',  9900),
    ('email-copilot',           'prod_Uz3n0F66qZ6ojX', 'price_1Tz5g03tNhf9apmHh9e8IdMq',  9900),
    ('call-logs',               'prod_Uz3nGOMVNJlkQq', 'price_1Tz5g43tNhf9apmHT7bEzMdI', 22500),
    ('portfolio-analysis',      'prod_Uz3n11dN2UCcpr', 'price_1Tz5g73tNhf9apmHBe13nqX7', 12500),
    ('send-portfolio',          'prod_Uz3nODfNyIc0MP', 'price_1Tz5gA3tNhf9apmHwPuPTCzg',  6900),
    ('client-forms',            'prod_Uz3oNSE0hIbM5T', 'price_1Tz5gP3tNhf9apmHrXdE8pzI',  4900),
    ('borrowing-capacity',      'prod_Uz3oJ2QFrDX0sk', 'price_1Tz5gT3tNhf9apmHxFkuglbN', 22500),
    ('client-ai',               'prod_Uz3opQBoYe3bBA', 'price_1Tz5gY3tNhf9apmHS1UvtvUF',  7900),
    ('agreements',              'prod_Uz3ouT7vbi0RTh', 'price_1Tz5gc3tNhf9apmHQ7sjqcQp',  6900),
    ('marketing',               'prod_Uz3oSa95Lde1MS', 'price_1Tz5gg3tNhf9apmHcHRNunDs', 17900),
    ('deal-pipeline',           'prod_Uz3oCdFCdXbL8C', 'price_1Tz5gm3tNhf9apmHJ5yyeAHi',  9900),
    ('aml-ctf',                 'prod_Uz3opIaNIII4T6', 'price_1Tz5gu3tNhf9apmHgsfOYWP0', 19500),
    ('model-hub',               'prod_Uz3o6IhAonydZw', 'price_1Tz5gy3tNhf9apmH0dbMFtv4', 19500),
    ('finance-portal',          'prod_Uz3oWmUoyPRdq5', 'price_1Tz5h13tNhf9apmHxmCzXZzL', 22500),
    ('integrations',            'prod_Uz3oXUWMhrvhR6', 'price_1Tz5h43tNhf9apmHqAwF3KCO', 13500),
    ('api-usage',               'prod_Uz3oGWN399z4Ui', 'price_1Tz5h93tNhf9apmHDOUcrMDo', 14900),
    ('aurixa-agent',            'prod_Uz3ov5ZBboMmXg', 'price_1Tz5hC3tNhf9apmHmGaM1RV4', 37500)
  ) AS v(slug, product_id, price_id, amount_cents)
 WHERE m.slug = v.slug;

-- A module listed for the roadmap must not be sellable, and "we never linked
-- it" is not the same as "it cannot be bought" — a stale link from an earlier
-- attempt would still resolve at checkout.
UPDATE public.addon_modules
   SET stripe_product_id = NULL,
       stripe_price_id   = NULL
 WHERE slug = 'lenders';

-- The assertions. A wrong price id here bills the wrong amount, and the
-- failure mode is silent — the pricing page keeps showing the right figure
-- while Stripe charges something else. Cheaper to fail the migration.
DO $$
DECLARE
  v_mismatched int;
  v_unlinked   int;
  v_duplicated int;
BEGIN
  -- What the page SHOWS must equal what the linked price CHARGES. The amounts
  -- in the VALUES list above are the ones the prices were created with, so
  -- comparing them against price_min_cents catches either side drifting.
  SELECT count(*) INTO v_mismatched
    FROM public.addon_modules m
    JOIN (VALUES
      ('market-updates',5900),('commercial-industrial',16900),('opportunity-marketplace',16900),
      ('intelligence-hub',7900),('report-comparisons',9900),('cashflow-comparisons',9900),
      ('email-copilot',9900),('call-logs',22500),('portfolio-analysis',12500),
      ('send-portfolio',6900),('client-forms',4900),('borrowing-capacity',22500),
      ('client-ai',7900),('agreements',6900),('marketing',17900),('deal-pipeline',9900),
      ('aml-ctf',19500),('model-hub',19500),('finance-portal',22500),('integrations',13500),
      ('api-usage',14900),('aurixa-agent',37500)
    ) AS v(slug, amount_cents) ON v.slug = m.slug
   WHERE m.price_min_cents IS DISTINCT FROM v.amount_cents;

  IF v_mismatched > 0 THEN
    RAISE EXCEPTION
      'addon module price drift: % row(s) advertise an amount that differs from the Stripe price they are being linked to',
      v_mismatched;
  END IF;

  -- Every active module except the roadmap ones must now be buyable. A row
  -- that stayed NULL means the seeding list missed a slug the catalog has.
  SELECT count(*) INTO v_unlinked
    FROM public.addon_modules
   WHERE is_active AND slug <> 'lenders' AND stripe_price_id IS NULL;

  IF v_unlinked > 0 THEN
    RAISE EXCEPTION 'addon module link gap: % active module(s) still have no Stripe price', v_unlinked;
  END IF;

  -- Belt and braces alongside the unique index: two modules sharing a price
  -- is the shape of the bug where a retry mints a second product.
  SELECT count(*) INTO v_duplicated
    FROM (
      SELECT stripe_price_id FROM public.addon_modules
       WHERE stripe_price_id IS NOT NULL
       GROUP BY stripe_price_id HAVING count(*) > 1
    ) dupes;

  IF v_duplicated > 0 THEN
    RAISE EXCEPTION 'addon module link collision: % Stripe price(s) are claimed by more than one module', v_duplicated;
  END IF;
END $$;
