// @ts-nocheck
// CRM support surface — tickets, threaded messages, and formal disputes.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const TICKET_STATUSES = ["open", "in_progress", "waiting_client", "resolved", "closed"] as const;
export const TICKET_TYPES = ["support", "bug", "billing", "feature", "incident"] as const;
export const TICKET_SEVERITIES = ["low", "normal", "high", "critical"] as const;

/** Response targets by severity, in hours. */
const SLA_HOURS: Record<string, number> = { critical: 2, high: 8, normal: 24, low: 72 };

export const listTickets = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["all", ...TICKET_STATUSES]).default("all"),
        severity: z.enum(["all", ...TICKET_SEVERITIES]).default("all"),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_tickets")
      .select("*, crm_accounts(id, name)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.severity !== "all") q = q.eq("severity", data.severity);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const getTicket = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const [ticket, messages] = await Promise.all([
      context.supabase.from("crm_tickets").select("*, crm_accounts(id, name)").eq("id", data.id).maybeSingle(),
      context.supabase.from("crm_ticket_messages").select("*").eq("ticket_id", data.id).order("created_at"),
    ]);
    if (ticket.error) throw ticket.error;
    return { ticket: ticket.data, messages: messages.data ?? [] };
  });

export const createTicket = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        account_id: uuid,
        contact_id: uuid.nullable().optional(),
        type: z.enum(TICKET_TYPES).default("support"),
        severity: z.enum(TICKET_SEVERITIES).default("normal"),
        subject: z.string().min(1).max(200),
        description: z.string().max(10000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const slaDue = new Date(Date.now() + SLA_HOURS[data.severity] * 3600_000).toISOString();
    const { data: row, error } = await context.supabase
      .from("crm_tickets")
      .insert({
        ...data,
        sla_due_at: slaDue,
        created_by: context.userId,
        assignee_user_id: context.userId,
        reference: `TIC-${Date.now().toString(36).toUpperCase()}`,
      })
      .select()
      .single();
    if (error) throw error;
    await context.supabase.from("crm_activities").insert({
      account_id: data.account_id,
      kind: "ticket",
      title: `Ticket opened: ${data.subject}`,
      body: data.description ?? null,
      actor_user_id: context.userId,
      entity_type: "crm_ticket",
      entity_id: row.id,
    });
    return row;
  });

export const updateTicket = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        status: z.enum(TICKET_STATUSES).optional(),
        severity: z.enum(TICKET_SEVERITIES).optional(),
        assignee_user_id: uuid.nullable().optional(),
        resolution: z.string().max(5000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.status === "resolved" || fields.status === "closed") {
      (fields as any).resolved_at = new Date().toISOString();
    }
    if (fields.severity) {
      (fields as any).sla_due_at = new Date(Date.now() + SLA_HOURS[fields.severity] * 3600_000).toISOString();
    }
    const { data: row, error } = await context.supabase
      .from("crm_tickets")
      .update(fields)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return row;
  });

export const addTicketMessage = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({ ticket_id: uuid, body: z.string().min(1).max(20000), internal: z.boolean().default(false) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_ticket_messages")
      .insert({ ...data, author_user_id: context.userId })
      .select()
      .single();
    if (error) throw error;
    if (!data.internal) {
      await context.supabase
        .from("crm_tickets")
        .update({ first_response_at: new Date().toISOString() })
        .eq("id", data.ticket_id)
        .is("first_response_at", null);
    }
    return row;
  });

/* -------------------------------- disputes -------------------------------- */

export const DISPUTE_STATUSES = [
  "open",
  "under_review",
  "evidence_submitted",
  "won",
  "lost",
  "withdrawn",
  "settled",
] as const;

export const listDisputes = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("crm_disputes")
      .select("*, crm_accounts(id, name)")
      .order("opened_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return data ?? [];
  });

export const upsertDispute = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        account_id: uuid,
        kind: z.enum(["chargeback", "billing_disagreement", "service_credit", "contractual", "other"]).default("billing_disagreement"),
        status: z.enum(DISPUTE_STATUSES).optional(),
        amount_cents: z.number().int().min(0).default(0),
        reason: z.string().max(300).nullable().optional(),
        summary: z.string().max(10000).nullable().optional(),
        evidence_url: z.string().max(500).nullable().optional(),
        outcome: z.string().max(1000).nullable().optional(),
        due_at: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.status && ["won", "lost", "withdrawn", "settled"].includes(fields.status)) {
      (fields as any).closed_at = new Date().toISOString();
    }
    const q = id
      ? context.supabase.from("crm_disputes").update(fields).eq("id", id)
      : context.supabase.from("crm_disputes").insert({ ...fields, owner_user_id: context.userId });
    const { data: row, error } = await q.select().single();
    if (error) throw error;
    await context.supabase.from("crm_activities").insert({
      account_id: data.account_id,
      kind: "dispute",
      title: id ? `Dispute updated (${fields.status ?? "open"})` : `Dispute opened: ${data.kind.replace(/_/g, " ")}`,
      body: data.summary ?? null,
      actor_user_id: context.userId,
      entity_type: "crm_dispute",
      entity_id: row.id,
    });
    return row;
  });
