// The client journey tracker — the pipeline board, stage transitions and
// appointments. Transitions and appointment outcomes are what trigger
// outbound voice calls, so every mutation here delegates to
// src/server/crm-journey.server.ts, the one place those consequences live.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const APPOINTMENT_KINDS = [
  "discovery",
  "strategy_phone",
  "strategy_zoom",
  "ifc_phone",
  "ifc_zoom",
  "other",
] as const;

export const journeyBoard = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ search: z.string().max(200).default("") }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const [stages, journeys] = await Promise.all([
      context.supabase
        .from("crm_journey_stages")
        .select("*")
        .eq("is_active", true)
        .order("position"),
      context.supabase
        .from("crm_client_journeys")
        .select(
          "*, crm_contacts(id, first_name, last_name, phone, email), crm_accounts(id, name, lifecycle_stage)",
        )
        .order("updated_at", { ascending: false })
        .limit(500),
    ]);
    if (stages.error) throw stages.error;
    if (journeys.error) throw journeys.error;

    let rows = journeys.data ?? [];
    if (data.search.trim()) {
      const term = data.search.trim().toLowerCase();
      rows = rows.filter((j) => {
        const contact = j.crm_contacts as unknown as {
          first_name: string;
          last_name: string | null;
          phone: string | null;
          email: string | null;
        } | null;
        const account = j.crm_accounts as unknown as { name: string } | null;
        return [
          contact?.first_name,
          contact?.last_name,
          contact?.phone,
          contact?.email,
          account?.name,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term));
      });
    }
    return { stages: stages.data ?? [], journeys: rows };
  });

export const getJourney = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const [journey, events, appointments, jobs, calls] = await Promise.all([
      context.supabase
        .from("crm_client_journeys")
        .select("*, crm_contacts(id, first_name, last_name, phone, email), crm_accounts(id, name)")
        .eq("id", data.id)
        .maybeSingle(),
      context.supabase
        .from("crm_journey_events")
        .select("*")
        .eq("journey_id", data.id)
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("crm_appointments")
        .select("*")
        .eq("journey_id", data.id)
        .order("starts_at", { ascending: false })
        .limit(20),
      context.supabase
        .from("voice_outbound_jobs")
        .select("*")
        .eq("journey_id", data.id)
        .order("scheduled_at", { ascending: false })
        .limit(20),
      context.supabase
        .from("voice_calls")
        .select(
          "id, call_direction, call_outcome, call_intent, started_at, duration_seconds, sentiment, agent_name",
        )
        .eq("contact_id", (await contactIdFor(context.supabase, data.id)) ?? data.id)
        .order("started_at", { ascending: false })
        .limit(20),
    ]);
    if (journey.error) throw journey.error;
    if (!journey.data) throw new Error("journey_not_found");
    return {
      journey: journey.data,
      events: events.data ?? [],
      appointments: appointments.data ?? [],
      jobs: jobs.data ?? [],
      calls: calls.data ?? [],
    };
  });

async function contactIdFor(supabase: any, journeyId: string): Promise<string | null> {
  const { data } = await supabase
    .from("crm_client_journeys")
    .select("contact_id")
    .eq("id", journeyId)
    .maybeSingle();
  return data?.contact_id ?? null;
}

export const transitionStage = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        journeyId: uuid,
        toStage: z.string().min(1).max(60),
        reason: z.string().max(500).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { transitionJourneyStage } = await import("@/server/crm-journey.server");
    return transitionJourneyStage({
      journeyId: data.journeyId,
      toStage: data.toStage,
      reason: data.reason ?? null,
      source: "manual",
      actorUserId: context.userId,
    });
  });

export const updateJourney = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        journeyId: uuid,
        followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
        doNotCall: z.boolean().optional(),
        notes: z.string().max(4000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Database["public"]["Tables"]["crm_client_journeys"]["Update"] = {};
    if (data.followUpAt !== undefined) patch.follow_up_at = data.followUpAt;
    if (data.doNotCall !== undefined) patch.do_not_call = data.doNotCall;
    if (data.notes !== undefined) patch.notes = data.notes;
    const { error } = await context.supabase
      .from("crm_client_journeys")
      .update(patch)
      .eq("id", data.journeyId);
    if (error) throw error;
    return { ok: true };
  });

/** Put an existing CRM contact onto the journey board. */
export const startJourney = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ contactId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: contact, error } = await context.supabase
      .from("crm_contacts")
      .select("id, account_id")
      .eq("id", data.contactId)
      .maybeSingle();
    if (error) throw error;
    if (!contact) throw new Error("contact_not_found");
    const { data: journey, error: insertError } = await context.supabase
      .from("crm_client_journeys")
      .insert({ contact_id: contact.id, account_id: contact.account_id })
      .select("id")
      .single();
    if (insertError) {
      if (insertError.code === "23505") throw new Error("journey_already_exists");
      throw insertError;
    }
    // Entering the board at new_lead is a trigger like any other transition.
    const { transitionJourneyStage } = await import("@/server/crm-journey.server");
    await transitionJourneyStage({
      journeyId: journey.id,
      toStage: "new_lead",
      reason: "journey_started",
      source: "manual",
      actorUserId: context.userId,
    });
    return { journeyId: journey.id };
  });

/** Contacts that are not yet on the board (for the start-journey picker). */
export const listContactsWithoutJourney = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ search: z.string().max(200).default("") }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_contacts")
      .select("id, first_name, last_name, phone, email, account_id, crm_client_journeys(id)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (data.search.trim()) {
      const term = data.search.trim().replace(/[%,()]/g, " ");
      q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows ?? []).filter((c) => {
      const journeys = c.crm_client_journeys as unknown as Array<{ id: string }> | null;
      return !journeys || journeys.length === 0;
    });
  });

export const recordQuizSubmission = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ journeyId: uuid, summary: z.string().max(2000).nullable().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { recordJourneySignal } = await import("@/server/crm-journey.server");
    return recordJourneySignal({
      journeyId: data.journeyId,
      kind: "quiz_submission",
      summary: data.summary ?? null,
      actorUserId: context.userId,
    });
  });

/* ------------------------------- appointments ------------------------------ */

export const listAppointments = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ scope: z.enum(["upcoming", "past", "all"]).default("upcoming") }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_appointments")
      .select("*, crm_contacts(id, first_name, last_name, phone), crm_accounts(id, name)")
      .order("starts_at", { ascending: data.scope === "upcoming" })
      .limit(200);
    const nowIso = new Date().toISOString();
    if (data.scope === "upcoming") q = q.gte("starts_at", nowIso);
    if (data.scope === "past") q = q.lt("starts_at", nowIso);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const createAppointment = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        journeyId: uuid,
        kind: z.enum(APPOINTMENT_KINDS),
        startsAt: z.string().datetime({ offset: true }),
        notes: z.string().max(1000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: journey, error } = await context.supabase
      .from("crm_client_journeys")
      .select("id, account_id, contact_id, crm_contacts(first_name, last_name)")
      .eq("id", data.journeyId)
      .maybeSingle();
    if (error) throw error;
    if (!journey) throw new Error("journey_not_found");
    const contact = journey.crm_contacts as unknown as {
      first_name: string;
      last_name: string | null;
    } | null;
    const who = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ");

    const starts = new Date(data.startsAt);
    const { data: appointment, error: insertError } = await context.supabase
      .from("crm_appointments")
      .insert({
        account_id: journey.account_id,
        contact_id: journey.contact_id,
        journey_id: journey.id,
        kind: data.kind,
        title: `${data.kind.replace(/_/g, " ")} — ${who}`.trim(),
        starts_at: starts.toISOString(),
        ends_at: new Date(starts.getTime() + 30 * 60_000).toISOString(),
        source: "manual",
        notes: data.notes ?? null,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const { onAppointmentScheduled } = await import("@/server/crm-journey.server");
    const dial = await onAppointmentScheduled(appointment.id, context.userId);
    return { appointmentId: appointment.id, dial };
  });

export const setAppointmentStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        appointmentId: uuid,
        status: z.enum(["scheduled", "confirmed", "completed", "no_show", "canceled"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("crm_appointments")
      .update({ status: data.status })
      .eq("id", data.appointmentId);
    if (error) throw error;
    const { onAppointmentStatusChange } = await import("@/server/crm-journey.server");
    const dial = await onAppointmentStatusChange(data.appointmentId, data.status, context.userId);
    return { ok: true, dial };
  });
