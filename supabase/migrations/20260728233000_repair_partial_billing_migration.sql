-- ─────────────────────────────────────────────────────────────────────────────
-- Repair: migration 20260725150000 only landed in part.
--
-- Incident. No `purchases` row has been written since 2026-07-25. Checkout
-- itself was healthy the whole time — Stripe shows sessions created on the
-- 26th, 27th and 28th, each carrying full metadata — so nothing was lost at
-- the Stripe end. What broke was the write on our side.
--
-- 20260725150000 added `purchases.item_name` and, in the same deploy,
-- `recordPurchaseInitiated()` started sending that column. Only part of that
-- migration reached production:
--
--     public.payment_methods        present
--     public.invoices               ABSENT   (PGRST205)
--     public.purchases.item_name    ABSENT   (SQLSTATE 42703)
--
-- So every INSERT into `purchases` has failed since with
-- `column purchases.item_name does not exist`. `recordPurchaseInitiated` is
-- deliberately best-effort — attribution bookkeeping must never block a
-- customer from paying — so it swallowed the error and the purchase ledger
-- silently stopped recording. That is why the symptom was "no purchase
-- history" rather than "checkout is broken".
--
-- Two further consequences of the same partial apply:
--   • `finalizePurchaseFromSession()` writes item_name too, and it THROWS.
--     Every completed checkout therefore 500s the webhook after fulfilment
--     has already run, so Stripe retries the event indefinitely.
--   • `handleInvoicePaid()` mirrors into `public.invoices`, which does not
--     exist, so `invoice.paid` fails outright — taking the past_due clear on
--     subscription renewals down with it.
--
-- This migration re-applies only the parts that are missing. Every statement
-- is idempotent, so it is safe to run against a database where some or all of
-- it is already present (including one where 20260725150000 did fully apply).
-- The DDL is copied verbatim from that migration so the resulting schema is
-- identical either way.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. purchases.item_name ─────────────────────────────────────────────────

ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS item_name TEXT;

COMMENT ON COLUMN public.purchases.item_name IS
  'Human-readable catalog item name stamped at checkout. Display only — item_id and item_slug remain the identity of what was bought.';

-- Backfill from the catalog for rows written before the column existed.
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

-- ─── 2. invoices ────────────────────────────────────────────────────────────

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

-- ─── 3. Force a PostgREST schema-cache reload ───────────────────────────────
--
-- Same belt-and-braces as 20260725190000: the NOTIFY is the canonical reload,
-- and the no-op COMMENTs are DDL, which trips Supabase's pgrst_ddl_watch event
-- trigger independently in case the NOTIFY is missed. Without this the new
-- column and table can exist in Postgres while PostgREST still rejects them
-- (PGRST204 / PGRST205), which looks identical to the outage above.

COMMENT ON TABLE public.invoices IS
  'Mirror of Stripe invoices (subscription cycles + one-time purchases via checkout invoice_creation), keyed on stripe_invoice_id.';

COMMENT ON TABLE public.purchases IS
  'One row per Stripe Checkout session: status initiated -> completed | failed | refunded. Written at session creation and finalised by the webhook.';

NOTIFY pgrst, 'reload schema';
