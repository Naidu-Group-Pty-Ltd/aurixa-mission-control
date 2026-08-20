// E6 — Region + plan policy per client. Admin-managed allowlists that gate
// which target regions and plan tiers a handoff may specify. Consumed by
// the handoff wizard preflight (round 2) and enforced server-side.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  allowed_regions: z.array(z.string()).default([]),
  allowed_plans: z.array(z.string()).default([]),
  min_plan: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
});

export const listHandoffPolicies = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("handoff_region_plan_policies")
      .select("*")
      .order("name", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });

export const upsertHandoffPolicy = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => upsertSchema.parse(input))
  .handler(async ({ data, context }) => {
    if (data.id) {
      const { error } = await context.supabase
        .from("handoff_region_plan_policies")
        .update({
          name: data.name,
          allowed_regions: data.allowed_regions,
          allowed_plans: data.allowed_plans,
          min_plan: data.min_plan ?? null,
          notes: data.notes ?? null,
          is_active: data.is_active ?? true,
        })
        .eq("id", data.id);
      if (error) throw error;
      return { ok: true as const, id: data.id };
    }
    const { data: inserted, error } = await context.supabase
      .from("handoff_region_plan_policies")
      .insert({
        name: data.name,
        allowed_regions: data.allowed_regions,
        allowed_plans: data.allowed_plans,
        min_plan: data.min_plan ?? null,
        notes: data.notes ?? null,
        is_active: data.is_active ?? true,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true as const, id: inserted.id };
  });

export const deleteHandoffPolicy = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("handoff_region_plan_policies")
      .delete()
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true as const };
  });
