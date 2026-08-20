// CRM spine — accounts, contacts, timeline activities and tasks.
//
// Everything in the client lifecycle hangs off `crm_accounts`. Billing truth
// (purchases, invoices, tokens, seats) is never duplicated here — it is read
// live from the existing tables by `getAccount`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const LIFECYCLE_STAGES = [
  "lead",
  "opportunity",
  "onboarding",
  "active",
  "at_risk",
  "churned",
] as const;

/* ------------------------------- accounts -------------------------------- */

export const listAccounts = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        stage: z.enum(["all", ...LIFECYCLE_STAGES]).default("all"),
        search: z.string().max(200).default(""),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_accounts")
      .select("*, crm_contacts(id, first_name, last_name, email, is_primary)")
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.stage !== "all") q = q.eq("lifecycle_stage", data.stage);
    if (data.search.trim()) q = q.ilike("name", `%${data.search.trim()}%`);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const getAccount = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const [
      account,
      contacts,
      activities,
      tasks,
      deals,
      contracts,
      onboarding,
      tickets,
      disputes,
      churn,
      offboarding,
      feedback,
    ] = await Promise.all([
      sb.from("crm_accounts").select("*, clones(id, name, slug)").eq("id", data.id).maybeSingle(),
      sb
        .from("crm_contacts")
        .select("*")
        .eq("account_id", data.id)
        .order("is_primary", { ascending: false }),
      sb
        .from("crm_activities")
        .select("*")
        .eq("account_id", data.id)
        .order("occurred_at", { ascending: false })
        .limit(100),
      sb
        .from("crm_tasks")
        .select("*")
        .eq("account_id", data.id)
        .order("due_at", { ascending: true }),
      sb
        .from("crm_deals")
        .select("*, crm_deal_line_items(*)")
        .eq("account_id", data.id)
        .order("created_at", { ascending: false }),
      sb
        .from("crm_contracts")
        .select("*")
        .eq("account_id", data.id)
        .order("term_start", { ascending: false }),
      sb.from("crm_onboarding_tasks").select("*").eq("account_id", data.id).order("position"),
      sb
        .from("crm_tickets")
        .select("*")
        .eq("account_id", data.id)
        .order("created_at", { ascending: false }),
      sb
        .from("crm_disputes")
        .select("*")
        .eq("account_id", data.id)
        .order("opened_at", { ascending: false }),
      sb
        .from("crm_churn_events")
        .select("*")
        .eq("account_id", data.id)
        .order("requested_at", { ascending: false }),
      sb
        .from("crm_offboarding_runs")
        .select("*")
        .eq("account_id", data.id)
        .order("created_at", { ascending: false }),
      sb
        .from("crm_feedback_requests")
        .select("*")
        .eq("account_id", data.id)
        .order("requested_at", { ascending: false }),
    ]);

    if (account.error) throw account.error;
    if (!account.data) throw new Error("account_not_found");

    // Live billing truth — read, never duplicated.
    const cloneId = account.data.clone_id as string | null;
    const tenantId = account.data.tenant_id as string | null;
    const [purchases, invoices, balance, seats] = await Promise.all([
      cloneId
        ? sb
            .from("purchases")
            .select("*")
            .eq("clone_id", cloneId)
            .order("created_at", { ascending: false })
            .limit(25)
        : Promise.resolve({ data: [] }),
      tenantId
        ? sb
            .from("invoices")
            .select("*")
            .eq("tenant_id", tenantId)
            .order("created_at", { ascending: false })
            .limit(25)
        : Promise.resolve({ data: [] }),
      tenantId
        ? sb.from("token_balances").select("*").eq("tenant_id", tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
      cloneId
        ? sb.from("clone_seat_entitlements").select("*").eq("clone_id", cloneId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    return {
      account: account.data,
      contacts: contacts.data ?? [],
      activities: activities.data ?? [],
      tasks: tasks.data ?? [],
      deals: deals.data ?? [],
      contracts: contracts.data ?? [],
      onboarding: onboarding.data ?? [],
      tickets: tickets.data ?? [],
      disputes: disputes.data ?? [],
      churn: churn.data ?? [],
      offboarding: offboarding.data ?? [],
      feedback: feedback.data ?? [],
      billing: {
        purchases: purchases.data ?? [],
        invoices: invoices.data ?? [],
        balance: balance.data ?? null,
        seats: seats.data ?? null,
      },
    };
  });

export const upsertAccount = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        name: z.string().min(1).max(200),
        classification: z.string().max(100).nullable().optional(),
        lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
        website: z.string().max(300).nullable().optional(),
        clone_id: uuid.nullable().optional(),
        tenant_id: uuid.nullable().optional(),
        owner_user_id: uuid.nullable().optional(),
        mrr_cents: z.number().int().min(0).optional(),
        notes: z.string().max(5000).nullable().optional(),
        tags: z.array(z.string().max(40)).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.mrr_cents !== undefined) (fields as any).arr_cents = fields.mrr_cents * 12;
    if (id) {
      const { data: row, error } = await context.supabase
        .from("crm_accounts")
        .update(fields)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return row;
    }
    const { data: row, error } = await context.supabase
      .from("crm_accounts")
      .insert({
        ...fields,
        created_by: context.userId,
        owner_user_id: fields.owner_user_id ?? context.userId,
      })
      .select()
      .single();
    if (error) throw error;
    return row;
  });

export const setAccountStage = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid, stage: z.enum(LIFECYCLE_STAGES) }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("crm_accounts")
      .update({ lifecycle_stage: data.stage })
      .eq("id", data.id);
    if (error) throw error;
    await context.supabase.from("crm_activities").insert({
      account_id: data.id,
      kind: "status_change",
      title: `Lifecycle stage → ${data.stage.replace(/_/g, " ")}`,
      actor_user_id: context.userId,
    });
    return { ok: true };
  });

/* ------------------------------- contacts -------------------------------- */

export const upsertContact = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        account_id: uuid,
        first_name: z.string().min(1).max(100),
        last_name: z.string().max(100).nullable().optional(),
        email: z.string().email().nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        job_title: z.string().max(120).nullable().optional(),
        is_primary: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.is_primary) {
      await context.supabase
        .from("crm_contacts")
        .update({ is_primary: false })
        .eq("account_id", fields.account_id);
    }
    const q = id
      ? context.supabase.from("crm_contacts").update(fields).eq("id", id)
      : context.supabase.from("crm_contacts").insert(fields);
    const { data: row, error } = await q.select().single();
    if (error) throw error;
    return row;
  });

export const deleteContact = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("crm_contacts").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/* ------------------------------ activities ------------------------------- */

export const logActivity = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        account_id: uuid,
        contact_id: uuid.nullable().optional(),
        kind: z.enum(["note", "call", "email", "meeting", "system"]).default("note"),
        title: z.string().min(1).max(200),
        body: z.string().max(10000).nullable().optional(),
        occurred_at: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_activities")
      .insert({ ...data, actor_user_id: context.userId })
      .select()
      .single();
    if (error) throw error;
    if (["call", "email", "meeting"].includes(data.kind)) {
      await context.supabase
        .from("crm_accounts")
        .update({ last_contacted_at: new Date().toISOString() })
        .eq("id", data.account_id);
    }
    return row;
  });

/* --------------------------------- tasks --------------------------------- */

export const upsertTask = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        account_id: uuid.nullable().optional(),
        deal_id: uuid.nullable().optional(),
        ticket_id: uuid.nullable().optional(),
        title: z.string().min(1).max(200),
        description: z.string().max(4000).nullable().optional(),
        status: z.enum(["open", "in_progress", "done", "canceled"]).optional(),
        due_at: z.string().nullable().optional(),
        assignee_user_id: uuid.nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.status === "done") (fields as any).completed_at = new Date().toISOString();
    const q = id
      ? context.supabase.from("crm_tasks").update(fields).eq("id", id)
      : context.supabase.from("crm_tasks").insert({ ...fields, created_by: context.userId });
    const { data: row, error } = await q.select().single();
    if (error) throw error;
    return row;
  });

export const listOpenTasks = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("crm_tasks")
      .select("*, crm_accounts(id, name)")
      .in("status", ["open", "in_progress"])
      .order("due_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    return data ?? [];
  });

/* ------------------------------- pipeline -------------------------------- */

export const pipelineSummary = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("crm_pipeline_summary");
    if (error) throw error;
    return data as Json;
  });

export const convertLead = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ lead_id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: result, error } = await context.supabase.rpc("crm_convert_lead", {
      _lead_id: data.lead_id,
      _owner: context.userId,
    });
    if (error) throw error;
    // Carry any pre-conversion fit analyses onto the new account so the
    // deal-stage gate and the account Fit tab can see them.
    const accountId = (result as any)?.account_id;
    if (accountId) {
      await context.supabase
        .from("crm_fit_analyses")
        .update({ account_id: accountId })
        .eq("lead_id", data.lead_id)
        .is("account_id", null);
    }
    // `idempotent` marks a lead that was already promoted — the account came
    // back rather than being created a second time.
    return result as { ok: boolean; account_id?: string; idempotent?: boolean; error?: string };
  });

export const recomputeHealth = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ account_id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: score, error } = await context.supabase.rpc("crm_recompute_health", {
      _account_id: data.account_id,
    });
    if (error) throw error;
    return { score };
  });
