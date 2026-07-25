-- ─────────────────────────────────────────────────────────────────────────────
-- Saved payment methods + invoice ledger (billing & usage workflow).
--
-- Context: command centers (prime + clones) get a Billing & Usage page that
-- shows saved cards, transactions and invoices. Cards are captured on the
-- Aurixa Systems storefront via Stripe Checkout in `setup` mode — card data
-- goes browser → Stripe only; Mission Control stores nothing but the Stripe
-- payment-method reference and display fields (brand / last4 / expiry).
--
--  1. `payment_methods` — up to 3 active cards per tenant with an ordered
--     role: priority 1 = primary, 2 = secondary, 3 = backup. Rows are written
--     exclusively by the service role (Stripe webhook + clone API routes);
--     operators can read them in Mission Control.
--  2. `reorder_payment_methods` RPC — atomically rewrites the priority order
--     for a tenant's active cards under an advisory lock (a partial unique
--     index on (tenant_id, priority) cannot support in-place swaps, so order
--     integrity is owned by this RPC instead).
--  3. `invoices` — mirror of Stripe invoices (subscription renewals AND
--     one-time purchases, which now enable Stripe invoice_creation), keyed on
--     stripe_invoice_id, carrying hosted/PDF URLs and the attribution
--     contract fields so every dollar is traceable to an item and a user.
--  4. `purchases.item_name` — human-readable item name stamped at checkout
--     time (and backfilled from the catalog) so transaction read-backs can
--     show "Starter Pack (1,000 credits)" instead of a slug.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. payment_methods ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payment_methods (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id                    UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  stripe_customer_id          TEXT NOT NULL,
  stripe_payment_method_id    TEXT NOT NULL,
  stripe_setup_intent_id      TEXT,
  stripe_checkout_session_id  TEXT,
  brand                       TEXT,
  last4                       TEXT,
  exp_month                   INTEGER,
  exp_year                    INTEGER,
  funding                     TEXT,               -- credit | debit | prepaid | unknown
  card_fingerprint            TEXT,               -- Stripe card fingerprint (dedupe aid)
  priority                    SMALLINT NOT NULL DEFAULT 1 CHECK (priority >= 1),
  status                      TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'detached')),
  origin_user_id              TEXT,
  origin_username             TEXT,
  origin_source               TEXT NOT NULL DEFAULT 'storefront',
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  detached_at                 TIMESTAMPTZ
);

-- One live row per Stripe payment method; detached rows keep history.
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_live_pm_uidx
  ON public.payment_methods (stripe_payment_method_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS payment_methods_tenant_idx
  ON public.payment_methods (tenant_id, status, priority);

CREATE INDEX IF NOT EXISTS payment_methods_session_idx
  ON public.payment_methods (stripe_checkout_session_id);

DROP TRIGGER IF EXISTS payment_methods_updated_at ON public.payment_methods;
CREATE TRIGGER payment_methods_updated_at
  BEFORE UPDATE ON public.payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read payment methods" ON public.payment_methods;
CREATE POLICY "Operators read payment methods"
  ON public.payment_methods FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

REVOKE ALL ON public.payment_methods FROM PUBLIC, anon;
GRANT SELECT ON public.payment_methods TO authenticated;
GRANT ALL ON public.payment_methods TO service_role;

-- ─── 2. reorder_payment_methods RPC ─────────────────────────────────────────
-- Rewrites the full priority order for a tenant's ACTIVE cards. The caller
-- supplies the desired order as an array of payment_methods.id; position 1
-- becomes primary. Validates set equality with the tenant's live cards and
-- caps the wallet at 3. Two-phase update (shift, then assign) under a
-- per-tenant advisory lock keeps concurrent reorders/attaches consistent.

CREATE OR REPLACE FUNCTION public.reorder_payment_methods(
  _tenant_id UUID,
  _ordered_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _live_count INTEGER;
  _match_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('payment_methods:' || _tenant_id::text));

  IF _ordered_ids IS NULL OR array_length(_ordered_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_order');
  END IF;
  IF array_length(_ordered_ids, 1) > 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_cards');
  END IF;
  IF (SELECT COUNT(DISTINCT x) FROM unnest(_ordered_ids) AS x)
       <> array_length(_ordered_ids, 1) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate_ids');
  END IF;

  SELECT COUNT(*) INTO _live_count
  FROM payment_methods
  WHERE tenant_id = _tenant_id AND status = 'active';

  SELECT COUNT(*) INTO _match_count
  FROM payment_methods
  WHERE tenant_id = _tenant_id AND status = 'active' AND id = ANY(_ordered_ids);

  IF _live_count <> array_length(_ordered_ids, 1) OR _match_count <> _live_count THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_set_mismatch');
  END IF;

  -- Phase 1: move everything out of the 1..3 band, then assign final slots.
  UPDATE payment_methods
     SET priority = priority + 100
   WHERE tenant_id = _tenant_id AND status = 'active';

  UPDATE payment_methods pm
     SET priority = ord.pos
    FROM (SELECT x AS id, ordinality AS pos
            FROM unnest(_ordered_ids) WITH ORDINALITY AS t(x, ordinality)) ord
   WHERE pm.id = ord.id;

  RETURN jsonb_build_object('ok', true, 'count', _live_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reorder_payment_methods(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_payment_methods(UUID, UUID[]) TO service_role;

-- ─── 3. invoices ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.invoices (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_invoice_id           TEXT NOT NULL UNIQUE,
  tenant_id                   UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  clone_id                    UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  purchase_id                 UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  stripe_customer_id          TEXT,
  stripe_subscription_id      TEXT,
  stripe_payment_intent_id    TEXT,
  number                      TEXT,
  status                      TEXT,               -- draft | open | paid | void | uncollectible
  description                 TEXT,
  mode                        TEXT,               -- topup | seat_plan | setup_package | subscription_cycle | unknown
  item_slug                   TEXT,
  item_name                   TEXT,
  amount_due_cents            INTEGER,
  amount_paid_cents           INTEGER,
  amount_remaining_cents      INTEGER,
  subtotal_cents              INTEGER,
  tax_cents                   INTEGER,
  total_cents                 INTEGER,
  currency                    TEXT,
  hosted_invoice_url          TEXT,
  invoice_pdf_url             TEXT,
  origin_user_id              TEXT,
  origin_username             TEXT,
  origin_source               TEXT,
  period_start                TIMESTAMPTZ,
  period_end                  TIMESTAMPTZ,
  issued_at                   TIMESTAMPTZ,
  paid_at                     TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_tenant_idx
  ON public.invoices (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_clone_idx
  ON public.invoices (clone_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx
  ON public.invoices (status);
CREATE INDEX IF NOT EXISTS invoices_subscription_idx
  ON public.invoices (stripe_subscription_id);

DROP TRIGGER IF EXISTS invoices_updated_at ON public.invoices;
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read invoices" ON public.invoices;
CREATE POLICY "Operators read invoices"
  ON public.invoices FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

REVOKE ALL ON public.invoices FROM PUBLIC, anon;
GRANT SELECT ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;

-- ─── 4. purchases.item_name ─────────────────────────────────────────────────

ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS item_name TEXT;

-- Backfill from the catalog tables for existing rows.
DO $$
BEGIN
  UPDATE public.purchases p
     SET item_name = tp.name
    FROM public.topup_packs tp
   WHERE p.item_name IS NULL AND p.mode = 'topup' AND p.item_id = tp.id;

  UPDATE public.purchases p
     SET item_name = sp.name
    FROM public.seat_plans sp
   WHERE p.item_name IS NULL AND p.mode = 'seat_plan' AND p.item_id = sp.id;

  UPDATE public.purchases p
     SET item_name = pkg.name
    FROM public.setup_packages pkg
   WHERE p.item_name IS NULL AND p.mode = 'setup_package' AND p.item_id = pkg.id;
END $$;
