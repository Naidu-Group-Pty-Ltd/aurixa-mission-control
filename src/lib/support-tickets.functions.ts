// @ts-nocheck
// Server functions for the Support Ops surface: ticket queue, ticket
// detail, the human-validation gate on parked remediation runs, priority
// overrides and manual resolution. Operators read; admins act — the same
// split the codex remediation surface uses.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import {
  BREAKAGE_VECTORS,
  PRIORITY_SLA_MINUTES,
  TICKET_PRIORITIES,
} from "@/lib/ticket-classification";

const ListInput = z.object({
  status: z.string().max(40).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const listSupportTickets = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("support_tickets")
      .select(
        "id, reference, workspace_id, clone_id, category, breakage_vector, subject, priority, priority_score, status, requires_human, auto_remediable, remediation_lane, sla_due_at, sla_breached_at, resolved_at, created_at, clones(name, slug)",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status) query = query.eq("status", data.status);
    if (data.priority) query = query.eq("priority", data.priority);
    if (data.search) {
      const term = data.search.replace(/[%_]/g, "");
      query = query.or(
        `reference.ilike.%${term}%,subject.ilike.%${term}%,workspace_id.ilike.%${term}%`,
      );
    }
    const { data: tickets, error } = await query;
    if (error) throw error;

    // Queue KPIs — cheap enough to piggyback on every list call.
    const { data: openRows } = await context.supabase
      .from("support_tickets")
      .select("priority, status")
      .not("status", "in", "(resolved,closed)");
    const openByPriority: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
    let awaitingValidation = 0;
    for (const row of openRows ?? []) {
      openByPriority[row.priority] = (openByPriority[row.priority] ?? 0) + 1;
      if (row.status === "awaiting_validation") awaitingValidation += 1;
    }

    return { tickets: tickets ?? [], openByPriority, awaitingValidation };
  });

const DetailInput = z.object({ ticketId: z.string().uuid() });

export const getSupportTicketDetail = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d) => DetailInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: ticket, error } = await context.supabase
      .from("support_tickets")
      .select("*, clones(name, slug)")
      .eq("id", data.ticketId)
      .maybeSingle();
    if (error) throw error;
    if (!ticket) throw new Error("ticket not found");

    const [{ data: events }, { data: runs }] = await Promise.all([
      context.supabase
        .from("support_ticket_events")
        .select("id, event_type, actor, payload, created_at")
        .eq("ticket_id", data.ticketId)
        .order("created_at", { ascending: true }),
      context.supabase
        .from("remediation_runs")
        .select("*")
        .eq("ticket_id", data.ticketId)
        .order("created_at", { ascending: true }),
    ]);

    return { ticket, events: events ?? [], runs: runs ?? [] };
  });

/** Parked runs across all tickets AND the ticket-less scan pipeline. */
export const listAwaitingValidation = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator(() => ({}))
  .handler(async ({ context }) => {
    const { data: runs, error } = await context.supabase
      .from("remediation_runs")
      .select(
        "id, ticket_id, finding_id, remediation_id, clone_id, action_type, priority, status, policy, plan, created_at, support_tickets(reference, subject, workspace_id), clones(name)",
      )
      .eq("status", "awaiting_validation")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    return { runs: runs ?? [] };
  });

const RunDecisionInput = z.object({
  runId: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

export const approveRemediationRun = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => RunDecisionInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;

    const { data: run } = await admin
      .from("remediation_runs")
      .select("id, status, ticket_id, action_type")
      .eq("id", data.runId)
      .maybeSingle();
    if (!run) throw new Error("run not found");
    if (run.status !== "awaiting_validation") {
      throw new Error(`run is ${run.status}, not awaiting validation`);
    }

    await admin
      .from("remediation_runs")
      .update({
        status: "approved",
        approved_by: context.userId,
        approved_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    if (run.ticket_id) {
      await admin.from("support_ticket_events").insert({
        ticket_id: run.ticket_id,
        event_type: "remediation.approved",
        actor: context.userId,
        payload: { run_id: run.id, action_type: run.action_type, reason: data.reason ?? null },
      });
      await admin
        .from("support_tickets")
        .update({ status: "remediating" })
        .eq("id", run.ticket_id)
        .eq("status", "awaiting_validation");
    }

    // Execute immediately rather than waiting up to 2 minutes for the drain
    // — an admin pressing "approve" expects the action, not a queue slot.
    try {
      const { executeRemediationRun } = await import("@/server/self-healing.server");
      const outcome = await executeRemediationRun(run.id);
      return { ok: true, executed: true, outcome: outcome.status };
    } catch (err) {
      // The drain retries; approval itself succeeded.
      return { ok: true, executed: false, error: (err as Error).message };
    }
  });

export const rejectRemediationRun = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => RunDecisionInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;

    const { data: run } = await admin
      .from("remediation_runs")
      .select("id, status, ticket_id, action_type")
      .eq("id", data.runId)
      .maybeSingle();
    if (!run) throw new Error("run not found");
    if (!["awaiting_validation", "planned", "approved"].includes(run.status)) {
      throw new Error(`run is ${run.status} and can no longer be rejected`);
    }

    await admin
      .from("remediation_runs")
      .update({
        status: "rejected",
        rejected_by: context.userId,
        rejected_at: new Date().toISOString(),
        rejected_reason: data.reason ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    if (run.ticket_id) {
      await admin.from("support_ticket_events").insert({
        ticket_id: run.ticket_id,
        event_type: "remediation.rejected",
        actor: context.userId,
        payload: { run_id: run.id, action_type: run.action_type, reason: data.reason ?? null },
      });
    }
    return { ok: true };
  });

const OverrideInput = z.object({
  ticketId: z.string().uuid(),
  priority: z.enum(TICKET_PRIORITIES),
  reason: z.string().min(4).max(2000),
});

export const overrideTicketPriority = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => OverrideInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;

    const { data: ticket } = await admin
      .from("support_tickets")
      .select("id, priority, created_at")
      .eq("id", data.ticketId)
      .maybeSingle();
    if (!ticket) throw new Error("ticket not found");
    if (ticket.priority === data.priority) return { ok: true, unchanged: true };

    const slaMinutes = PRIORITY_SLA_MINUTES[data.priority];
    await admin
      .from("support_tickets")
      .update({
        priority: data.priority,
        priority_overridden_by: context.userId,
        priority_overridden_at: new Date().toISOString(),
        sla_due_at: new Date(
          new Date(ticket.created_at).getTime() + slaMinutes * 60_000,
        ).toISOString(),
      })
      .eq("id", ticket.id);
    await admin.from("support_ticket_events").insert({
      ticket_id: ticket.id,
      event_type: "ticket.priority_overridden",
      actor: context.userId,
      payload: { from: ticket.priority, to: data.priority, reason: data.reason },
    });
    return { ok: true };
  });

const ResolveInput = z.object({
  ticketId: z.string().uuid(),
  action: z.enum(["resolve", "close"]),
  resolution: z.string().max(4000).optional(),
});

export const resolveSupportTicket = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d) => ResolveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;

    const { data: ticket } = await admin
      .from("support_tickets")
      .select("id, status")
      .eq("id", data.ticketId)
      .maybeSingle();
    if (!ticket) throw new Error("ticket not found");
    if (["resolved", "closed"].includes(ticket.status)) {
      return { ok: true, unchanged: true };
    }

    await admin
      .from("support_tickets")
      .update({
        status: data.action === "resolve" ? "resolved" : "closed",
        resolved_at: new Date().toISOString(),
        resolution: data.resolution ?? null,
      })
      .eq("id", ticket.id);
    await admin.from("support_ticket_events").insert({
      ticket_id: ticket.id,
      event_type: `ticket.${data.action}d`,
      actor: context.userId,
      payload: { resolution: data.resolution ?? null },
    });
    return { ok: true };
  });

/** Vocabulary the queue UI filters by; re-exported so the page needs no duplicate lists. */
export const getSupportVocabulary = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async () => ({
    priorities: TICKET_PRIORITIES,
    breakageVectors: BREAKAGE_VECTORS,
  }));
