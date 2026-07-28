-- The eight-stage top-up ladder, from the signed-off pricing sheet.
--
-- Every price here is tax-INCLUSIVE, matching the sheet's own heading and the
-- seat plans: $20.90 is what the customer pays, and $1.90 of it is GST. The
-- ladder replaces credits-50/100/250/500, which priced credits roughly
-- seventy times higher (250 credits for $1,500, against $20.90 here) and were
-- never on the sheet.
--
-- The rows land INACTIVE and with no stripe_price_id, and that is the whole
-- point of doing it this way. `price_cents` is what the pricing page shows and
-- `stripe_price_id` is what Stripe charges; an active row missing the second
-- is a purchase button that fails with stripe_price_not_linked. So the catalog
-- entry is created first, the Stripe cutover mints a price for each pack, and
-- only that same cutover flips these active and retires the old four — which
-- keeps the four sellable in the meantime, so there is never a window with no
-- top-up on sale.
--
-- Retiring rather than deleting the old packs is deliberate: purchases point
-- at them.

INSERT INTO public.topup_packs
  (slug, name, tokens, price_cents, currency, expires_after_days, is_active, metadata)
VALUES
  ('topup-250',   '250 Credit Pack',     250,   2090, 'AUD', 30, false,
   '{"stage":1,"tax_inclusive":true,"gst_included":true,"best_for":"Emergency top-up"}'::jsonb),
  ('topup-500',   '500 Credit Pack',     500,   3850, 'AUD', 30, false,
   '{"stage":2,"tax_inclusive":true,"gst_included":true,"best_for":"Small reporting boost"}'::jsonb),
  ('topup-1000',  '1,000 Credit Pack',   1000,  7150, 'AUD', 30, false,
   '{"stage":3,"tax_inclusive":true,"gst_included":true,"best_for":"Light additional usage"}'::jsonb),
  ('topup-2500',  '2,500 Credit Pack',   2500, 16390, 'AUD', 30, false,
   '{"stage":4,"tax_inclusive":true,"gst_included":true,"best_for":"Regular reporting top-up"}'::jsonb),
  ('topup-5000',  '5,000 Credit Pack',   5000, 30690, 'AUD', 30, false,
   '{"stage":5,"tax_inclusive":true,"gst_included":true,"popular":true,"best_for":"Most popular"}'::jsonb),
  ('topup-7500',  '7,500 Credit Pack',   7500, 43890, 'AUD', 30, false,
   '{"stage":6,"tax_inclusive":true,"gst_included":true,"best_for":"Team reporting capacity"}'::jsonb),
  ('topup-10000', '10,000 Credit Pack', 10000, 54890, 'AUD', 30, false,
   '{"stage":7,"tax_inclusive":true,"gst_included":true,"best_for":"High-volume monthly overflow"}'::jsonb),
  ('topup-15000', '15,000 Credit Pack', 15000, 71390, 'AUD', 30, false,
   '{"stage":8,"tax_inclusive":true,"gst_included":true,"best_value":true,"best_for":"Best top-up value"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  name               = EXCLUDED.name,
  tokens             = EXCLUDED.tokens,
  price_cents        = EXCLUDED.price_cents,
  currency           = EXCLUDED.currency,
  expires_after_days = EXCLUDED.expires_after_days,
  metadata           = public.topup_packs.metadata || EXCLUDED.metadata,
  -- 'topup-500' was seeded in the original schema as a 500-credit pack for
  -- $5.00 and never linked to Stripe, so this statement repurposes it rather
  -- than inserting. Repricing a row invalidates whatever price it pointed at,
  -- so drop the link and take it off sale until the cutover mints a new one.
  -- When the price is unchanged this is a re-run and nothing should move:
  -- re-running the migration after a successful cutover must not unlink a
  -- live pack. (Both branches read the row's PRE-update values.)
  stripe_price_id    = CASE
                         WHEN public.topup_packs.price_cents = EXCLUDED.price_cents
                           THEN public.topup_packs.stripe_price_id
                         ELSE NULL
                       END,
  is_active          = CASE
                         WHEN public.topup_packs.price_cents = EXCLUDED.price_cents
                           THEN public.topup_packs.is_active
                         ELSE false
                       END,
  updated_at         = now();

-- Leave credits-50/100/250/500 active and selling. The Stripe cutover retires
-- them in the same operation that puts the ladder on sale.
