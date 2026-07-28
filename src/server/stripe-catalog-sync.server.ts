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
import {
  TIERS,
  TIER_INCLUDES_AML,
  annualCents,
  gstComponentCents,
  tierBaseCents,
  tierHeadlineCents,
  type Tier,
} from "@/lib/pricing/aurixa-catalog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

export type PlanRow = {
  id: string;
  slug: string;
  name: string;
  price_cents: number | null;
  /** The price the row currently sells at — used to find its Stripe product. */
  stripe_price_id?: string | null;
};

export type RenameOp = { from: string; to: string; name: string };

export type PriceOp = {
  tierSlug: string;
  productName: string;
  interval: "month" | "year";
  /** Tax-INCLUSIVE, in cents — the sheet's headline figure for this tier. */
  unitAmount: number;
  gstComponent: number;
  /** Same tier without the AML/CTF module, for display alongside. */
  baseAmount: number;
  /** Whether unitAmount includes the AML/CTF module. */
  includesAml: boolean;
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

  // Which row belongs to which tier. Slugs alone are ambiguous: after a full
  // cutover the catalog holds {launch, growth, scale}, and before one it holds
  // {launch, professional, growth} — in both, a row called 'growth' exists, but
  // in the first it IS the Growth tier and in the second it is the row destined
  // to become Scale. Getting that wrong either re-runs a rename that already
  // happened or skips one that has not.
  //
  // A tier whose replaced row is gone but whose own slug is present has already
  // been moved, so it settles there and no one else may claim that slug. Every
  // remaining tier then takes the row it replaces, if that row is still free.
  const settled = new Set<string>();
  for (const t of TIERS) {
    const replaces = t.replacesSlug ?? t.slug;
    if (replaces !== t.slug && !bySlug.has(replaces) && bySlug.has(t.slug)) {
      settled.add(t.slug);
    }
  }

  const desired = TIERS.map((t) => {
    const replaces = t.replacesSlug ?? t.slug;
    // A row already settled on another tier is never available to take, even
    // if it happens to be the row this tier nominally replaces.
    const from =
      bySlug.has(replaces) && !settled.has(replaces)
        ? replaces
        : bySlug.has(t.slug)
          ? t.slug
          : null;
    return { from, to: t.slug, name: t.name };
  }).filter((d): d is { from: string; to: string; name: string } => {
    if (d.from !== null) return true;
    missing.push(d.to);
    warnings.push(`No catalog row available to become '${d.to}' — it will be created.`);
    return false;
  });

  const { ordered, blocked } = orderRenames(desired, new Set(bySlug.keys()));
  for (const b of blocked) {
    warnings.push(`Cannot rename '${b.from}' to '${b.to}': target still occupied.`);
  }

  const prices: PriceOp[] = [];
  for (const tier of TIERS) {
    for (const interval of ["month", "year"] as const) {
      const period = interval === "year" ? "annual" : "monthly";
      const amount = tierHeadlineCents(tier, period);
      prices.push({
        tierSlug: tier.slug,
        productName: `Aurixa ${tier.name}`,
        interval,
        unitAmount: amount,
        gstComponent: gstComponentCents(amount),
        baseAmount: tierBaseCents(tier, period),
        includesAml: TIER_INCLUDES_AML,
      });
    }
  }

  const touched = new Set([...ordered.map((o) => o.from), ...TIERS.map((t) => t.slug)]);
  const untouched = rows.map((r) => r.slug).filter((s) => !touched.has(s));

  return { renames: ordered, prices, missing, untouched, warnings };
}

/** Loads the seat plans the cutover operates on. */
export async function loadPlanRows(): Promise<PlanRow[]> {
  const { data, error } = await adminAny
    .from("seat_plans")
    .select("id, slug, name, price_cents, stripe_price_id")
    .order("price_cents", { ascending: true });
  if (error) throw new Error(`seat_plans_read_failed: ${error.message}`);
  return (data ?? []) as PlanRow[];
}

/**
 * The Stripe product this tier's row already sells through, or a new one.
 *
 * Resolution order matters. The row's CURRENT `stripe_price_id` is the only
 * fully reliable pointer: it is a direct lookup, and the product behind it is
 * the one existing subscriptions are attached to — exactly what reusing rows
 * was meant to preserve. Search is the fallback, and only the fallback,
 * because Stripe's search index is eventually consistent: a product created
 * moments ago may not be found, and a retry after a failed Apply would then
 * create a second product for the same tier.
 */
async function ensureProduct(stripe: Stripe, tier: Tier, row?: PlanRow): Promise<string> {
  if (row?.stripe_price_id) {
    try {
      const price = await stripe.prices.retrieve(row.stripe_price_id);
      const productId = typeof price.product === "string" ? price.product : price.product?.id;
      if (productId) {
        await stripe.products.update(productId, {
          name: `Aurixa ${tier.name}`,
          metadata: { aurixa_tier: tier.slug },
        });
        return productId;
      }
    } catch {
      // Price deleted or from another account — fall through and look it up.
    }
  }

  try {
    const found = await stripe.products.search({
      query: `metadata['aurixa_tier']:'${tier.slug}'`,
    });
    if (found.data[0]) {
      await stripe.products.update(found.data[0].id, { name: `Aurixa ${tier.name}` });
      return found.data[0].id;
    }
  } catch {
    // Search unavailable on this account — creating is still correct.
  }

  const created = await stripe.products.create({
    name: `Aurixa ${tier.name}`,
    metadata: { aurixa_tier: tier.slug, lookup: `aurixa_tier_${tier.slug}` },
  });
  return created.id;
}

/**
 * The price for this amount/interval on this product, reusing one if it exists.
 *
 * Stripe prices are immutable, so the natural implementation is "always
 * create" — but Apply is a button a human presses, and the first press of this
 * one failed partway. Minting a fresh price on every attempt leaves a trail of
 * identical active prices on the product, and it is not obvious afterwards
 * which one the catalog points at. Matching on the fields that define a price
 * makes pressing Apply twice a no-op instead.
 */
async function ensurePrice(
  stripe: Stripe,
  productId: string,
  op: PriceOp,
  tierSlug: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = existing.data.find(
    (p) =>
      p.unit_amount === op.unitAmount &&
      p.currency === "aud" &&
      p.recurring?.interval === op.interval &&
      p.tax_behavior === "inclusive",
  );
  if (match) return { id: match.id, created: false };

  const price = await stripe.prices.create({
    product: productId,
    currency: "aud",
    unit_amount: op.unitAmount,
    tax_behavior: "inclusive",
    recurring: { interval: op.interval },
    metadata: { aurixa_tier: tierSlug, gst_component_cents: String(op.gstComponent) },
  });
  return { id: price.id, created: true };
}

/**
 * The order tiers must be written in, taken from the plan's rename ordering.
 *
 * This is the whole point of `orderRenames`, and applying in TIERS declaration
 * order silently threw it away: Growth (from the old Professional row) would
 * be written before the old Growth row had vacated to Scale, so the slug
 * collided and the update failed. Tiers that are not moving slug sort first —
 * they cannot collide with anything.
 */
export function tierApplyOrder(plan: SyncPlan): Tier[] {
  const position = new Map(plan.renames.map((r, i) => [r.to, i]));
  return [...TIERS].sort(
    (a, b) => (position.get(a.slug) ?? -1) - (position.get(b.slug) ?? -1),
  );
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
export async function applyCatalogSync(plan: SyncPlan, rows: readonly PlanRow[] = []): Promise<ApplyResult> {
  const stripe = getStripe();
  const result: ApplyResult = { applied: true, renamed: [], createdPrices: [], errors: [] };
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  for (const tier of tierApplyOrder(plan)) {
    try {
      const rename = plan.renames.find((r) => r.to === tier.slug);
      const sourceSlug = rename?.from ?? tier.slug;
      const productId = await ensureProduct(stripe, tier, bySlug.get(sourceSlug));
      const wanted = plan.prices.filter((p) => p.tierSlug === tier.slug);
      const ids: Record<string, string> = {};

      for (const p of wanted) {
        const price = await ensurePrice(stripe, productId, p, tier.slug);
        ids[p.interval] = price.id;
        if (price.created) {
          result.createdPrices.push({
            tierSlug: tier.slug,
            interval: p.interval,
            priceId: price.id,
            amount: p.unitAmount,
          });
        }
      }

      const { error } = await adminAny
        .from("seat_plans")
        .update({
          slug: tier.slug,
          name: tier.name,
          description: tier.blurb,
          price_cents: tierHeadlineCents(tier, "monthly"),
          currency: "AUD",
          seat_limit: tier.seatMax,
          stripe_price_id: ids.month ?? null,
          is_active: true,
          metadata: {
            tax_inclusive: true,
            gst_included: true,
            seat_min: tier.seatMin,
            seat_max: tier.seatMax,
            annual_price_cents: tierHeadlineCents(tier, "annual"),
            includes_aml_ctf: TIER_INCLUDES_AML,
            base_price_cents: tierBaseCents(tier, "monthly"),
            base_annual_price_cents: tierBaseCents(tier, "annual"),
            annual_stripe_price_id: ids.year ?? null,
          },
        })
        .eq("slug", sourceSlug);
      if (error) throw new Error(error.message);
      if (rename) result.renamed.push(rename);
    } catch (err) {
      result.errors.push(`${tier.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
