// Server-only core for cascade schedules. Two kinds:
//   - fleet_cascade: cascade prime → all clones with installed modules.
//   - module_sync:   bulk install + scoped cascade for a specific module.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { executeCascade } from "./cascade-engine.server";
import { bulkSyncModule } from "./module-sync.server";
import { applyBrandToClone } from "./branding.server";
import { nextCronTick } from "@/lib/cron";
import { assessBlastRadius } from "./cascade-approvals.server";

type SupabaseLike = SupabaseClient<Database>;
type CascadeMode = Database["public"]["Enums"]["cascade_mode"];
type CascadeScheduleRow = Database["public"]["Tables"]["cascade_schedules"]["Row"];

export type ScheduleRunOutcome = {
  schedule_id: string;
  name: string;
  ok: boolean;
  cascade_event_id: string | null;
  error?: string;
};

export type RunDueResult = {
  ok: boolean;
  ran: number;
  outcomes: ScheduleRunOutcome[];
  error?: string;
};

export async function runScheduleNow(
  supabase: SupabaseLike,
  scheduleId: string,
  initiatedBy: string | null,
): Promise<ScheduleRunOutcome> {
  const { data, error } = await supabase
    .from("cascade_schedules")
    .select("*")
    .eq("id", scheduleId)
    .maybeSingle();
  if (error || !data) {
    return {
      schedule_id: scheduleId,
      name: "(unknown)",
      ok: false,
      cascade_event_id: null,
      error: (error?.message as string) ?? "Schedule not found",
    };
  }
  return executeOne(supabase, data as CascadeScheduleRow, initiatedBy);
}

export async function runDueSchedules(supabase: SupabaseLike): Promise<RunDueResult> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("cascade_schedules")
    .select("*")
    .eq("enabled", true)
    .or(`next_run_at.is.null,next_run_at.lte.${now}`);
  if (error) return { ok: false, ran: 0, outcomes: [], error: error.message as string };
  const due = (data ?? []) as CascadeScheduleRow[];
  if (due.length === 0) return { ok: true, ran: 0, outcomes: [] };

  const outcomes: ScheduleRunOutcome[] = [];
  for (const s of due) {
    outcomes.push(await executeOne(supabase, s, null));
  }
  return { ok: true, ran: outcomes.length, outcomes };
}

async function executeOne(
  supabase: SupabaseLike,
  sched: CascadeScheduleRow,
  initiatedBy: string | null,
): Promise<ScheduleRunOutcome> {
  const startedAt = new Date().toISOString();
  let outcome: ScheduleRunOutcome;
  try {
    if (sched.kind === "fleet_cascade") {
      outcome = await runFleetCascade(supabase, sched, initiatedBy);
    } else if (sched.kind === "brand_sync") {
      outcome = await runBrandSyncSchedule(supabase, sched, initiatedBy);
    } else {
      outcome = await runModuleSyncSchedule(supabase, sched, initiatedBy);
    }
  } catch (e) {
    outcome = {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: e instanceof Error ? e.message : "Schedule run failed",
    };
  }

  const next = nextCronTick(sched.cron_expression, new Date());
  await supabase
    .from("cascade_schedules")
    .update({
      last_run_at: startedAt,
      next_run_at: next ? next.toISOString() : null,
      last_cascade_event_id: outcome.cascade_event_id,
    })
    .eq("id", sched.id);

  await supabase.from("audit_log").insert({
    action: "schedule.executed",
    entity_type: "cascade_schedule",
    entity_id: sched.id,
    actor_user_id: initiatedBy,
    metadata: {
      kind: sched.kind,
      cron: sched.cron_expression,
      ok: outcome.ok,
      error: outcome.error ?? null,
      cascade_event_id: outcome.cascade_event_id,
    },
  });

  return outcome;
}

async function runFleetCascade(
  supabase: SupabaseLike,
  sched: CascadeScheduleRow,
  initiatedBy: string | null,
): Promise<ScheduleRunOutcome> {
  const { data: clones, error: clonesErr } = await supabase.from("clones").select("id");
  if (clonesErr) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: clonesErr.message,
    };
  }
  if (!clones || clones.length === 0) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: "No clones registered",
    };
  }

  const blast = assessBlastRadius(sched.mode, clones.length);

  const { data: ev, error: evErr } = await supabase
    .from("cascade_events")
    .insert({
      trigger: "scheduled",
      mode: sched.mode,
      status: "pending",
      requires_approval: blast.requiresApproval,
      scope_filter: {
        scope: "scheduled_fleet",
        schedule_id: sched.id,
        schedule_name: sched.name,
      },
      summary: `Scheduled · ${sched.name}`,
      initiated_by: initiatedBy,
    })
    .select()
    .single();
  if (evErr || !ev) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: evErr?.message ?? "Event insert failed",
    };
  }

  await supabase.from("cascade_results").insert(
    clones.map((c) => ({
      cascade_event_id: ev.id,
      clone_id: c.id,
      status: "queued" as const,
    })),
  );

  // Blast-radius gate — pin a notification & skip engine until a second
  // operator approves on /cascades/$eventId.
  if (blast.requiresApproval) {
    await supabase.from("notifications").insert({
      kind: "cascade_awaiting_approval",
      severity: "warning",
      title: `Approval needed · scheduled ${sched.mode.replace("_", " ")} cascade`,
      body: `${blast.reason ?? ""} Triggered by schedule "${sched.name}".`,
      cascade_event_id: ev.id,
      url: `/cascades/${ev.id}`,
      metadata: {
        mode: sched.mode,
        clone_count: clones.length,
        schedule_id: sched.id,
        trigger: "scheduled",
      },
    });
    await supabase.from("audit_log").insert({
      action: "cascade.awaiting_approval",
      entity_type: "cascade_event",
      entity_id: ev.id,
      actor_user_id: initiatedBy,
      metadata: {
        mode: sched.mode,
        trigger: "scheduled",
        schedule_id: sched.id,
        clone_count: clones.length,
        reason: blast.reason,
      },
    });
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: true,
      cascade_event_id: ev.id,
      error: blast.reason ?? "Awaiting second-operator approval",
    };
  }

  const res = await executeCascade(supabase, ev.id);
  return {
    schedule_id: sched.id,
    name: sched.name,
    ok: res.ok,
    cascade_event_id: ev.id,
    error: res.ok ? undefined : res.error,
  };
}

async function runModuleSyncSchedule(
  supabase: SupabaseLike,
  sched: CascadeScheduleRow,
  initiatedBy: string | null,
): Promise<ScheduleRunOutcome> {
  const sf = (sched.scope_filter ?? {}) as {
    module_id?: string;
    clone_ids?: string[] | "all";
  };
  const moduleId = sf.module_id;
  if (!moduleId) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: "scope_filter.module_id missing",
    };
  }

  let cloneIds: string[];
  if (sf.clone_ids && sf.clone_ids !== "all" && Array.isArray(sf.clone_ids)) {
    cloneIds = sf.clone_ids;
  } else {
    const { data: cm } = await supabase
      .from("clone_modules")
      .select("clone_id")
      .eq("module_id", moduleId);
    cloneIds = (cm ?? []).map((r) => r.clone_id);
  }

  if (cloneIds.length === 0) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: "No clones target this module",
    };
  }

  const res = await bulkSyncModule({
    supabase,
    moduleId,
    cloneIds,
    action: "install",
    cascade: true,
    cascadeMode: sched.mode as CascadeMode,
    initiatedBy,
  });
  return {
    schedule_id: sched.id,
    name: sched.name,
    ok: res.ok,
    cascade_event_id: res.cascade_event_id,
    error: res.ok ? undefined : res.error,
  };
}

/**
 * brand_sync schedule. scope_filter shape:
 *   { profile_id?: string, clone_ids?: string[] | "drifted" | "all" }
 *
 * Behaviour:
 *   - profile_id required. Targets a single brand profile.
 *   - clone_ids "drifted" (default): only clones whose assignment.status is
 *     'pending', 'drifted', or 'failed'.
 *   - clone_ids "all": every clone currently assigned to the profile.
 *   - clone_ids array: explicit list (must already be assigned).
 *
 * Re-uses applyBrandToClone so the brand cascade behaves identically to a
 * manual push from the UI. Honors blast-radius gate via scheduled-fleet
 * cascade_event when the count is large.
 */
async function runBrandSyncSchedule(
  supabase: SupabaseLike,
  sched: CascadeScheduleRow,
  initiatedBy: string | null,
): Promise<ScheduleRunOutcome> {
  const sf = (sched.scope_filter ?? {}) as {
    profile_id?: string;
    clone_ids?: string[] | "drifted" | "all";
  };

  if (!sf.profile_id) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: false,
      cascade_event_id: null,
      error: "scope_filter.profile_id missing",
    };
  }

  // Resolve target clones from the assignment table.
  const target = sf.clone_ids ?? "drifted";
  let cloneIds: string[];

  if (Array.isArray(target)) {
    cloneIds = target;
  } else {
    let q = supabase
      .from("clone_brand_assignments")
      .select("clone_id, status")
      .eq("profile_id", sf.profile_id);
    if (target === "drifted") {
      q = q.in("status", ["pending", "drifted", "failed"]);
    }
    const { data, error } = await q;
    if (error) {
      return {
        schedule_id: sched.id,
        name: sched.name,
        ok: false,
        cascade_event_id: null,
        error: error.message,
      };
    }
    cloneIds = (data ?? []).map((r) => r.clone_id);
  }

  if (cloneIds.length === 0) {
    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: true,
      cascade_event_id: null,
      error: target === "drifted" ? "No drifted clones" : "No clones to sync",
    };
  }

  // Brand pushes are irreversible — treat as auto_merge for blast-radius gating.
  const blast = assessBlastRadius("auto_merge", cloneIds.length);
  if (blast.requiresApproval) {
    // Create a tracking event in pending state and notify; operator can
    // approve from /cascades/$eventId then trigger manually.
    const { data: ev } = await supabase
      .from("cascade_events")
      .insert({
        trigger: "scheduled",
        mode: "auto_merge" as CascadeMode,
        status: "pending",
        requires_approval: true,
        scope_filter: {
          scope: "scheduled_brand_sync",
          schedule_id: sched.id,
          schedule_name: sched.name,
          profile_id: sf.profile_id,
          clone_ids: cloneIds,
        },
        summary: `Scheduled brand sync · ${sched.name}`,
        initiated_by: initiatedBy,
      })
      .select()
      .single();

    if (ev) {
      await supabase.from("notifications").insert({
        kind: "cascade_awaiting_approval",
        severity: "warning",
        title: `Approval needed · scheduled brand sync`,
        body: `${blast.reason ?? ""} Schedule "${sched.name}" targeting ${cloneIds.length} clones.`,
        cascade_event_id: ev.id,
        url: `/cascades/${ev.id}`,
        metadata: {
          mode: "auto_merge",
          clone_count: cloneIds.length,
          schedule_id: sched.id,
          profile_id: sf.profile_id,
          trigger: "scheduled_brand_sync",
        },
      });
    }

    return {
      schedule_id: sched.id,
      name: sched.name,
      ok: true,
      cascade_event_id: ev?.id ?? null,
      error: blast.reason ?? "Awaiting second-operator approval",
    };
  }

  // Run the brand apply pipeline per clone.
  let succeeded = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const cloneId of cloneIds) {
    const r = await applyBrandToClone(supabase, {
      cloneId,
      profileId: sf.profile_id,
      actorUserId: initiatedBy,
      cascadeEventId: null,
    });
    if (r.ok) succeeded++;
    else {
      failed++;
      failures.push(`${cloneId}: ${r.error}`);
    }
  }

  // One summary notification per scheduled run.
  await supabase.from("notifications").insert({
    kind: failed === 0 ? "cascade_completed" : "cascade_partial",
    severity: failed === 0 ? "success" : "warning",
    title: `Scheduled brand sync · ${succeeded}/${cloneIds.length} clones`,
    body:
      failed === 0
        ? `Schedule "${sched.name}" applied brand to ${succeeded} clone(s).`
        : `Schedule "${sched.name}": ${succeeded} succeeded, ${failed} failed.`,
    url: "/branding",
    metadata: {
      schedule_id: sched.id,
      profile_id: sf.profile_id,
      succeeded,
      failed,
      trigger: "scheduled_brand_sync",
    },
  });

  return {
    schedule_id: sched.id,
    name: sched.name,
    ok: failed === 0,
    cascade_event_id: null,
    error: failed === 0 ? undefined : failures.slice(0, 5).join(" | "),
  };
}
