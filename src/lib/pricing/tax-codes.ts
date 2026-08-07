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
 * Top-up credit packs.
 *
 * Prepaid credits are the one case in this catalogue with two defensible
 * answers, because the question is *when* tax falls, not what the thing is:
 *
 *   • at REDEMPTION — the pack is stored value, like a gift card. Stripe's
 *     `txcd_90020000` ("Gift card") models this and is **non-taxable at
 *     purchase**; GST would fall later, when credits are spent on a report.
 *   • at PURCHASE — the pack is a prepayment for the service it buys, and is
 *     taxed then, at the rate of that service.
 *
 * **Purchase was chosen** (operator decision, 2026-08-07). So the pack is
 * taxed as what the credits buy — hosted software — and carries the same SaaS
 * code as the tiers and modules. This is deliberately NOT the gift-card code:
 * `txcd_90020000` would zero-rate the sale and defer the liability, which is
 * the opposite of the decision.
 *
 * That also settles a disagreement the live account had with itself. The four
 * legacy "N Credit Pack" products carried `txcd_10000000` (tangible goods) —
 * right on timing, wrong on category — and the eight generated "Aurixa N
 * Credit Pack" products carried nothing at all. All twelve now agree.
 *
 * NOT TAX ADVICE. The timing decision was the operator's; this constant only
 * records it in one place instead of twelve.
 */
export const TAX_CODE_TOPUP_PACK = TAX_CODE_SAAS;
