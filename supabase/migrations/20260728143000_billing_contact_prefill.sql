-- Carry the buyer's contact details into Stripe so checkout is prefilled.
--
-- Today the Stripe Customer for a tenant is created with a name only — no
-- email, no phone. Stripe Checkout prefills the email field from the attached
-- Customer, so with that field blank every buyer retypes their email (and, on
-- the card-save flow, their full billing details) on every visit. The clone
-- already knows who is buying: `billing_handoffs` carries the initiating
-- command-center user server-to-server. It just never carried their contact
-- details.
--
--   1. billing_handoffs gains the contact block the clone can populate when it
--      mints a handoff. These are ordinary PII columns on a table that is
--      already service-role-only (no client policies, REVOKEd from anon and
--      authenticated), single-use and expiring after 30 minutes.
--
--   2. payment_methods gains the cardholder name/email that Stripe collected
--      on the setup page. The wallet stores display references only — this is
--      the same class of data as brand/last4, and it lets the dashboard show
--      "Visa •••• 4242 — Jane Doe" instead of an anonymous card.

-- ── 1. Handoff contact block ────────────────────────────────────────────────
ALTER TABLE public.billing_handoffs
  ADD COLUMN IF NOT EXISTS contact_email      text,
  ADD COLUMN IF NOT EXISTS contact_first_name text,
  ADD COLUMN IF NOT EXISTS contact_last_name  text,
  ADD COLUMN IF NOT EXISTS contact_phone      text,
  ADD COLUMN IF NOT EXISTS contact_company    text;

COMMENT ON COLUMN public.billing_handoffs.contact_email IS
  'Buyer email supplied by the clone when minting the handoff. Seeds the Stripe Customer (never overwrites an existing billing email) and becomes the purchase receipt address.';
COMMENT ON COLUMN public.billing_handoffs.contact_company IS
  'Buyer organisation name. Used for the Stripe Customer name when the tenant has none.';

-- ── 2. Cardholder details on saved cards ────────────────────────────────────
ALTER TABLE public.payment_methods
  ADD COLUMN IF NOT EXISTS billing_name  text,
  ADD COLUMN IF NOT EXISTS billing_email text;

COMMENT ON COLUMN public.payment_methods.billing_name IS
  'Cardholder name from the payment method billing_details. Display only — no card data is ever stored here.';
