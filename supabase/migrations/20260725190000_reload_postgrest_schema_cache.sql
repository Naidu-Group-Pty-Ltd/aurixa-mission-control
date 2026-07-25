-- ─────────────────────────────────────────────────────────────────────────────
-- Force a PostgREST schema-cache reload for the billing & usage tables.
--
-- Incident: after migration 20260725150000 created payment_methods/invoices,
-- the dashboard's Payment methods tab intermittently failed with
--   "Could not find the table 'public.payment_methods' in the schema cache"
-- (PGRST205) while other requests to the same table succeeded — a stale
-- PostgREST schema cache that never fully picked up the DDL.
--
-- Remedy: the canonical reload NOTIFY, plus no-op COMMENT DDL on both tables.
-- The comments matter: Supabase's pgrst_ddl_watch event trigger reloads the
-- cache on any DDL command, so they act as a second, independent trigger in
-- case the NOTIFY channel is missed. Everything here is idempotent and
-- side-effect-free beyond the cache reload.
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.payment_methods IS
  'Saved card references per tenant (brand/last4/expiry only; cards live at Stripe). Priority 1 = primary, 2 = secondary, 3 = backup; max 3 active.';

COMMENT ON TABLE public.invoices IS
  'Mirror of Stripe invoices (subscription cycles + one-time purchases via checkout invoice_creation), keyed on stripe_invoice_id.';

NOTIFY pgrst, 'reload schema';
