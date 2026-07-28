// Puts the top-up ladder on sale.
//
// Same invariant as the seat-plan cutover, and the same reason for splitting
// plan from apply: `topup_packs.price_cents` is the figure the pricing page
// shows and `topup_packs.stripe_price_id` is the price Stripe charges. The
// migration writes the first and deliberately leaves the second null, with the
// row inactive, so a pack cannot be advertised before there is anything to
// charge for it. This is the step that mints the Stripe prices and only then
// flips the rows live.
//
// Two things differ from the tier cutover. Packs are bought outright, so the
// prices are one-off rather than recurring. And no row is being repurposed:
// credits-50/100/250/500 priced credits about seventy times higher and have
// sales against them, so they are retired in place rather than renamed — which
// makes ordering a non-issue and lets the old packs keep selling right up
// until the new ones are live.
import Stripe from "stripe";
import { getStripe } from "@/server/stripe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { describeRefresh, refreshStorefrontMirror } from "@/server/storefront-refresh.server";
import {
  TOPUP_PACKS,
  gstComponentCents,
  packDiscountFraction,
  packPerCreditCents,
  type TopupPack,
} from "@/lib/pricing/aurixa-catalog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export type PackRow = {
  id: string;
  slug: string;
  name: string;
  tokens: number | null;
  price_cents: number | null;
  is_active: boolean;
  stripe_price_id?: string | null;
};

export type PackOp = {
  slug: string;
  name: string;
  credits: number;
  /** Tax-INCLUSIVE, in cents — the sheet's recommended price. */
  unitAmount: number;
  gstComponent: number;
  /** Cents per credit, unrounded. Display rounds; the discount does not. */
  perCreditCents: number;
  /** Cheaper per credit than the smallest pack, as a fraction. */
  discountFraction: number;
  /** Whether the catalog row is already selling at this price. */
  alreadyLive: boolean;
};

export type PackSyncPlan = {
  packs: PackOp[];
  /** Live packs the ladder supersedes — taken off sale, never deleted. */
  retire: string[];
  /** Ladder packs with no catalog row: the migration has not been applied. */
  missing: string[];
  warnings: string[];
};

const packMetadata = (pack: TopupPack) => ({
  stage: pack.stage,
  tax_inclusive: true,
  gst_included: true,
  best_for: pack.positioning,
  ...(pack.popular ? { popular: true } : {}),
  ...(pack.bestValue ? { best_value: true } : {}),
});

/** Everything the cutover will do, computed without touching anything. */
export function planPackSync(rows: readonly PackRow[]): PackSyncPlan {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const warnings: string[] = [];
  const missing: string[] = [];
  const packs: PackOp[] = [];

  for (const pack of TOPUP_PACKS) {
    const row = bySlug.get(pack.slug);
    if (!row) {
      missing.push(pack.slug);
      continue;
    }
    packs.push({
      slug: pack.slug,
      name: pack.name,
      credits: pack.credits,
      unitAmount: pack.priceInclGstCents,
      gstComponent: gstComponentCents(pack.priceInclGstCents),
      perCreditCents: packPerCreditCents(pack),
      discountFraction: packDiscountFraction(pack),
      alreadyLive:
        row.is_active && row.price_cents === pack.priceInclGstCents && !!row.stripe_price_id,
    });
  }

  if (missing.length) {
    // Creating the rows here would work, but it would also mean this button
    // could quietly invent catalog entries nobody reviewed. The migration is
    // the reviewed artifact; say so and stop.
    warnings.push(
      `No catalog row for ${missing.join(", ")}. Apply the top-up ladder migration first.`,
    );
  }

  // Anything still on sale that the ladder does not contain. Read from the
  // live rows rather than from RETIRED_PACK_SLUGS alone, so a pack added by
  // hand is caught too — but never retire a row that is already off sale, or
  // every re-run reports work it is not doing.
  const ladder = new Set(TOPUP_PACKS.map((p) => p.slug));
  const retire = rows.filter((r) => r.is_active && !ladder.has(r.slug)).map((r) => r.slug);

  return { packs, retire, missing, warnings };
}

/** Loads the packs the cutover operates on. */
export async function loadPackRows(): Promise<PackRow[]> {
  const { data, error } = await adminAny
    .from("topup_packs")
    .select("id, slug, name, tokens, price_cents, is_active, stripe_price_id")
    .order("tokens", { ascending: true });
  if (error) throw new Error(`topup_packs_read_failed: ${error.message}`);
  return (data ?? []) as PackRow[];
}

/**
 * The Stripe product for this pack, or a new one.
 *
 * Same resolution order as the tier products, for the same reason: the row's
 * current `stripe_price_id` is a direct lookup and always right, search is
 * eventually consistent and can miss a product created moments ago, and
 * creating is only correct once both have come up empty. Get that order wrong
 * and a retry after a partial failure mints a duplicate product per pack.
 */
async function ensurePackProduct(stripe: Stripe, pack: TopupPack, row?: PackRow): Promise<string> {
  const name = `Aurixa ${pack.name}`;

  if (row?.stripe_price_id) {
    try {
      const price = await stripe.prices.retrieve(row.stripe_price_id);
      const productId = typeof price.product === "string" ? price.product : price.product?.id;
      if (productId) {
        await stripe.products.update(productId, {
          name,
          metadata: { aurixa_pack: pack.slug, aurixa_pack_credits: String(pack.credits) },
        });
        return productId;
      }
    } catch {
      // Price deleted, or belongs to another account — fall through.
    }
  }

  try {
    const found = await stripe.products.search({ query: `metadata['aurixa_pack']:'${pack.slug}'` });
    if (found.data[0]) {
      await stripe.products.update(found.data[0].id, { name });
      return found.data[0].id;
    }
  } catch {
    // Search unavailable on this account — creating is still correct.
  }

  const created = await stripe.products.create({
    name,
    description: `${pack.credits.toLocaleString("en-AU")} report credits, valid 30 days. ${pack.positioning}.`,
    metadata: {
      aurixa_pack: pack.slug,
      aurixa_pack_credits: String(pack.credits),
      lookup: `aurixa_pack_${pack.slug}`,
    },
  });
  return created.id;
}

/**
 * A one-off price at this amount, reusing one if the product already has it.
 *
 * Packs are bought outright, so there is no `recurring` block — and its
 * absence is part of what identifies the price, because a product that once
 * carried a subscription price must not match against it.
 */
async function ensurePackPrice(
  stripe: Stripe,
  productId: string,
  pack: TopupPack,
): Promise<{ id: string; created: boolean }> {
  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = existing.data.find(
    (p) =>
      p.unit_amount === pack.priceInclGstCents &&
      p.currency === "aud" &&
      !p.recurring &&
      p.tax_behavior === "inclusive",
  );
  if (match) return { id: match.id, created: false };

  const price = await stripe.prices.create({
    product: productId,
    currency: "aud",
    unit_amount: pack.priceInclGstCents,
    tax_behavior: "inclusive",
    metadata: {
      aurixa_pack: pack.slug,
      credits: String(pack.credits),
      gst_component_cents: String(gstComponentCents(pack.priceInclGstCents)),
    },
  });
  return { id: price.id, created: true };
}

export type PackApplyResult = {
  applied: boolean;
  createdPrices: Array<{ slug: string; priceId: string; amount: number }>;
  retired: string[];
  notes: string[];
  errors: string[];
  /** Whether the storefront's read mirror picked the change up straight away. */
  storefrontRefreshed?: boolean;
};

/**
 * Executes the plan: Stripe prices first, catalog rows second, retirements
 * last — and only if nothing failed.
 *
 * That last condition is the one worth stating. If a pack fails to get a
 * price, retiring the old four anyway would leave the storefront with fewer
 * top-ups on sale than it started with. Better to leave the previous ladder
 * selling and let the operator press Apply again.
 */
export async function applyPackSync(
  plan: PackSyncPlan,
  rows: readonly PackRow[] = [],
): Promise<PackApplyResult> {
  const stripe = getStripe();
  const result: PackApplyResult = {
    applied: true,
    createdPrices: [],
    retired: [],
    notes: [],
    errors: [],
  };
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const wanted = new Set(plan.packs.map((p) => p.slug));

  for (const pack of TOPUP_PACKS) {
    if (!wanted.has(pack.slug)) continue;
    try {
      const row = bySlug.get(pack.slug);
      const productId = await ensurePackProduct(stripe, pack, row);
      const price = await ensurePackPrice(stripe, productId, pack);
      if (price.created) {
        result.createdPrices.push({
          slug: pack.slug,
          priceId: price.id,
          amount: pack.priceInclGstCents,
        });
      }

      const { error } = await adminAny
        .from("topup_packs")
        .update({
          name: pack.name,
          tokens: pack.credits,
          price_cents: pack.priceInclGstCents,
          currency: "AUD",
          expires_after_days: 30,
          stripe_price_id: price.id,
          is_active: true,
          metadata: packMetadata(pack),
        })
        .eq("slug", pack.slug);
      if (error) throw new Error(error.message);
    } catch (err) {
      result.errors.push(`${pack.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.errors.length) {
    result.applied = false;
    result.notes.push("Superseded packs left on sale — nothing was retired.");
    // Still refresh: some packs may have gone live before the failure, and
    // leaving the mirror behind would hide half a cutover as well as a whole
    // one.
    await refreshInto(result);
    return result;
  }

  for (const slug of plan.retire) {
    const { error } = await adminAny
      .from("topup_packs")
      .update({ is_active: false })
      .eq("slug", slug);
    if (error) {
      result.errors.push(`retire ${slug}: ${error.message}`);
      continue;
    }
    result.retired.push(slug);

    // Archiving the old Stripe price is tidiness, not correctness — checkout
    // resolves through the catalog row, which is now inactive. So a failure
    // here is reported and moved past rather than failing the cutover.
    const priceId = bySlug.get(slug)?.stripe_price_id;
    if (priceId) {
      try {
        await stripe.prices.update(priceId, { active: false });
      } catch (err) {
        result.notes.push(
          `Could not archive the Stripe price for ${slug}: ${
            err instanceof Error ? err.message : String(err)
          }. The pack is off sale regardless.`,
        );
      }
    }
  }

  await refreshInto(result);
  result.applied = result.errors.length === 0;
  return result;
}

/**
 * Closes the loop rather than trusting the database trigger to do it.
 *
 * The storefront reads a mirror, and until that mirror refreshes the pricing
 * page keeps advertising the packs this cutover just retired — which is
 * exactly what happened on the first run: prices went live at 21:38 and the
 * page caught up at 21:45, when the 15-minute cron ran. Reported, never fatal
 * — the catalog is already correct either way.
 */
async function refreshInto(result: PackApplyResult): Promise<void> {
  const refresh = await refreshStorefrontMirror();
  result.storefrontRefreshed = refresh.ok;
  result.notes.push(describeRefresh(refresh, "ladder"));
}
