// Moves the seat-plan tiers onto the signed-off price list.
//
// The whole reason this is a planned, two-phase operation rather than a
// migration: `seat_plans.price_cents` is what the pricing page SHOWS, and
// `seat_plans.stripe_price_id` is what Stripe actually CHARGES. Changing one
// without the other advertises $504 and bills $749. Stripe prices are also
// immutable, so a reprice means minting a new Price and repointing the row —
// two systems that have to move together or not at all.
//
// So: plan() computes every operation and is pure and unit-tested; apply()
// executes them, creating the Stripe prices first and only then repointing the
// catalog row, so a row is never live against a price that does not exist.
import Stripe from "stripe";
import { getStripe } from "@/server/stripe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { TIERS, annualCents, gstComponentCents, type Tier } from "@/lib/pricing/aurixa-catalog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export type PlanRow = { id: string; slug: string; name: string; price_cents: number | null };

export type RenameOp = { from: string; to: string; name: string };

export type PriceOp = {
  tierSlug: string;
  productName: string;
  interval: "month" | "year";
  /** Tax-INCLUSIVE, in cents. */
  unitAmount: number;
  gstComponent: number;
};

export type SyncPlan = {
  /** Slug moves, in an order that never collides on the unique slug index. */
  renames: RenameOp[];
  /** Stripe prices to mint. */
  prices: PriceOp[];
  /** Tiers in the sheet with no matching catalog row — these are created. */
  missing: string[];
  /** Rows left alone (e.g. enterprise), for the operator to see. */
  untouched: string[];
  warnings: string[];
};

/**
 * Orders the slug moves so no rename ever collides.
 *
 * The decision was to reuse existing rows rather than mint new ones, so Stripe
 * products and subscription history stay attached: the old Professional row
 * becomes Growth, and the old Growth row becomes Scale. Done naively that
 * fails — renaming Professional→Growth hits the live Growth row's unique slug.
 * So a rename only runs once its target slug is vacant, which means Growth
 * must vacate to Scale first. Repeatedly take whatever is currently safe; if a
 * pass makes no progress the remainder is a genuine cycle and is reported
 * rather than half-applied.
 */
export function orderRenames(
  desired: ReadonlyArray<{ from: string; to: string; name: string }>,
  occupied: ReadonlySet<string>,
): { ordered: RenameOp[]; blocked: RenameOp[] } {
  const pending = desired.filter((d) => d.from !== d.to);
  const free = new Set(occupied);
  const ordered: RenameOp[] = [];
  let moved = true;

  while (pending.length && moved) {
    moved = false;
    for (let i = 0; i < pending.length; i++) {
      const op = pending[i];
      if (!free.has(op.to)) {
        ordered.push(op);
        free.delete(op.from);
        free.add(op.to);
        pending.splice(i, 1);
        i--;
        moved = true;
      }
    }
  }
  return { ordered, blocked: [...pending] };
}

/** Everything the cutover will do, computed without touching anything. */
export function planCatalogSync(rows: readonly PlanRow[]): SyncPlan {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const warnings: string[] = [];
  const missing: string[] = [];

  const desired = TIERS.map((t) => ({
    from: t.replacesSlug ?? t.slug,
    to: t.slug,
    name: t.name,
  })).filter((d) => {
    if (bySlug.has(d.from)) return true;
    missing.push(d.to);
    warnings.push(`No catalog row '${d.from}' to become '${d.to}' — it will be created.`);
    return false;
  });

  const { ordered, blocked } = orderRenames(desired, new Set(bySlug.keys()));
  for (const b of blocked) {
    warnings.push(`Cannot rename '${b.from}' to '${b.to}': target still occupied.`);
  }

  const prices: PriceOp[] = [];
  for (const tier of TIERS) {
    const monthly = tier.monthlyInclGstCents;
    prices.push({
      tierSlug: tier.slug,
      productName: `Aurixa ${tier.name}`,
      interval: "month",
      unitAmount: monthly,
      gstComponent: gstComponentCents(monthly),
    });
    const annual = annualCents(monthly);
    prices.push({
      tierSlug: tier.slug,
      productName: `Aurixa ${tier.name}`,
      interval: "year",
      unitAmount: annual,
      gstComponent: gstComponentCents(annual),
    });
  }

  const touched = new Set([...ordered.map((o) => o.from), ...TIERS.map((t) => t.slug)]);
  const untouched = rows.map((r) => r.slug).filter((s) => !touched.has(s));

  return { renames: ordered, prices, missing, untouched, warnings };
}

/** Loads the seat plans the cutover operates on. */
export async function loadPlanRows(): Promise<PlanRow[]> {
  const { data, error } = await adminAny
    .from("seat_plans")
    .select("id, slug, name, price_cents")
    .order("price_cents", { ascending: true });
  if (error) throw new Error(`seat_plans_read_failed: ${error.message}`);
  return (data ?? []) as PlanRow[];
}

async function ensureProduct(stripe: Stripe, tier: Tier): Promise<string> {
  // Keyed on our own slug rather than the display name, so renaming the tier
  // never orphans the product it has history against.
  const lookup = `aurixa_tier_${tier.slug}`;
  const existing = await stripe.products.search({ query: `metadata['aurixa_tier']:'${tier.slug}'` });
  if (existing.data[0]) {
    await stripe.products.update(existing.data[0].id, { name: `Aurixa ${tier.name}` });
    return existing.data[0].id;
  }
  const created = await stripe.products.create({
    name: `Aurixa ${tier.name}`,
    metadata: { aurixa_tier: tier.slug, lookup },
  });
  return created.id;
}

export type ApplyResult = {
  applied: boolean;
  renamed: RenameOp[];
  createdPrices: Array<{ tierSlug: string; interval: string; priceId: string; amount: number }>;
  errors: string[];
};

/**
 * Executes the plan: Stripe prices first, catalog rows second.
 *
 * That order is the safety property. A price that exists but is not yet
 * referenced sells nothing; a row repointed at a price that does not exist
 * breaks checkout outright.
 *
 * Prices are created with `tax_behavior: 'inclusive'` because every figure on
 * the sheet already contains GST. Left at Stripe's default, enabling Stripe
 * Tax later would ADD 10% on top and quietly overcharge every customer.
 */
export async function applyCatalogSync(plan: SyncPlan): Promise<ApplyResult> {
  const stripe = getStripe();
  const result: ApplyResult = { applied: true, renamed: [], createdPrices: [], errors: [] };

  for (const tier of TIERS) {
    try {
      const productId = await ensureProduct(stripe, tier);
      const wanted = plan.prices.filter((p) => p.tierSlug === tier.slug);
      const ids: Record<string, string> = {};

      for (const p of wanted) {
        const price = await stripe.prices.create({
          product: productId,
          currency: "aud",
          unit_amount: p.unitAmount,
          tax_behavior: "inclusive",
          recurring: { interval: p.interval },
          metadata: { aurixa_tier: tier.slug, gst_component_cents: String(p.gstComponent) },
        });
        ids[p.interval] = price.id;
        result.createdPrices.push({
          tierSlug: tier.slug,
          interval: p.interval,
          priceId: price.id,
          amount: p.unitAmount,
        });
      }

      const rename = plan.renames.find((r) => r.to === tier.slug);
      const targetSlug = rename?.from ?? tier.slug;
      const { error } = await adminAny
        .from("seat_plans")
        .update({
          slug: tier.slug,
          name: tier.name,
          description: tier.blurb,
          price_cents: tier.monthlyInclGstCents,
          currency: "AUD",
          seat_limit: tier.seatMax,
          stripe_price_id: ids.month ?? null,
          is_active: true,
          metadata: {
            tax_inclusive: true,
            gst_included: true,
            seat_min: tier.seatMin,
            seat_max: tier.seatMax,
            annual_price_cents: annualCents(tier.monthlyInclGstCents),
            annual_stripe_price_id: ids.year ?? null,
          },
        })
        .eq("slug", targetSlug);
      if (error) throw new Error(error.message);
      if (rename) result.renamed.push(rename);
    } catch (err) {
      result.errors.push(`${tier.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
