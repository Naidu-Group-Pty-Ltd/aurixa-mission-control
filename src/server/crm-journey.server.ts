// The client journey's consequences. Stage transitions and appointment
// outcomes are the ONLY sources of outbound voice calls — this module is where
// a tracker event becomes (or refuses to become) a dial, always through
// enqueueOutboundForTrigger and the campaign rules.
//
// The journey-event rows written here keep the prime repo's wire shape
// ({ fromStage, toStage } in metadata), so anything consuming
// platform.client_stage_changed events can read these unmodified.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { enqueueOutboundForTrigger, type EnqueueOutcome } from "@/server/voice.server";

type VoiceTriggerType = Database["public"]["Enums"]["voice_trigger_type"];
type AppointmentKind = Database["public"]["Enums"]["crm_appointment_kind"];

/** Appointment kind -> the trigger fired when it is booked. */
const SCHEDULED_TRIGGER: Partial<Record<AppointmentKind, VoiceTriggerType>> = {
  discovery: "discovery_reminder",
  strategy_phone: "strategy_confirmation",
  strategy_zoom: "strategy_confirmation",
  ifc_phone: "ifc_confirmation",
  ifc_zoom: "ifc_confirmation",
};

/** Appointment kind -> the trigger fired when it is marked a no-show. */
const NO_SHOW_TRIGGER: Partial<Record<AppointmentKind, VoiceTriggerType>> = {
  discovery: "discovery_no_show",
  strategy_phone: "strategy_no_show",
  strategy_zoom: "strategy_no_show",
  ifc_phone: "ifc_no_show",
  ifc_zoom: "ifc_no_show",
};

/** Journey stage entered -> the trigger fired (only stages that dial). */
const STAGE_TRIGGER: Record<string, VoiceTriggerType> = {
  new_lead: "opt_in_follow_up",
  engaged: "nurture",
};

const KIND_CALL_TYPE: Partial<Record<AppointmentKind, string>> = {
  strategy_phone: "phone",
  strategy_zoom: "zoom",
  ifc_phone: "phone",
  ifc_zoom: "zoom",
};

type JourneySubject = {
  journeyId: string;
  accountId: string;
  contactId: string;
  phone: string | null;
  fullName: string;
  firstName: string;
};

async function subjectForJourney(journeyId: string): Promise<JourneySubject | null> {
  const { data, error } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id, account_id, contact_id, crm_contacts(id, first_name, last_name, phone)")
    .eq("id", journeyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const contact = data.crm_contacts as unknown as {
    first_name: string;
    last_name: string | null;
    phone: string | null;
  } | null;
  return {
    journeyId: data.id,
    accountId: data.account_id,
    contactId: data.contact_id,
    phone: contact?.phone ?? null,
    firstName: contact?.first_name ?? "",
    fullName: [contact?.first_name, contact?.last_name].filter(Boolean).join(" "),
  };
}

async function fire(
  trigger: VoiceTriggerType,
  subject: JourneySubject,
  opts?: {
    appointmentId?: string;
    appointmentAt?: Date;
    extras?: Record<string, unknown>;
    actorUserId?: string | null;
  },
): Promise<EnqueueOutcome> {
  if (!subject.phone) return { queued: false, reason: "no_phone" };
  return enqueueOutboundForTrigger({
    triggerType: trigger,
    phone: subject.phone,
    fullName: subject.fullName,
    firstName: subject.firstName,
    accountId: subject.accountId,
    contactId: subject.contactId,
    journeyId: subject.journeyId,
    appointmentId: opts?.appointmentId ?? null,
    appointmentAt: opts?.appointmentAt ?? null,
    extras: opts?.extras,
    createdBy: opts?.actorUserId ?? null,
  });
}

/* ------------------------------- transitions ------------------------------- */

export async function transitionJourneyStage(input: {
  journeyId: string;
  toStage: string;
  reason?: string | null;
  source?: "call" | "manual" | "system" | "webhook";
  actorUserId?: string | null;
  callId?: string | null;
}): Promise<{ fromStage: string; toStage: string; dial: EnqueueOutcome | null }> {
  const { data: journey, error } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id, stage_key")
    .eq("id", input.journeyId)
    .maybeSingle();
  if (error) throw error;
  if (!journey) throw new Error("journey_not_found");

  const { data: stage, error: stageError } = await supabaseAdmin
    .from("crm_journey_stages")
    .select("key, is_active")
    .eq("key", input.toStage)
    .maybeSingle();
  if (stageError) throw stageError;
  if (!stage || !stage.is_active) throw new Error("unknown_stage");

  const fromStage = journey.stage_key;
  if (fromStage !== input.toStage) {
    const { error: updateError } = await supabaseAdmin
      .from("crm_client_journeys")
      .update({ stage_key: input.toStage, entered_stage_at: new Date().toISOString() })
      .eq("id", input.journeyId);
    if (updateError) throw updateError;

    const { error: eventError } = await supabaseAdmin.from("crm_journey_events").insert({
      journey_id: input.journeyId,
      from_stage: fromStage,
      to_stage: input.toStage,
      reason: input.reason ?? null,
      source: input.source ?? "manual",
      actor_user_id: input.actorUserId ?? null,
      call_id: input.callId ?? null,
      metadata: { fromStage, toStage: input.toStage } as Json,
    });
    if (eventError) console.error("[journey] event write failed:", eventError.message);
  }

  let dial: EnqueueOutcome | null = null;
  const trigger = STAGE_TRIGGER[input.toStage];
  if (trigger && fromStage !== input.toStage) {
    const subject = await subjectForJourney(input.journeyId);
    if (subject) dial = await fire(trigger, subject, { actorUserId: input.actorUserId });
  }
  return { fromStage, toStage: input.toStage, dial };
}

/** A quiz submission carries a summary the follow-up agent is briefed with. */
export async function recordJourneySignal(input: {
  journeyId: string;
  kind: "quiz_submission" | "nurture_step";
  summary?: string | null;
  actorUserId?: string | null;
}): Promise<EnqueueOutcome> {
  const subject = await subjectForJourney(input.journeyId);
  if (!subject) return { queued: false, reason: "journey_not_found" };

  const { error } = await supabaseAdmin.from("crm_journey_events").insert({
    journey_id: input.journeyId,
    reason: input.kind,
    source: "system",
    actor_user_id: input.actorUserId ?? null,
    metadata: { kind: input.kind, summary: input.summary ?? null } as Json,
  });
  if (error) console.error("[journey] signal event write failed:", error.message);

  if (input.kind === "quiz_submission") {
    return fire("quiz_follow_up", subject, {
      extras: input.summary ? { quizSummary: input.summary } : undefined,
      actorUserId: input.actorUserId,
    });
  }
  return fire("nurture", subject, { actorUserId: input.actorUserId });
}

/* ------------------------------- appointments ------------------------------ */

export async function onAppointmentScheduled(
  appointmentId: string,
  actorUserId?: string | null,
): Promise<EnqueueOutcome | null> {
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id, kind, starts_at, journey_id, contact_id, account_id")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appointment) return null;

  // Booking an appointment advances the journey to its matching stage.
  if (appointment.journey_id) {
    const stageFor: Partial<Record<AppointmentKind, string>> = {
      discovery: "discovery_call",
      strategy_phone: "strategy_session",
      strategy_zoom: "strategy_session",
      ifc_phone: "finance_consult",
      ifc_zoom: "finance_consult",
    };
    const target = stageFor[appointment.kind];
    if (target) {
      try {
        await transitionJourneyStage({
          journeyId: appointment.journey_id,
          toStage: target,
          reason: `appointment_booked:${appointment.kind}`,
          source: "system",
          actorUserId,
        });
      } catch (err) {
        console.error("[journey] stage advance on booking failed:", (err as Error).message);
      }
    }
  }

  const trigger = SCHEDULED_TRIGGER[appointment.kind];
  if (!trigger || !appointment.journey_id) return null;
  const subject = await subjectForJourney(appointment.journey_id);
  if (!subject) return null;
  return fire(trigger, subject, {
    appointmentId: appointment.id,
    appointmentAt: new Date(appointment.starts_at),
    extras: {
      discoveryCallTime: appointment.starts_at,
      callType: KIND_CALL_TYPE[appointment.kind],
    },
    actorUserId,
  });
}

export async function onAppointmentStatusChange(
  appointmentId: string,
  status: Database["public"]["Enums"]["crm_appointment_status"],
  actorUserId?: string | null,
): Promise<EnqueueOutcome | null> {
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id, kind, starts_at, journey_id")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appointment || !appointment.journey_id) return null;

  if (status === "no_show") {
    const trigger = NO_SHOW_TRIGGER[appointment.kind];
    if (!trigger) return null;
    const subject = await subjectForJourney(appointment.journey_id);
    if (!subject) return null;
    return fire(trigger, subject, {
      appointmentId: appointment.id,
      // A no-show call anchors on the *event* (now + delay), but the agent is
      // told the missed time so it can rebook naturally.
      extras: {
        discoveryCallTime: appointment.starts_at,
        callType: KIND_CALL_TYPE[appointment.kind],
      },
      actorUserId,
    });
  }

  if (status === "canceled") {
    // A canceled appointment revokes any reminder still waiting on it.
    const { error: cancelError } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({ status: "canceled", last_error: "appointment_canceled" })
      .eq("appointment_id", appointmentId)
      .in("status", ["pending", "dispatching"]);
    if (cancelError) console.error("[journey] reminder cancel failed:", cancelError.message);
  }
  return null;
}
