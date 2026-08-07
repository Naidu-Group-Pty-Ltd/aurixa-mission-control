/**
 * Stripe tax codes for the Aurixa catalogue.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Stripe Tax computes tax from the product's `tax_code`. A product without one
 * falls through to the account default — which on this account is
 * `txcd_10000000`, **"General — Tangible Goods"**.
 *
 * Every product the three syncs generate was being created without a tax code,
 * so 33 of the 45 live products — all three tiers, all 22 modules and all 8
 * top-up packs — were being taxed as though Aurixa shipped physical goods.
 *
 * Domestically that is invisible: AU GST is 10% either way. It stops being
 * invisible the moment something is sold across a border, because goods and
 * digital services have different place-of-supply rules — and the invoice is
 * the legal document, so getting it wrong means reissuing.
 *
 * The codes here are not invented. They match what was already set by hand on
 * the legacy equivalents of these products (`Launch`, `Growth`, `Enterprise`
 * carry `txcd_10103000`; the `* Onboarding` products carry `txcd_20030000`),
 * so this makes the generated catalogue agree with the hand-built one rather
 * than introducing a new opinion.
 *
 * NOT TAX ADVICE. These are structural corrections — a subscription to
 * software is not a tangible good — and they should still be confirmed by
 * whoever signs off the BAS.
 */

/**
 * Software as a service, business use.
 *
 * Covers the seat tiers and every add-on module: recurring access to hosted
 * software, which is what all of them are.
 */
export const TAX_CODE_SAAS = "txcd_10103000";

/**
 * Professional services.
 *
 * The one-off setup and onboarding packages — human work, not software access.
 * Already set by hand on all four legacy `* Onboarding` products.
 */
export const TAX_CODE_PROFESSIONAL_SERVICES = "txcd_20030000";

/**
 * Top-up credit packs — deliberately NOT given a default here.
 *
 * Prepaid credits are the one genuinely ambiguous case in this catalogue, and
 * the existing account does not agree with itself about them: the four legacy
 * "N Credit Pack" products carry `txcd_10000000` (tangible goods), while the
 * eight generated "Aurixa N Credit Pack" products carry nothing at all.
 *
 * The treatment turns on whether tax falls at purchase or at redemption, which
 * is a question for an accountant and not one to settle in a constant. Left
 * unset so the packs keep inheriting the account default and the disagreement
 * stays visible, rather than being silently resolved by whoever edited this
 * file last.
 */
export const TAX_CODE_TOPUP_PACK: string | undefined = undefined;
