// Operator queries over the purchases attribution ledger
// (user-attributed pricing workflow, Phase 4; see
// docs/user-tracking-pricing-workflow-plan.md).
//
// Reads go through the service-role client (the purchases table only has an
// operator-read RLS policy, and these fns are requireOperator-gated anyway)
// so we can embed the clone relation regardless of the caller's RLS view.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { reconcilePurchasesFromStripe } from "@/server/purchase-backfill.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { aggregatePurchases } from "@/lib/purchase-rollups";

const adminAny = supabaseAdmin;

// Stripe purchase modes + the discretionary admin_* actions recorded by
// recordAdminAction — both filterable in the purchases explorer.
const MODES = [
  "topup",
  "seat_plan",
  "setup_package",
  "admin_grant",
  "admin_topup",
  "admin_plan_change",
  "admin_seat_change",
] as const;
const STATUSES = ["initiated", "completed", "failed", "refunded", "abandoned"] as const;

const ListSchema = z.object({
  cloneId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  mode: z.enum(MODES).optional(),
  status: z.enum(STATUSES).optional(),
  originSource: z.string().max(100).optional(),
  /** Matches origin_user_id, origin_username, or item_slug (ilike). */
  search: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type PurchaseListRow = {
  id: string;
  created_at: string;
  completed_at: string | null;
  status: string;
  mode: string;
  item_slug: string | null;
  quantity: number;
  amount_cents: number | null;
  currency: string | null;
  clone_id: string | null;
  clone_name: string | null;
  tenant_id: string | null;
  origin_user_id: string | null;
  origin_username: string | null;
  origin_source: string;
  stripe_checkout_session_id: string | null;
};

export const listPurchases = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => ListSchema.parse(input))
  .handler(async ({ data }) => {
    let q = adminAny
      .from("purchases")
      .select(
        "id, created_at, completed_at, status, mode, item_slug, quantity, amount_cents, currency, clone_id, tenant_id, origin_user_id, origin_username, origin_source, stripe_checkout_session_id, clones(name)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);

    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    if (data.tenantId) q = q.eq("tenant_id", data.tenantId);
    if (data.mode) q = q.eq("mode", data.mode);
    if (data.status) q = q.eq("status", data.status);
    if (data.originSource) q = q.eq("origin_source", data.originSource);
    if (data.from) q = q.gte("created_at", data.from);
    if (data.to) q = q.lte("created_at", data.to);
    if (data.search) {
      const term = data.search.replaceAll("%", "\\%").replaceAll(",", " ");
      q = q.or(
        `origin_user_id.ilike.%${term}%,origin_username.ilike.%${term}%,item_slug.ilike.%${term}%`,
      );
    }

    const { data: rows, count, error } = await q;
    if (error) return { ok: false as const, error: error.message };

    const purchases: PurchaseListRow[] = (rows ?? []).map((r: any) => ({
      ...r,
      clone_name: r.clones?.name ?? null,
      clones: undefined,
    }));
    return {
      ok: true as const,
      purchases,
      total: count ?? 0,
      hasMore: data.offset + purchases.length < (count ?? 0),
    };
  });

/** Distinct origin sources present in the ledger — feeds the filter dropdown. */
export const listPurchaseSources = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async () => {
    const { data: rows, error } = await adminAny
      .from("purchases")
      .select("origin_source")
      .order("origin_source", { ascending: true })
      .limit(2000);
    if (error) return { ok: false as const, error: error.message, sources: [] as string[] };
    const sources = [...new Set((rows ?? []).map((r: any) => r.origin_source))];
    return { ok: true as const, sources };
  });

const ROLLUP_ROW_CAP = 5000;

export const purchaseRollups = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        days: z.number().int().min(1).max(365).default(30),
        cloneId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    let q = adminAny
      .from("purchases")
      .select(
        "amount_cents, currency, mode, status, clone_id, origin_source, origin_user_id, origin_username, clones(name)",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(ROLLUP_ROW_CAP);
    if (data.cloneId) q = q.eq("clone_id", data.cloneId);

    const { data: rows, error } = await q;
    if (error) return { ok: false as const, error: error.message };

    const rollups = aggregatePurchases(
      (rows ?? []).map((r: any) => ({ ...r, clone_name: r.clones?.name ?? null })),
    );
    return {
      ok: true as const,
      days: data.days,
      truncated: (rows ?? []).length >= ROLLUP_ROW_CAP,
      ...rollups,
    };
  });

/** Lifetime purchase summary for one clone — feeds the clone detail card. */
export const clonePurchaseSummary = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ cloneId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: rows, error } = await adminAny
      .from("purchases")
      .select(
        "id, created_at, status, mode, item_slug, quantity, amount_cents, currency, origin_user_id, origin_username, origin_source",
      )
      .eq("clone_id", data.cloneId)
      .order("created_at", { ascending: false })
      .limit(ROLLUP_ROW_CAP);
    if (error) return { ok: false as const, error: error.message };

    const all = rows ?? [];
    const rollups = aggregatePurchases(all as never);
    return {
      ok: true as const,
      lifetimeRevenueByCurrency: rollups.revenueByCurrency,
      completedCount: rollups.completedCount,
      attributedCount: rollups.attributedCount,
      adminActionCount: rollups.adminActionCount,
      recent: all.slice(0, 5),
    };
  });

/**
 * Rebuilds missing `purchases` rows from Stripe for a date window.
 *
 * Admin-gated, matching gift-tokens: this repairs the reporting ledger, but it
 * grants nothing and moves no money. Defaults to a dry run — the caller has to
 * ask for the write explicitly, so an accidental click reports instead of
 * mutating the ledger.
 */
export const backfillPurchases = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        since: z.string().datetime(),
        until: z.string().datetime().optional(),
        apply: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    try {
      const report = await reconcilePurchasesFromStripe({
        since: new Date(data.since),
        until: data.until ? new Date(data.until) : undefined,
        dryRun: !data.apply,
      });
      return { ok: true as const, dryRun: !data.apply, ...report };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
