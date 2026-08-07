-- ─────────────────────────────────────────────────────────────────────────────
-- A settled API-usage charge needs an INVOICE, not just an invoice item.
--
-- `invoiceClosedCharge` created a Stripe invoice item and stopped there. An
-- invoice item is not a bill — it is a pending line waiting for an invoice to
-- attach itself to. Stripe attaches pending items automatically only when the
-- customer's subscription cycle next renews, so:
--
--   • a tenant WITH a subscription gets the usage on their next cycle invoice,
--     which is the intended behaviour and needs nothing more;
--   • a tenant WITHOUT one gets an invoice item that sits pending forever and
--     is never collected.
--
-- The second case is not an edge case here. The Aurixa Stripe account currently
-- has zero subscriptions, so as shipped every API-usage charge would have been
-- metered, rated, settled, converted to cents — and then silently never billed.
--
-- This adds the columns needed to record the invoice that actually collects the
-- charge, so "did this reach a bill" is answerable from the billing record
-- rather than by going and looking in Stripe.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.api_usage_charges
  -- The invoice the charge landed on: a standalone one we raised, or the
  -- subscription cycle invoice that swept the pending item up.
  ADD COLUMN IF NOT EXISTS stripe_invoice_id text,
  -- How it got there. Distinguishes "we raised a bill" from "it will ride the
  -- next renewal", which look identical on the charge row otherwise.
  ADD COLUMN IF NOT EXISTS invoice_mode text
    CHECK (invoice_mode IS NULL OR invoice_mode IN ('standalone','subscription_cycle')),
  -- Set when Stripe finalised the invoice, i.e. it has a number, a hosted page
  -- and a PDF, and the customer has been emailed.
  ADD COLUMN IF NOT EXISTS invoice_finalized_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_api_usage_charges_invoice
  ON public.api_usage_charges (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- The charges that were converted to an invoice item but never reached an
-- invoice. Empty is the healthy state; anything here is revenue that was
-- correctly metered and is not being collected.
CREATE OR REPLACE FUNCTION public.api_usage_uncollected_charges()
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  period_start date,
  amount_cents integer,
  currency text,
  stripe_invoice_item_id text,
  invoiced_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.tenant_id, c.period_start, c.amount_cents, c.currency,
         c.stripe_invoice_item_id, c.invoiced_at
    FROM public.api_usage_charges c
   WHERE c.status = 'invoiced'
     AND c.amount_cents > 0
     AND c.stripe_invoice_item_id IS NOT NULL
     AND c.stripe_invoice_id IS NULL
     -- A subscription cycle sweeps pending items up on renewal, so give it a
     -- full cycle plus slack before calling it uncollected.
     AND c.invoiced_at < now() - interval '40 days'
   ORDER BY c.invoiced_at;
$$;

GRANT EXECUTE ON FUNCTION public.api_usage_uncollected_charges() TO service_role, authenticated;

COMMENT ON COLUMN public.api_usage_charges.stripe_invoice_id IS
  'The Stripe invoice that collects this charge. NULL with a non-null '
  'stripe_invoice_item_id means the line is pending against a subscription '
  'cycle — or orphaned. See api_usage_uncollected_charges().';
