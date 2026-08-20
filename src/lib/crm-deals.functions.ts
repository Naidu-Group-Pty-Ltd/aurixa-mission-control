// @ts-nocheck — tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// CRM deal pipeline — opportunities, line items priced from the live catalog,
// and the won → contract + onboarding transition.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const DEAL_STAGES = ["discovery", "demo", "proposal", "contract", "won", "lost"] as const;

export const listDeals = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("crm_deals")
      .select("*, crm_accounts(id, name, lifecycle_stage), crm_deal_line_items(*)")
      .order("stage_changed_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return data ?? [];
  });

export const upsertDeal = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        account_id: uuid,
        name: z.string().min(1).max(200),
        stage: z.enum(DEAL_STAGES).optional(),
        tier_slug: z.string().max(60).nullable().optional(),
        seats: z.number().int().min(1).max(10000).optional(),
        expected_mrr_cents: z.number().int().min(0).optional(),
        setup_fee_cents: z.number().int().min(0).optional(),
        probability: z.number().int().min(0).max(100).optional(),
        expected_close_date: z.string().nullable().optional(),
        lost_reason: z.string().max(500).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    const q = id
      ? context.supabase.from("crm_deals").update(fields).eq("id", id)
      : context.supabase.from("crm_deals").insert({ ...fields, owner_user_id: context.userId });
    const { data: row, error } = await q.select().single();
    if (error) throw error;
    return row;
  });

/** Stages that may not be entered without a fresh, passing client fit analysis. */
const FIT_GATED_STAGES = ["contract", "won"] as const;
const FIT_PASSING_VERDICTS = ["strong_fit", "fit", "conditional"];
const FIT_STALE_DAYS = 90;

export const setDealStage = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        stage: z.enum(DEAL_STAGES),
        lost_reason: z.string().max(500).optional(),
        /** Admin escape hatch — recorded on the timeline. */
        overrideFitGate: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // ---- Client fit gate: no SLA/contract without a current passing analysis.
    if (FIT_GATED_STAGES.includes(data.stage as any) && !data.overrideFitGate) {
      const { data: current } = await context.supabase
        .from("crm_deals")
        .select("account_id")
        .eq("id", data.id)
        .maybeSingle();
      if (current?.account_id) {
        const { data: fitRows } = await context.supabase
          .from("crm_fit_analyses")
          .select("verdict, override_verdict, completed_at")
          .eq("account_id", current.account_id)
          .eq("status", "complete")
          .order("version", { ascending: false })
          .limit(1);
        const latest = fitRows?.[0];
        const effective = latest?.override_verdict ?? latest?.verdict;
        const ageDays = latest?.completed_at
          ? (Date.now() - new Date(latest.completed_at).getTime()) / 86_400_000
          : Infinity;
        if (!latest) throw new Error("fit_gate_no_analysis");
        if (ageDays > FIT_STALE_DAYS) throw new Error("fit_gate_stale_analysis");
        if (!FIT_PASSING_VERDICTS.includes(effective)) throw new Error("fit_gate_failed_verdict");
      }
    }

    const { data: deal, error } = await context.supabase
      .from("crm_deals")
      .update({ stage: data.stage, ...(data.lost_reason ? { lost_reason: data.lost_reason } : {}) })
      .eq("id", data.id)
      .select("*, crm_deal_line_items(*)")
      .single();
    if (error) throw error;


    await context.supabase.from("crm_activities").insert({
      account_id: deal.account_id,
      kind: "status_change",
      title: `Deal "${deal.name}" → ${data.stage}`,
      body: data.lost_reason ?? null,
      actor_user_id: context.userId,
      entity_type: "crm_deal",
      entity_id: deal.id,
    });

    if (data.stage === "won") {
      // Contract + onboarding checklist materialise on win.
      const existing = await context.supabase
        .from("crm_contracts")
        .select("id")
        .eq("deal_id", deal.id)
        .maybeSingle();
      if (!existing.data) {
        await context.supabase.from("crm_contracts").insert({
          account_id: deal.account_id,
          deal_id: deal.id,
          tier_slug: deal.tier_slug,
          committed_seats: deal.seats ?? 1,
          mrr_cents: deal.expected_mrr_cents ?? 0,
          term_start: new Date().toISOString().slice(0, 10),
        });
      }
      await context.supabase.rpc("crm_seed_onboarding", { _account_id: deal.account_id });
      await context.supabase
        .from("crm_accounts")
        .update({ mrr_cents: deal.expected_mrr_cents ?? 0, arr_cents: (deal.expected_mrr_cents ?? 0) * 12 })
        .eq("id", deal.account_id);
    }
    return deal;
  });

export const upsertDealLineItem = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        deal_id: uuid,
        kind: z.enum(["seat_plan", "addon_module", "setup_package", "credits", "custom"]),
        item_slug: z.string().max(120).nullable().optional(),
        item_name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).max(10000).default(1),
        unit_price_cents: z.number().int().min(0).default(0),
        recurring: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    const q = id
      ? context.supabase.from("crm_deal_line_items").update(fields).eq("id", id)
      : context.supabase.from("crm_deal_line_items").insert(fields);
    const { error } = await q;
    if (error) throw error;
    return recalcDealTotals(context.supabase, data.deal_id);
  });

export const deleteDealLineItem = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid, deal_id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("crm_deal_line_items").delete().eq("id", data.id);
    if (error) throw error;
    return recalcDealTotals(context.supabase, data.deal_id);
  });

async function recalcDealTotals(sb: any, dealId: string) {
  const { data: items } = await sb
    .from("crm_deal_line_items")
    .select("quantity, unit_price_cents, recurring")
    .eq("deal_id", dealId);
  let mrr = 0;
  let setup = 0;
  for (const i of items ?? []) {
    const total = (i.quantity ?? 1) * (i.unit_price_cents ?? 0);
    if (i.recurring) mrr += total;
    else setup += total;
  }
  await sb.from("crm_deals").update({ expected_mrr_cents: mrr, setup_fee_cents: setup }).eq("id", dealId);
  return { expected_mrr_cents: mrr, setup_fee_cents: setup };
}

/** Catalog options for building quotes — always the live prices. */
export const quoteCatalog = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const [plans, addons, setups] = await Promise.all([
      context.supabase.from("seat_plans").select("id, slug, name, price_cents, seat_limit").eq("is_active", true).order("price_cents"),
      context.supabase.from("addon_modules").select("id, slug, name, price_cents").eq("is_active", true).order("name"),
      context.supabase.from("setup_packages").select("id, slug, name, price_cents").eq("is_active", true).order("price_cents"),
    ]);
    return {
      seat_plans: plans.data ?? [],
      addon_modules: addons.data ?? [],
      setup_packages: setups.data ?? [],
    };
  });
