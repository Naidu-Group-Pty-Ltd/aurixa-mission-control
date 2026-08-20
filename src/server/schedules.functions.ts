import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runScheduleNow as runScheduleNowImpl, type ScheduleRunOutcome } from "./schedules.server";
import { nextCronTick, parseCron } from "@/lib/cron";
import type { Database, Json } from "@/integrations/supabase/types";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];
type ScheduleKind = "fleet_cascade" | "module_sync" | "brand_sync";
type CascadeScheduleRow = Database["public"]["Tables"]["cascade_schedules"]["Row"];

export type CreateScheduleInput = {
  name: string;
  kind: ScheduleKind;
  cron_expression: string;
  mode: CascadeMode;
  scope_filter?: Record<string, unknown>;
  enabled?: boolean;
  notes?: string | null;
};

export const createSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: CreateScheduleInput) => {
    if (!data?.name || data.name.length < 1 || data.name.length > 120) {
      throw new Error("name required (1-120 chars)");
    }
    if (
      data.kind !== "fleet_cascade" &&
      data.kind !== "module_sync" &&
      data.kind !== "brand_sync"
    ) {
      throw new Error("kind must be fleet_cascade, module_sync, or brand_sync");
    }
    if (!parseCron(data.cron_expression ?? "")) {
      throw new Error("invalid cron expression (expected 5 fields)");
    }
    if (!["pr", "auto_merge", "notify"].includes(data.mode)) {
      throw new Error("mode invalid");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    const next = nextCronTick(data.cron_expression);
    const { data: row, error } = await context.supabase
      .from("cascade_schedules")
      .insert({
        name: data.name,
        kind: data.kind,
        cron_expression: data.cron_expression,
        mode: data.mode,
        scope_filter: (data.scope_filter ?? {}) as Json,
        enabled: data.enabled ?? true,
        notes: data.notes ?? null,
        next_run_at: next ? next.toISOString() : null,
        created_by: context.userId,
      })
      .select()
      .single();
    if (error) return { ok: false as const, error: error.message as string };
    const created = row as CascadeScheduleRow;
    await context.supabase.from("audit_log").insert({
      action: "schedule.created",
      entity_type: "cascade_schedule",
      entity_id: created.id,
      actor_user_id: context.userId,
      metadata: { kind: data.kind, cron: data.cron_expression },
    });
    return { ok: true as const, schedule: created };
  });

export const updateSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { id: string; patch: Partial<CreateScheduleInput> & { enabled?: boolean } }) => {
      if (!data?.id) throw new Error("id required");
      if (data.patch?.cron_expression && !parseCron(data.patch.cron_expression)) {
        throw new Error("invalid cron expression");
      }
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    const patch = {
      ...data.patch,
    } as Database["public"]["Tables"]["cascade_schedules"]["Update"];
    if (data.patch.cron_expression) {
      const next = nextCronTick(data.patch.cron_expression);
      patch.next_run_at = next ? next.toISOString() : null;
    }
    const { error } = await context.supabase
      .from("cascade_schedules")
      .update(patch)
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message as string };
    return { ok: true as const };
  });

export const deleteSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("cascade_schedules").delete().eq("id", data.id);
    if (error) return { ok: false as const, error: error.message as string };
    await context.supabase.from("audit_log").insert({
      action: "schedule.deleted",
      entity_type: "cascade_schedule",
      entity_id: data.id,
      actor_user_id: context.userId,
      metadata: {},
    });
    return { ok: true as const };
  });

export const runScheduleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }): Promise<ScheduleRunOutcome> => {
    return runScheduleNowImpl(context.supabase, data.id, context.userId);
  });
