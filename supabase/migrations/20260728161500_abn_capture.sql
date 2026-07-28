-- ABN capture on checkout.
--
-- Purchase sessions now enable Stripe's `tax_id_collection`, which shows a
-- business tax ID + legal entity name form for buyers in supported countries
-- (au_abn for Australia) and writes the collected ID onto the Stripe Customer.
-- Two things need somewhere to live on our side:
--
--   1. `billing_handoffs.contact_tax_id` — the clone already stores the
--      workspace's ABN in its own settings, so it can forward it with the
--      handoff. Mission Control pre-attaches a checksum-valid ABN to the
--      Stripe Customer, and Checkout then skips the form entirely. Only ever
--      attached when the Customer has none: Stripe hides the form once any tax
--      ID exists, so a wrong value would be both permanent and unfixable by
--      the buyer.
--
--   2. `tenants.tax_id_*` — the ABN a buyer typed on Stripe's page, mirrored
--      back by the webhook so operators can see it in Mission Control without
--      opening the Stripe dashboard, and so the next checkout knows the
--      workspace already has one.
--
-- `tax_id_business_name` is the legal entity name Checkout collected alongside
-- the ID. It is recorded rather than applied: `Customer.name` stays the
-- workspace name (see billing-contact.server.ts), so this is the one place the
-- buyer's own declared entity name is visible if the two ever diverge.

-- ── 1. Handoff carries the workspace's known ABN ────────────────────────────
ALTER TABLE public.billing_handoffs
  ADD COLUMN IF NOT EXISTS contact_tax_id      text,
  ADD COLUMN IF NOT EXISTS contact_tax_id_type text;

COMMENT ON COLUMN public.billing_handoffs.contact_tax_id IS
  'Business tax ID (ABN, digits only) supplied by the clone. Validated before use; an invalid value is dropped so Checkout asks the buyer instead.';
COMMENT ON COLUMN public.billing_handoffs.contact_tax_id_type IS
  'Stripe tax ID type for contact_tax_id. Defaults to au_abn when omitted.';

-- ── 2. Tenant mirror of what Stripe holds ───────────────────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS tax_id_type          text,
  ADD COLUMN IF NOT EXISTS tax_id_value         text,
  ADD COLUMN IF NOT EXISTS tax_id_business_name text,
  ADD COLUMN IF NOT EXISTS tax_id_captured_at   timestamptz;

COMMENT ON COLUMN public.tenants.tax_id_value IS
  'Business tax ID as held by Stripe for this tenant''s Customer. Mirrored by the checkout webhook; Stripe remains authoritative.';
COMMENT ON COLUMN public.tenants.tax_id_business_name IS
  'Legal entity name the buyer declared alongside the tax ID. Recorded only — Customer.name stays the workspace name.';

CREATE INDEX IF NOT EXISTS tenants_tax_id_value_idx
  ON public.tenants (tax_id_value)
  WHERE tax_id_value IS NOT NULL;
