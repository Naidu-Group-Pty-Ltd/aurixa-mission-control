// Voice module operator API — the call log, live monitor, fleet registry,
// blacklist and alert rules. All reads go through the caller's own RLS-scoped
// client; anything that touches VAPI itself delegates to voice.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const CALL_FILTER_SCHEMA = z.object({
  search: z.string().max(200).default(""),
  agentId: z.string().max(100).default("all"),
  outcome: z.string().max(100).default("all"),
  direction: z.enum(["all", "inbound", "outbound"]).default("all"),
  intent: z.string().max(60).default("all"),
  squad: z.enum(["all", "squad", "non-squad"]).default("all"),
  sentiment: z.string().max(20).default("all"),
  tag: z.string().max(60).default("all"),
  startDate: z.string().max(40).default(""),
  endDate: z.string().max(40).default(""),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

type CallFilters = z.infer<typeof CALL_FILTER_SCHEMA>;

function applyCallFilters(q: any, data: CallFilters) {
  if (data.agentId !== "all") q = q.eq("agent_id", data.agentId);
  if (data.outcome !== "all") q = q.eq("call_outcome", data.outcome);
  if (data.direction !== "all") q = q.eq("call_direction", data.direction);
  if (data.intent !== "all") q = q.eq("call_intent", data.intent);
  if (data.squad === "squad") q = q.eq("is_squad_call", true);
  if (data.squad === "non-squad") q = q.eq("is_squad_call", false);
  if (data.sentiment !== "all") q = q.eq("sentiment", data.sentiment);
  if (data.tag !== "all") q = q.contains("tags", [data.tag]);
  // Failed/unanswered calls can have no started_at; fall back to created_at
  // so a date filter never hides exactly the calls worth investigating.
  if (data.startDate) {
    q = q.or(
      `started_at.gte.${data.startDate},and(started_at.is.null,created_at.gte.${data.startDate})`,
    );
  }
  if (data.endDate) {
    q = q.or(
      `started_at.lte.${data.endDate},and(started_at.is.null,created_at.lte.${data.endDate})`,
    );
  }
  if (data.search.trim()) {
    const term = data.search.trim().replace(/[%,()]/g, " ");
    q = q.or(
      `phone_number.ilike.%${term}%,customer_name.ilike.%${term}%,summary.ilike.%${term}%,agent_name.ilike.%${term}%,squad_name.ilike.%${term}%`,
    );
  }
  return q;
}

export const listCalls = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => CALL_FILTER_SCHEMA.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("voice_calls")
      .select(
        "id, vapi_call_id, agent_id, agent_name, phone_number, customer_name, call_direction, call_status, call_outcome, call_intent, is_squad_call, squad_id, squad_name, handoff_sequence, started_at, ended_at, duration_seconds, cost, sentiment, summary, tags, resolution_status, escalation_severity, account_id, contact_id, created_at",
        { count: "exact" },
      )
      .order("started_at", { ascending: false, nullsFirst: false })
      .range(data.offset, data.offset + data.limit - 1);
    q = applyCallFilters(q, data);
    const { data: rows, error, count } = await q;
    if (error) throw error;
    return { calls: rows ?? [], total: count ?? 0 };
  });

/** Aggregate stats over the same filter set (capped sample, computed here). */
export const callStats = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => CALL_FILTER_SCHEMA.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("voice_calls")
      .select("call_direction, call_outcome, duration_seconds, cost, is_squad_call, sentiment")
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(5000);
    q = applyCallFilters(q, { ...data, limit: 5000, offset: 0 });
    const { data: rows, error } = await q;
    if (error) throw error;

    const calls = rows ?? [];
    const isSuccess = (o: string | null) =>
      o === "completed" || o === "customer-ended-call" || o === "assistant-ended-call";
    const completed = calls.filter((c) => isSuccess(c.call_outcome)).length;
    const withDuration = calls.filter((c) => (c.duration_seconds ?? 0) > 0);
    return {
      total: calls.length,
      completed,
      successRate: calls.length > 0 ? Math.round((completed / calls.length) * 100) : 0,
      avgDurationSeconds:
        withDuration.length > 0
          ? Math.round(
              withDuration.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / withDuration.length,
            )
          : 0,
      totalCost: calls.reduce((s, c) => s + Number(c.cost ?? 0), 0),
      inbound: calls.filter((c) => c.call_direction === "inbound").length,
      outbound: calls.filter((c) => c.call_direction === "outbound").length,
      voicemail: calls.filter((c) => (c.call_outcome ?? "").includes("voicemail")).length,
      squad: calls.filter((c) => c.is_squad_call).length,
      negative: calls.filter((c) => c.sentiment === "negative").length,
    };
  });

export const getCall = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: call, error } = await context.supabase
      .from("voice_calls")
      .select("*, crm_accounts(id, name), crm_contacts(id, first_name, last_name)")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!call) throw new Error("call_not_found");
    return call;
  });

export const listLiveCalls = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("voice_calls")
      .select(
        "id, vapi_call_id, agent_id, agent_name, phone_number, customer_name, call_direction, call_status, started_at, is_squad_call, squad_name, call_intent",
      )
      .in("call_status", ["queued", "ringing", "in-progress", "forwarding"])
      .gte("created_at", cutoff)
      .order("started_at", { ascending: false, nullsFirst: false });
    if (error) throw error;
    return rows ?? [];
  });

export const updateCall = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        tags: z.array(z.string().max(60)).max(20).optional(),
        resolutionStatus: z.enum(["needs_review", "reviewed", "resolved", "escalated"]).optional(),
        resolutionNotes: z.string().max(4000).nullable().optional(),
        rootCauseCategory: z.string().max(60).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Database["public"]["Tables"]["voice_calls"]["Update"] = {};
    if (data.tags !== undefined) patch.tags = data.tags;
    if (data.resolutionStatus !== undefined) {
      patch.resolution_status = data.resolutionStatus;
      patch.reviewed_by = context.userId;
      patch.reviewed_at = new Date().toISOString();
    }
    if (data.resolutionNotes !== undefined) patch.resolution_notes = data.resolutionNotes;
    if (data.rootCauseCategory !== undefined) patch.root_cause_category = data.rootCauseCategory;
    const { error } = await context.supabase.from("voice_calls").update(patch).eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const deleteCall = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("voice_calls").delete().eq("id", data.id);
    if (error) throw error;
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "voice_call_deleted",
      entityType: "voice_call",
      entityId: data.id,
      actorUserId: context.userId,
    });
    return { ok: true };
  });

export const killCall = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: call, error } = await context.supabase
      .from("voice_calls")
      .select("id, vapi_call_id, call_status")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!call) throw new Error("call_not_found");
    if (!["queued", "ringing", "in-progress", "forwarding"].includes(call.call_status ?? "")) {
      throw new Error("call_not_live");
    }
    const { killLiveCall } = await import("@/server/voice.server");
    const outcome = await killLiveCall(call.vapi_call_id);
    if (outcome.result === "terminated") {
      const { error: updateError } = await context.supabase
        .from("voice_calls")
        .update({ call_status: "ended", call_outcome: "killed" })
        .eq("id", data.id);
      if (updateError) throw updateError;
    }
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "voice_call_killed",
      entityType: "voice_call",
      entityId: data.id,
      actorUserId: context.userId,
      metadata: { result: outcome.result, detail: outcome.detail },
    });
    return outcome;
  });

/** R2 recording URLs expire; re-read the call from VAPI for a fresh one. */
export const refreshRecordingUrl = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: call, error } = await context.supabase
      .from("voice_calls")
      .select("vapi_call_id, recording_url")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!call) throw new Error("call_not_found");
    const { freshRecordingUrl } = await import("@/server/voice.server");
    const fresh = await freshRecordingUrl(call.vapi_call_id);
    if (fresh && fresh !== call.recording_url) {
      const { error: updateError } = await context.supabase
        .from("voice_calls")
        .update({ recording_url: fresh })
        .eq("id", data.id);
      if (updateError) console.error("recording url store failed:", updateError.message);
    }
    return { url: fresh ?? call.recording_url ?? null };
  });

/* ------------------------------ fleet registry ----------------------------- */

export const getFleet = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    const [agents, squads, phones] = await Promise.all([
      context.supabase.from("voice_agents").select("*").order("name"),
      context.supabase.from("voice_squads").select("*").order("name"),
      context.supabase.from("voice_phone_numbers").select("*").order("label"),
    ]);
    if (agents.error) throw agents.error;
    if (squads.error) throw squads.error;
    if (phones.error) throw phones.error;
    return { agents: agents.data ?? [], squads: squads.data ?? [], phones: phones.data ?? [] };
  });

export const upsertAgent = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        vapiAssistantId: z.string().min(4).max(80),
        name: z.string().min(1).max(120),
        role: z.string().max(60).nullable().optional(),
        direction: z.enum(["inbound", "outbound", "both"]).default("both"),
        squadId: uuid.nullable().optional(),
        isActive: z.boolean().default(true),
        description: z.string().max(1000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const row = {
      vapi_assistant_id: data.vapiAssistantId,
      name: data.name,
      role: data.role ?? null,
      direction: data.direction,
      squad_id: data.squadId ?? null,
      is_active: data.isActive,
      description: data.description ?? null,
    };
    const { error } = data.id
      ? await context.supabase.from("voice_agents").update(row).eq("id", data.id)
      : await context.supabase
          .from("voice_agents")
          .upsert(row, { onConflict: "vapi_assistant_id" });
    if (error) throw error;
    return { ok: true };
  });

/* -------------------------------- blacklist -------------------------------- */

export const listBlacklist = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("voice_blacklist")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return rows ?? [];
  });

export const upsertBlacklistEntry = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        phoneNumber: z.string().min(6).max(30),
        category: z.enum(["spam", "scam", "telemarketer", "abusive", "other"]).default("other"),
        killMode: z.enum(["silent", "announce"]).default("silent"),
        announceMessage: z.string().max(300).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
        isActive: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { normalizePhone } = await import("@/server/voice.server");
    const row = {
      phone_number: data.phoneNumber,
      normalized_number: normalizePhone(data.phoneNumber),
      category: data.category,
      kill_mode: data.killMode,
      announce_message: data.announceMessage ?? null,
      notes: data.notes ?? null,
      is_active: data.isActive,
      created_by: context.userId,
    };
    const { error } = data.id
      ? await context.supabase.from("voice_blacklist").update(row).eq("id", data.id)
      : await context.supabase
          .from("voice_blacklist")
          .upsert(row, { onConflict: "normalized_number" });
    if (error) throw error;
    return { ok: true };
  });

export const deleteBlacklistEntry = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("voice_blacklist").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/* ------------------------------- alert rules ------------------------------- */

export const listAlertRules = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    const [rules, history] = await Promise.all([
      context.supabase.from("voice_alert_rules").select("*").order("created_at"),
      context.supabase
        .from("voice_alert_history")
        .select("*")
        .order("triggered_at", { ascending: false })
        .limit(50),
    ]);
    if (rules.error) throw rules.error;
    if (history.error) throw history.error;
    return { rules: rules.data ?? [], history: history.data ?? [] };
  });

export const upsertAlertRule = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        name: z.string().min(1).max(120),
        conditionType: z.enum([
          "outcome",
          "sentiment",
          "intent",
          "duration_gt",
          "duration_lt",
          "cost_gt",
          "escalation_gte",
        ]),
        conditionValue: z.string().min(1).max(120),
        isPositive: z.boolean().default(false),
        isEnabled: z.boolean().default(true),
        notifyOperators: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const row = {
      name: data.name,
      condition_type: data.conditionType,
      condition_value: data.conditionValue,
      is_positive: data.isPositive,
      is_enabled: data.isEnabled,
      notify_operators: data.notifyOperators,
    };
    const { error } = data.id
      ? await context.supabase.from("voice_alert_rules").update(row).eq("id", data.id)
      : await context.supabase.from("voice_alert_rules").insert(row);
    if (error) throw error;
    return { ok: true };
  });

export const deleteAlertRule = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("voice_alert_rules").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const listCallTags = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("voice_call_tags")
      .select("*")
      .order("name");
    if (error) throw error;
    return rows ?? [];
  });

/** Export rows for CSV, using the current filters (capped at 2000). */
export const exportCalls = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => CALL_FILTER_SCHEMA.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("voice_calls")
      .select(
        "vapi_call_id, customer_name, phone_number, agent_name, call_direction, call_outcome, sentiment, duration_seconds, cost, squad_name, call_intent, started_at, summary",
      )
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(2000);
    q = applyCallFilters(q, { ...data, limit: 2000, offset: 0 });
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export type VoiceCallRow = Awaited<ReturnType<typeof listCalls>>["calls"][number];
export type { Json };
