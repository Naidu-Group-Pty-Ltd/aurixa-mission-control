# Stripe branding

Mission Control is the headless billing engine, so it is where the Aurixa brand
gets pushed to Stripe and where it is carried onto individual invoices.

The brand itself — the palette, the marks and how they were built — is
documented in the storefront repo at `aurixa-systems/docs/stripe-branding.md`.
This file covers what happens on this side.

## The single source of truth

`src/lib/brand/aurixa-brand.ts`. Pure module, no server imports, fully unit
tested. It holds the palette, the two Stripe colours, the asset specs, the
invoice footer and the tax-display setting. Nothing else in this repo should
carry an Aurixa hex value.

Not to be confused with `src/server/branding/`, which is the white-label engine
that cascades a **clone's** brand down to a tenant. This module is our own
identity going up to Stripe.

## What it reaches, in three places

**1. Account branding** — `src/server/stripe-branding.server.ts`, driven from
Billing → Pricing Catalog → _Stripe brand identity_.

`planBrandSync()` reads the live account and writes nothing. `applyBrandSync()`
fetches the two PNGs from the storefront, uploads them through the Files API
(Stripe takes bytes, not URLs) and writes all four fields on
`account.settings.branding`. Uploads happen before the account write, so a
failed fetch leaves the account untouched rather than half-branded.

If Stripe refuses the account write — it restricts which accounts a key may set
`settings.branding` on — the File ids are still returned and the card shows
them, because they are exactly what the Dashboard's Branding page takes. That
is a degraded success, not a wasted run.

**2. Customer invoice settings** — `syncStripeCustomerContact` in
`billing-contact.server.ts`, and the create path in `ensureStripeCustomer`.

The footer and `rendering_options` go on the **Customer**, because subscription
cycle invoices are minted by Stripe on renewal with no request of ours to hang
settings off; they inherit from there. Unlike the buyer identity fields around
them — which are seed-only, so an organisation's billing email is never
repointed by a colleague's purchase — this is our own copy and is kept current,
so a workspace that bought before the cutover picks it up on its next invoice
rather than carrying a blank footer forever.

Only `footer` and `rendering_options` are sent. Stripe merges `invoice_settings`
field by field, which is the same behaviour `payment-methods.server.ts` already
relies on when it sets `default_payment_method` on its own.

**3. One-off invoices** — `invoice_creation.invoice_data` in
`checkout.server.ts`.

A one-off invoice is created from the checkout request and does **not** inherit
the Customer's `invoice_settings` the way a subscription cycle invoice does, so
the same two values are set there as well. Both are covered by an
`invoice_presentation` entry in that file's degradation ladder: if an account or
API version will not take them, the invoice is still issued and the sale still
completes.

## `include_inclusive_tax` is not cosmetic

Every Aurixa price is tax-**inclusive** — GST is contained in the figure, not
added at checkout, and the pricing page leads with the inclusive number.
Stripe's default tax display would print line items ex-GST and disagree with
what the customer was quoted. `AURIXA_INVOICE_RENDERING` is what keeps the PDF
and the quote saying the same thing.

## No registration number in the footer

The number on the Stripe account (695 868 243) is nine digits — an ACN, not the
eleven-digit ABN a tax invoice needs. Stripe already prints the registered
business details from Business settings, which hold the real value. A padded
guess on every customer's tax invoice is the kind of wrong that only surfaces at
audit, so the footer leaves it out; `aurixa-brand.test.ts` asserts it stays out.
