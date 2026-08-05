# The `[MOCK]` Stripe products — what they are, and why the syncs ignore them

If you are looking at the Stripe dashboard and wondering why there are 38
products named `[MOCK] Aurixa …` charging a dollar each: they are test fixtures
for the end-to-end purchase sweep driven from the prime repo. They are listed,
with their payment links, at **`/pricing-mock`** on the Aurixa Systems site. The
full reference is `docs/pricing-mock.md` in the `aurixa-systems` repo.

This file exists for one reason: so that nobody operating **this** repo mistakes
them for catalogue drift and tries to tidy them up.

## They are in the live account

`acct_1TbJPK3tNhf9apmH`, not a sandbox. A A$1.00 charge against one is a real
charge. Do not delete the products — refunds need them to stay resolvable.
Deactivate instead, when the sweep is done.

## The syncs cannot see them, by construction

`stripe-catalog-sync.server.ts`, `stripe-module-sync.server.ts` and
`stripe-pack-sync.server.ts` each resolve a product by searching Stripe metadata
— `metadata['aurixa_tier']`, `metadata['aurixa_module']` and
`metadata['aurixa_pack']` respectively — falling back to creation when the search
comes up empty.

The mocks carry **none** of those keys. They use a parallel namespace:

```
aurixa_mock       = "true"     ← on every mock product, price and payment link
aurixa_mock_kind  = tier | module | pack | setup
aurixa_mock_tier  / aurixa_mock_module / aurixa_mock_pack / aurixa_mock_setup
```

So `products.search({ query: "metadata['aurixa_tier']:'launch'" })` cannot
return `[MOCK] Aurixa Launch`, and pressing **Apply** on any of the three sync
cards can never bind a real `seat_plans` / `addon_modules` / `topup_packs` row to
a A$1 price.

`ensurePrice` is isolated for a second, independent reason: it lists prices with
`{ product: productId }`, so it only ever sees prices hanging off the live
product it already resolved.

Nothing in this repo's database was touched to create them — no catalogue row was
inserted, updated or repointed. The fixtures exist only in Stripe.

**The rule, if you add a fixture later:** never write `aurixa_tier`,
`aurixa_module` or `aurixa_pack` onto anything that is not the real product. The
aurixa-systems repo enforces this with a test over its catalogue source
(`src/lib/pricing/mockCatalog.test.ts`); there is no equivalent guard here, so on
this side it is a convention you have to keep.

## Paying one fulfils nothing

A Payment Link session arrives at `api.public.stripe.webhook.ts` without `mode`
or `item_id` in its metadata, so `handleCheckoutCompleted` raises
`PermanentError("missing_metadata")` — the event is recorded and dropped, with no
retry. No plan assignment, no `apply_topup`, no setup purchase.

This is the same behaviour the live add-on Payment Links have always had, and it
is deliberate for the mocks too. To exercise **fulfilment**, go through
`startCheckoutCore` (via `/api/public/storefront/checkout`) with a handoff or a
uid — that is the path that stamps the metadata the webhook needs. The mock price
ids on `/pricing-mock` are copy-ready for pointing a test row at.

## Two things noticed while minting

Neither was changed; both predate the fixtures.

1. The live `Aurixa Market Updates` product still describes itself as *"Included
   with Growth and Scale."* `aurixa-catalog.ts` now bundles Market Updates into
   **Scale only**, and the Stripe product was not re-synced after that change. A
   run of the module sync would correct it.
2. Two live products carry `aurixa_tier: growth` — `prod_Uy9fqonhZurj2E` and
   `prod_UcfABtrSg7cBle`. This is the duplicate already documented in
   `ensureModuleProduct`'s comment, left from a retry after a partial failure.
   `seat_plans.stripe_price_id` points at the correct one, so checkout is
   unaffected.
