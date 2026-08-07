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

## The dark tax invoice PDF

Stripe's invoice PDF **cannot** be made dark. `secondary_color` — the field that
paints backgrounds everywhere else — is documented as not applying to PDFs, and
invoice rendering templates, the other lever, carry only the memo, the footer,
custom fields and line-item grouping. There is no colour or layout control.

So the dark invoice is a document Mission Control renders:

| File                                              | Role                                                   |
| ------------------------------------------------- | ------------------------------------------------------ |
| `src/lib/brand/invoiceDocument.pure.ts`           | Stripe invoice → printable model. Pure, 15 tests.      |
| `src/server/invoice-pdf.server.ts`                | Model → A4 PDF on the `base950` ground, via `pdf-lib`. |
| `src/routes/api.public.billing.invoice-pdf.ts`    | Clone-key-scoped download for command centres.         |
| `renderDarkInvoicePdf` in `invoices.functions.ts` | Operator download, wired into Billing → Invoices.      |

**It is offered beside Stripe's PDF, never instead of it.** Stripe's remains the
system of record and `invoice_pdf_url` still points at it.

Two PDFs for one transaction is a real hazard: the moment they can disagree
about a number, one is wrong and nobody knows which. Three things make it safe:

1. **Nothing is computed.** Every amount is copied from the Stripe invoice, and
   a total Stripe did not send is _omitted_ rather than derived — including the
   ex-GST line, which is `total_excluding_tax` when Stripe provides it and
   simply absent when it does not. `total − tax` is right almost always, and
   "almost always" is the wrong standard for a tax invoice. A test asserts it
   does not quietly reappear.
2. **It reads live from Stripe**, not from the `invoices` mirror. The mirror
   carries totals but no line items and no billing address; a tax invoice
   assembled from a partial copy is the exact divergence this is avoiding. The
   mirror's job here is authorisation — it is what scopes a clone API key to its
   own invoices, and going to Stripe first would render any invoice on the
   account to anyone holding any key.
3. **The page names its source.** Every render carries "Restates Stripe invoice
   `in_…`; figures as issued by Stripe; nothing on this page is recalculated."

Smaller choices: dates are formatted in `Australia/Sydney`, because an invoice
issued from Kellyville is dated locally and a Worker's UTC clock would date some
of them a day early (this is deliberately _not_ the Stripe account's
Asia/Kuala_Lumpur dashboard timezone, which governs reporting only). The type is
Helvetica, not Inter — one of the PDF standard 14, so no font bytes ride in the
Worker bundle for every request that is not a PDF. The lockup is the
**transparent** variant, not the tile Stripe gets: this page's ground is ours,
and the opaque tile would leave a visible box edge where its glow stops.

Preview it without issuing anything:

```
bun run scripts/render-invoice-pdf-preview.ts [out.pdf]
```

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
