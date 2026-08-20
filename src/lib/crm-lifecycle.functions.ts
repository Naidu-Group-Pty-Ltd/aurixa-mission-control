// Contracts, onboarding, feedback requests, churn and offboarding —
// the "contracted through exit" half of the client lifecycle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator, requireAdmin } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

/* ------------------------------- contracts -------------------------------- */

export const upsertContract = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        account_id: uuid,
        deal_id: uuid.nullable().optional(),
        status: z.enum(["draft", "active", "expired", "terminated"]).optional(),
        tier_slug: z.string().max(60).nullable().optional(),
        billing_cadence: z.enum(["monthly", "quarterly", "annual"]).optional(),
        committed_seats: z.number().int().min(1).max(100000).optional(),
        mrr_cents: z.number().int().min(0).optional(),
        term_start: z.string().optional(),
        term_end: z.string().nullable().optional(),
        auto_renew: z.boolean().optional(),
        notice_period_days: z.number().int().min(0).max(365).optional(),
        signed_by: z.string().max(200).nullable().optional(),
        signed_at: z.string().nullable().optional(),
        document_url: z.string().max(500).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    const q = id
      ? context.supabase.from("crm_contracts").update(fields).eq("id", id)
      : context.supabase.from("crm_contracts").insert(fields);
    const { data: row, error } = await q.select().single();
    if (error) throw error;
    return row;
  });

/* ------------------------------- onboarding ------------------------------- */

export const seedOnboarding = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ account_id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: res, error } = await context.supabase.rpc("crm_seed_onboarding", {
      _account_id: data.account_id,
    });
    if (error) throw error;
    return res;
  });

export const setOnboardingStep = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        status: z.enum(["pending", "in_progress", "done", "skipped"]),
        notes: z.string().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_onboarding_tasks")
      .update({
        status: data.status,
        notes: data.notes ?? null,
        completed_at: data.status === "done" ? new Date().toISOString() : null,
        completed_by: data.status === "done" ? context.userId : null,
      })
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw error;

    // All steps done → the account is live.
    const { data: remaining } = await context.supabase
      .from("crm_onboarding_tasks")
      .select("id")
      .eq("account_id", row.account_id)
      .not("status", "in", '("done","skipped")');
    if ((remaining ?? []).length === 0) {
      await context.supabase
        .from("crm_accounts")
        .update({ lifecycle_stage: "active" })
        .eq("id", row.account_id)
        .eq("lifecycle_stage", "onboarding");
    }
    return row;
  });

/* ----------------------------- feedback loop ------------------------------ */

export const requestFeedback = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        account_id: uuid,
        contact_id: uuid.nullable().optional(),
        channel: z.enum(["email", "in_app", "call"]).default("email"),
        campaign_key: z.string().max(80).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_feedback_requests")
      .insert({ ...data, requested_by: context.userId })
      .select()
      .single();
    if (error) throw error;
    await context.supabase.from("crm_activities").insert({
      account_id: data.account_id,
      kind: "feedback",
      title: `Feedback requested via ${data.channel}`,
      actor_user_id: context.userId,
    });
    return row;
  });

export const recordFeedbackResponse = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        nps_score: z.number().int().min(0).max(10).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    const { data: row, error } = await context.supabase
      .from("crm_feedback_requests")
      .update({ ...fields, responded_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return row;
  });

/* --------------------------------- churn ---------------------------------- */

export const CHURN_REASONS = [
  "price",
  "missing_capability",
  "switched_provider",
  "internal_build",
  "non_payment",
  "business_closed",
  "poor_experience",
  "other",
] as const;

/** Default portability window: the client keeps access to their export for 90 days. */
const RETENTION_DAYS = 90;

export const recordChurn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        account_id: uuid,
        contract_id: uuid.nullable().optional(),
        effective_at: z.string().nullable().optional(),
        reason: z.enum(CHURN_REASONS).default("other"),
        reason_detail: z.string().max(4000).nullable().optional(),
        competitor: z.string().max(200).nullable().optional(),
        save_attempted: z.boolean().default(false),
        save_outcome: z.string().max(1000).nullable().optional(),
        refund_cents: z.number().int().min(0).default(0),
        offboarding_path: z
          .enum(["ownership_transfer", "export_and_terminate", "terminate_only"])
          .default("export_and_terminate"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { offboarding_path, ...churn } = data;
    const retentionUntil = new Date(Date.now() + RETENTION_DAYS * 86400_000).toISOString();

    const { data: event, error } = await context.supabase
      .from("crm_churn_events")
      .insert({ ...churn, data_retention_until: retentionUntil, recorded_by: context.userId })
      .select()
      .single();
    if (error) throw error;

    const checklist = [
      { key: "notice_ack", label: "Cancellation notice acknowledged", done: false },
      { key: "final_invoice", label: "Final invoice issued and settled", done: false },
      { key: "data_export", label: "Data export pack generated and delivered", done: false },
      { key: "seats_revoked", label: "Seats and devices revoked", done: false },
      { key: "keys_revoked", label: "API keys revoked", done: false },
      { key: "subscription_canceled", label: "Stripe subscription canceled", done: false },
      { key: "access_grants_expired", label: "Storefront access grants expired", done: false },
      { key: "dns_retired", label: "Subdomain / DNS record retired", done: false },
      ...(offboarding_path === "ownership_transfer"
        ? [{ key: "handoff_complete", label: "Backend ownership handoff completed", done: false }]
        : []),
      {
        key: "retention_clock",
        label: `Data destruction scheduled (${RETENTION_DAYS} days)`,
        done: false,
      },
    ];

    const { data: run, error: runErr } = await context.supabase
      .from("crm_offboarding_runs")
      .insert({
        account_id: data.account_id,
        churn_event_id: event.id,
        path: offboarding_path,
        checklist,
        destroy_after: retentionUntil,
        owner_user_id: context.userId,
      })
      .select()
      .single();
    if (runErr) throw runErr;

    await context.supabase
      .from("crm_accounts")
      .update({ lifecycle_stage: "churned", mrr_cents: 0, arr_cents: 0 })
      .eq("id", data.account_id);
    await context.supabase
      .from("crm_contracts")
      .update({ status: "terminated", auto_renew: false })
      .eq("account_id", data.account_id)
      .eq("status", "active");
    await context.supabase.from("crm_activities").insert({
      account_id: data.account_id,
      kind: "churn",
      title: `Cancellation recorded (${data.reason.replace(/_/g, " ")})`,
      body: data.reason_detail ?? null,
      actor_user_id: context.userId,
      entity_type: "crm_churn_event",
      entity_id: event.id,
    });

    return { event, run };
  });

/* ------------------------------- offboarding ------------------------------ */

export const updateOffboarding = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        status: z.enum(["pending", "in_progress", "complete", "canceled"]).optional(),
        checklist: z
          .array(z.object({ key: z.string(), label: z.string(), done: z.boolean() }))
          .optional(),
        handoff_id: uuid.nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.checklist && fields.checklist.every((c) => c.done)) {
      (fields as any).status = "complete";
    }
    const { data: row, error } = await context.supabase
      .from("crm_offboarding_runs")
      .update(fields)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return row;
  });

/**
 * Builds the portable data pack manifest for an exiting client: what is being
 * exported, from where, and the checksum recorded on delivery. Admin-only —
 * this enumerates the client's whole data estate.
 */
export const buildExportManifest = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: run, error } = await context.supabase
      .from("crm_offboarding_runs")
      .select("*, crm_accounts(id, name, clone_id, tenant_id)")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!run) throw new Error("offboarding_run_not_found");

    const account = run.crm_accounts;
    const cloneId = account?.clone_id ?? null;
    const tenantId = account?.tenant_id ?? null;

    const [reports, purchases, invoices, brand, backend] = await Promise.all([
      tenantId
        ? context.supabase
            .from("report_jobs")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
        : Promise.resolve({ count: 0 }),
      cloneId
        ? context.supabase
            .from("purchases")
            .select("id", { count: "exact", head: true })
            .eq("clone_id", cloneId)
        : Promise.resolve({ count: 0 }),
      tenantId
        ? context.supabase
            .from("invoices")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
        : Promise.resolve({ count: 0 }),
      cloneId
        ? context.supabase
            .from("clone_brand_assignments")
            .select("profile_id")
            .eq("clone_id", cloneId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      cloneId
        ? context.supabase
            .from("clone_backends")
            .select("id, status, region")
            .eq("clone_id", cloneId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const manifest = {
      generated_at: new Date().toISOString(),
      account: { id: account?.id, name: account?.name },
      clone_id: cloneId,
      tenant_id: tenantId,
      datasets: [
        { key: "report_jobs", label: "Generated reports & job history", rows: reports.count ?? 0 },
        {
          key: "purchases",
          label: "Purchase / billing attribution history",
          rows: purchases.count ?? 0,
        },
        { key: "invoices", label: "Tax invoices", rows: invoices.count ?? 0 },
        { key: "brand_profile", label: "Brand configuration & assets", rows: brand.data ? 1 : 0 },
        { key: "backend", label: "Dedicated backend snapshot", rows: backend.data ? 1 : 0 },
      ],
      backend: backend.data ?? null,
      path: run.path,
      destroy_after: run.destroy_after,
    };

    const { data: updated, error: upErr } = await context.supabase
      .from("crm_offboarding_runs")
      .update({ export_manifest: manifest, status: "in_progress" })
      .eq("id", data.id)
      .select()
      .single();
    if (upErr) throw upErr;
    return updated;
  });

export const markExportDelivered = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ id: uuid, checksum: z.string().max(200).nullable().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_offboarding_runs")
      .update({
        export_delivered_at: new Date().toISOString(),
        export_checksum: data.checksum ?? null,
      })
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw error;
    await context.supabase.from("audit_log").insert({
      action: "crm.export.delivered",
      entity_type: "crm_offboarding_run",
      entity_id: data.id,
      metadata: { checksum: data.checksum ?? null },
    });
    return row;
  });
