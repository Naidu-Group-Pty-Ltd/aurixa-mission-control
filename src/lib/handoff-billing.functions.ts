// @ts-nocheck — 3 unresolved type errors (assignability ×2, argument types ×1).
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// G21 — Billing split.
// Records which invoices stay with Aurixa (seats, tokens, AI) versus what
// the client is now billed for directly by Supabase after handoff.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

export const upsertBillingSplit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        aurixa_stripe_customer_id: z.string().nullable().optional(),
        aurixa_stripe_subscription_id: z.string().nullable().optional(),
        aurixa_products_kept: z.array(z.string()).optional(),
        client_supabase_org_id: z.string().nullable().optional(),
        client_supabase_plan: z.string().nullable().optional(),
        client_billed_directly: z.boolean().optional(),
        disclosed_to_client: z.boolean().optional(),
        decoupled: z.boolean().optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: h, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, clone_id")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!h) return { ok: false as const, error: "handoff_not_found" };

    const patch: Record<string, unknown> = {
      aurixa_stripe_customer_id: data.aurixa_stripe_customer_id ?? null,
      aurixa_stripe_subscription_id: data.aurixa_stripe_subscription_id ?? null,
      aurixa_products_kept: data.aurixa_products_kept ?? [],
      client_supabase_org_id: data.client_supabase_org_id ?? null,
      client_supabase_plan: data.client_supabase_plan ?? null,
      client_billed_directly: data.client_billed_directly ?? false,
      notes: data.notes ?? null,
    };
    if (data.disclosed_to_client === true) patch.disclosed_to_client_at = new Date().toISOString();
    if (data.decoupled === true) patch.decoupled_at = new Date().toISOString();

    const { data: existing } = await context.supabase
      .from("handoff_billing_splits")
      .select("id")
      .eq("handoff_id", data.handoff_id)
      .maybeSingle();

    if (existing) {
      const { error } = await context.supabase
        .from("handoff_billing_splits")
        .update(patch)
        .eq("id", existing.id);
      if (error) throw error;
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        kind: "billing_split.updated",
        actor_user_id: context.userId,
        details: patch,
      });
      return { ok: true as const, id: existing.id, updated: true };
    }

    const { data: row, error } = await context.supabase
      .from("handoff_billing_splits")
      .insert({
        handoff_id: data.handoff_id,
        clone_id: h.clone_id,
        created_by: context.userId,
        ...patch,
      })
      .select("id")
      .single();
    if (error) throw error;
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "billing_split.configured",
      actor_user_id: context.userId,
      details: patch,
    });
    return { ok: true as const, id: row.id, updated: false };
  });

export const getBillingSplit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("handoff_billing_splits")
      .select("*")
      .eq("handoff_id", data.handoff_id)
      .maybeSingle();
    return { split: row ?? null };
  });

// Public helper for pricing/purchase pages — returns whether a given clone
// has a completed handoff with an active billing split so the UI can render
// the "your Supabase infrastructure is billed separately" disclosure.
export const getCloneBillingDisclosure = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ clone_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: split } = await supabaseAdmin
      .from("handoff_billing_splits")
      .select("client_billed_directly, decoupled_at, disclosed_to_client_at, client_supabase_plan")
      .eq("clone_id", data.clone_id)
      .maybeSingle();
    if (!split || !split.client_billed_directly) {
      return { split_active: false as const };
    }
    return {
      split_active: true as const,
      decoupled_at: split.decoupled_at,
      disclosed_to_client_at: split.disclosed_to_client_at,
      client_supabase_plan: split.client_supabase_plan,
    };
  });
