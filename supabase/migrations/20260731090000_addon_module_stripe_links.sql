-- Gives the add-on modules somewhere to record what Stripe charges for them.
--
-- The Aurixa price list migration deliberately left this out, and said why:
--
--     • addon_modules carries no stripe_price_id and is not directly
--       checkout-able, so it is display data and safe to replace here.
--
-- That was the right call — a module row with a price and nothing behind it
-- cannot overcharge anyone. The consequence is that the twenty-three modules
-- on the pricing page have never been buyable. This adds the two columns the
-- link needs; it deliberately does NOT populate them.
--
-- Populating them is a Stripe operation, not a SQL one: prices are immutable
-- and live in another system, so minting them and repointing the row have to
-- happen together or a row ends up advertising a price that does not exist.
-- That is what src/server/stripe-module-sync.server.ts is for, driven from the
-- "Add-on modules" card in /billing/catalog.
--
-- Both columns stay NULL-able forever. NULL is the honest state for a module
-- that is listed but not sold — Lenders is on the page so the roadmap is
-- visible, and it must never acquire a price — so "has a link" is exactly the
-- test for "can be bought", and the sync enforces it in both directions.

ALTER TABLE public.addon_modules
  ADD COLUMN IF NOT EXISTS stripe_product_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id   text;

COMMENT ON COLUMN public.addon_modules.stripe_product_id IS
  'Stripe Product backing this module. Survives a reprice, so it is the stable pointer of the two.';
COMMENT ON COLUMN public.addon_modules.stripe_price_id IS
  'Stripe Price actually charged, monthly recurring, tax_behavior=inclusive (every figure already contains GST). NULL means the module is listed but not for sale.';

-- Serves both directions of the lookup. Checkout resolves a module by row id
-- and reads the price off it; a webhook arrives carrying only the price and
-- has to find the row. Partial, because the roadmap rows are legitimately NULL
-- and there is no point indexing them.
--
-- UNIQUE rather than merely indexed: two modules sharing a Stripe price is the
-- shape of the bug where a retry mints a second product and half the rows
-- point at the wrong one. Better it fails loudly at write time than show up
-- later as a mis-attributed subscription line.
CREATE UNIQUE INDEX IF NOT EXISTS addon_modules_stripe_price_unique
  ON public.addon_modules (stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;
