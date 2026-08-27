// Outbound dispatch queue and campaign rules — the operator's view of the
// scheduling engine that replaced the Make.com scenarios.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const OUTBOUND_STATUSES = [
  "pending",
  "dispatching",
  "dispatched",
  "completed",
  "failed",
  "canceled",
  "expired",
] as const;

export const listOutboundJobs = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["all", ...OUTBOUND_STATUSES]).default("all"),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("voice_outbound_jobs")
      .select(
        "*, crm_contacts(id, first_name, last_name), crm_accounts(id, name), crm_appointments(id, kind, starts_at, status)",
      )
      .order("scheduled_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const cancelOutboundJob = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("voice_outbound_jobs")
      .update({ status: "canceled", last_error: "canceled_by_operator" })
      .eq("id", data.id)
      .in("status", ["pending", "dispatching"]);
    if (error) throw error;
    return { ok: true };
  });

export const retryOutboundJob = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("voice_outbound_jobs")
      .update({
        status: "pending",
        scheduled_at: new Date().toISOString(),
        attempts: 0,
        last_error: null,
        vapi_call_id: null,
      })
      .eq("id", data.id)
      .in("status", ["failed", "expired", "canceled"]);
    if (error) throw error;
    return { ok: true };
  });

/** Operator-initiated call: a `manual` job through the same queue as the rest. */
export const createManualCall = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        phone: z.string().min(6).max(30),
        vapiAssistantId: z.string().min(4).max(80),
        contactId: uuid.nullable().optional(),
        fullName: z.string().max(200).nullable().optional(),
        scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { enqueueOutboundForTrigger } = await import("@/server/voice.server");

    let accountId: string | null = null;
    let journeyId: string | null = null;
    let fullName = data.fullName ?? null;
    if (data.contactId) {
      const { data: contact, error } = await context.supabase
        .from("crm_contacts")
        .select("id, account_id, first_name, last_name, crm_client_journeys(id)")
        .eq("id", data.contactId)
        .maybeSingle();
      if (error) throw error;
      if (contact) {
        accountId = contact.account_id;
        fullName = fullName ?? [contact.first_name, contact.last_name].filter(Boolean).join(" ");
        const journeys = contact.crm_client_journeys as unknown as Array<{ id: string }> | null;
        journeyId = journeys?.[0]?.id ?? null;
      }
    }

    const outcome = await enqueueOutboundForTrigger({
      triggerType: "manual",
      phone: data.phone,
      fullName,
      accountId,
      contactId: data.contactId ?? null,
      journeyId,
      assistantId: data.vapiAssistantId,
      scheduledAtOverride: data.scheduledAt ? new Date(data.scheduledAt) : new Date(),
      extras: data.notes ? { operatorNotes: data.notes } : undefined,
      createdBy: context.userId,
    });
    if (!outcome.queued) throw new Error(`not_queued_${outcome.reason}`);
    return outcome;
  });

/* ------------------------------ campaign rules ----------------------------- */

export const listCampaignRules = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({}).parse(input ?? {}))
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("voice_campaign_rules")
      .select("*")
      .order("trigger_type");
    if (error) throw error;
    return rows ?? [];
  });

export const updateCampaignRule = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        isEnabled: z.boolean().optional(),
        vapiAssistantId: z.string().max(80).nullable().optional(),
        vapiPhoneNumberId: z.string().max(80).nullable().optional(),
        delaySeconds: z
          .number()
          .int()
          .min(0)
          .max(7 * 24 * 3600)
          .optional(),
        anchorOffsetSeconds: z
          .number()
          .int()
          .min(-7 * 24 * 3600)
          .max(7 * 24 * 3600)
          .optional(),
        expirySeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 24 * 3600)
          .nullable()
          .optional(),
        maxAttempts: z.number().int().min(1).max(5).optional(),
        retryDelaySeconds: z
          .number()
          .int()
          .min(60)
          .max(24 * 3600)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Database["public"]["Tables"]["voice_campaign_rules"]["Update"] = {};
    if (data.isEnabled !== undefined) patch.is_enabled = data.isEnabled;
    if (data.vapiAssistantId !== undefined) patch.vapi_assistant_id = data.vapiAssistantId;
    if (data.vapiPhoneNumberId !== undefined) patch.vapi_phone_number_id = data.vapiPhoneNumberId;
    if (data.delaySeconds !== undefined) patch.delay_seconds = data.delaySeconds;
    if (data.anchorOffsetSeconds !== undefined)
      patch.anchor_offset_seconds = data.anchorOffsetSeconds;
    if (data.expirySeconds !== undefined) patch.expiry_seconds = data.expirySeconds;
    if (data.maxAttempts !== undefined) patch.max_attempts = data.maxAttempts;
    if (data.retryDelaySeconds !== undefined) patch.retry_delay_seconds = data.retryDelaySeconds;
    const { error } = await context.supabase
      .from("voice_campaign_rules")
      .update(patch)
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
