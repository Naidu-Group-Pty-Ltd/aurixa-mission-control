// The tools an inbound VAPI assistant can call mid-conversation, answered
// synchronously from our own CRM — the re-homing of everything GoHighLevel
// used to do for the squad: contact resolution, the call-context store,
// calendar availability, booking, the context bridge and handoff routing.
//
// Every reply is the VAPI tool-result envelope:
//   { results: [{ toolCallId, result: "<stringified JSON>" }] }
// VAPI matches results to calls by id; a bare JSON body is silently ignored.
//
// Availability is deterministic, not model-resolved: the Make classifier's
// business rules (Mon–Fri 13:00–18:00 Australia/Sydney, no same-day, default
// 30 minutes) are code here, so a compliance-adjacent promise like "we can do
// Tuesday at 3" never depends on a model's date arithmetic.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { normalizePhone, phonesMatch } from "@/server/voice.server";

type Rec = Record<string, any>;

function asRecord(v: unknown): Rec {
  return v && typeof v === "object" ? (v as Rec) : {};
}

/* ------------------------------ envelope ---------------------------------- */

export function toolEnvelope(toolCallId: string, result: Record<string, unknown>): Rec {
  return { results: [{ toolCallId, result: JSON.stringify(result) }] };
}

type ToolCall = { id: string; name: string; args: Rec };

/** VAPI spells the tool-call list at least three ways; accept all of them. */
export function extractToolCalls(message: Rec): ToolCall[] {
  const out: ToolCall[] = [];
  const push = (id: unknown, name: unknown, rawArgs: unknown) => {
    if (typeof id !== "string" || typeof name !== "string") return;
    let args: Rec = {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }
    } else {
      args = asRecord(rawArgs);
    }
    out.push({ id, name, args });
  };

  for (const raw of Array.isArray(message.toolCallList) ? message.toolCallList : []) {
    const tc = asRecord(raw);
    const fn = asRecord(tc.function);
    push(tc.id, fn.name ?? tc.name, fn.arguments ?? tc.arguments);
  }
  if (out.length === 0) {
    for (const raw of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const tc = asRecord(raw);
      const fn = asRecord(tc.function);
      push(tc.id, fn.name, fn.arguments);
    }
  }
  if (out.length === 0) {
    for (const raw of Array.isArray(message.toolWithToolCallList)
      ? message.toolWithToolCallList
      : []) {
      const tc = asRecord(asRecord(raw).toolCall);
      const fn = asRecord(tc.function);
      push(tc.id, fn.name, fn.arguments);
    }
  }
  return out;
}

/* ------------------------- availability (pure) ----------------------------- */

export const BOOKING_WINDOW = {
  timezone: "Australia/Sydney",
  startMinutes: 13 * 60,
  endMinutes: 18 * 60,
  slotMinutes: 30,
  searchDays: 7,
} as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sydneyParts(date: Date): {
  y: number;
  m: number;
  d: number;
  day: number;
  minutes: number;
} {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: BOOKING_WINDOW.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    day: WEEKDAYS.indexOf(get("weekday").slice(0, 3)),
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/**
 * The candidate 30-minute slot starts over the next week, skipping weekends
 * and today (no same-day bookings), expressed as UTC instants. Built by
 * scanning forward in 30-minute steps from the next UTC half-hour — the same
 * DST-proof trick the quiet-hours shift uses.
 */
export function candidateSlots(now: Date): Date[] {
  const slots: Date[] = [];
  const today = sydneyParts(now);
  const todayKey = today.y * 10_000 + today.m * 100 + today.d;
  const start = new Date(Math.ceil(now.getTime() / (30 * 60_000)) * 30 * 60_000);
  const horizonMs = BOOKING_WINDOW.searchDays * 24 * 60 * 60_000;
  for (let t = start.getTime(); t < start.getTime() + horizonMs; t += 30 * 60_000) {
    const d = new Date(t);
    const p = sydneyParts(d);
    const key = p.y * 10_000 + p.m * 100 + p.d;
    if (key === todayKey) continue; // no same-day bookings
    if (p.day === 0 || p.day === 6) continue;
    if (p.minutes < BOOKING_WINDOW.startMinutes) continue;
    if (p.minutes + BOOKING_WINDOW.slotMinutes > BOOKING_WINDOW.endMinutes) continue;
    slots.push(d);
  }
  return slots;
}

export type AppointmentKind =
  | "discovery"
  | "strategy_phone"
  | "strategy_zoom"
  | "ifc_phone"
  | "ifc_zoom";

/**
 * Deterministic version of the Make booking-intent classifier. Keyword-based;
 * anything ambiguous asks for clarification instead of guessing.
 */
export function classifyBookingIntent(text: string | null | undefined): {
  kind: AppointmentKind | null;
  clarificationQuestion: string | null;
} {
  const t = (text ?? "").toLowerCase();
  const zoom = /\bzoom\b|video|online meeting/.test(t);
  if (/discovery/.test(t)) return { kind: "discovery", clarificationQuestion: null };
  if (/strategy/.test(t)) {
    return { kind: zoom ? "strategy_zoom" : "strategy_phone", clarificationQuestion: null };
  }
  if (/finance|ifc|lending|loan|borrow/.test(t)) {
    return { kind: zoom ? "ifc_zoom" : "ifc_phone", clarificationQuestion: null };
  }
  return {
    kind: null,
    clarificationQuestion:
      "Would you like a Discovery Call, a Strategy Session, or an Initial Finance Consult — and phone or Zoom?",
  };
}

const KIND_LABEL: Record<AppointmentKind, string> = {
  discovery: "Discovery Call",
  strategy_phone: "Strategy Session (Phone)",
  strategy_zoom: "Strategy Session (Zoom)",
  ifc_phone: "Initial Finance Consult (Phone)",
  ifc_zoom: "Initial Finance Consult (Zoom)",
};

async function freeSlots(now: Date, limit = 8): Promise<Date[]> {
  const candidates = candidateSlots(now);
  if (candidates.length === 0) return [];
  const horizonEnd = candidates[candidates.length - 1];
  // One human hosts every appointment type, so any booked slot blocks all kinds.
  const { data: booked, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("starts_at, ends_at")
    .in("status", ["scheduled", "confirmed"])
    .gte("starts_at", now.toISOString())
    .lte("starts_at", new Date(horizonEnd.getTime() + 60 * 60_000).toISOString());
  if (error) {
    console.error("[voice-tools] booked slot read failed:", error.message);
    return [];
  }
  const taken = (booked ?? []).map((b) => ({
    start: Date.parse(b.starts_at),
    end: b.ends_at ? Date.parse(b.ends_at) : Date.parse(b.starts_at) + 30 * 60_000,
  }));
  return candidates
    .filter((slot) => {
      const s = slot.getTime();
      const e = s + BOOKING_WINDOW.slotMinutes * 60_000;
      return !taken.some((t) => s < t.end && e > t.start);
    })
    .slice(0, limit);
}

function slotLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: BOOKING_WINDOW.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/* ------------------------------ tool handlers ------------------------------ */

type CallIdentity = { vapiCallId: string; callerPhone: string };

function identityFrom(message: Rec, args: Rec): CallIdentity {
  const call = asRecord(message.call);
  const vapiCallId: string =
    args.vapiCallId ?? args.vapi_call_id ?? call.id ?? message.callId ?? "";
  const callerPhone: string =
    args.callerPhone ??
    args.customer_number ??
    args.phone ??
    asRecord(message.customer).number ??
    asRecord(call.customer).number ??
    "";
  return { vapiCallId, callerPhone };
}

async function upsertContext(
  identity: CallIdentity,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!identity.vapiCallId) return;
  const { error } = await supabaseAdmin.from("voice_call_context").upsert(
    {
      vapi_call_id: identity.vapiCallId,
      caller_phone: identity.callerPhone || null,
      normalized_phone: normalizePhone(identity.callerPhone) || null,
      ...fields,
    },
    { onConflict: "vapi_call_id" },
  );
  if (error) console.error("[voice-tools] context upsert failed:", error.message);
}

async function readContext(identity: CallIdentity): Promise<Rec | null> {
  if (identity.vapiCallId) {
    const { data } = await supabaseAdmin
      .from("voice_call_context")
      .select("*")
      .eq("vapi_call_id", identity.vapiCallId)
      .maybeSingle();
    if (data) return data;
  }
  // Fallback for a tool invoked with only the caller's number (a squad member
  // that lost the call id across a transfer): most recent context for the phone.
  const normalized = normalizePhone(identity.callerPhone);
  if (!normalized) return null;
  const { data } = await supabaseAdmin
    .from("voice_call_context")
    .select("*")
    .eq("normalized_phone", normalized)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function handleResolveContact(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const fullName: string = tc.args.full_name ?? tc.args.fullName ?? "";
  const firstNameArg: string = tc.args.first_name ?? tc.args.firstName ?? "";
  const lastNameArg: string = tc.args.last_name ?? tc.args.lastName ?? "";
  const normalized = normalizePhone(identity.callerPhone);

  // 1) Search our CRM by phone.
  let matched: Rec | null = null;
  if (normalized.replace(/\D/g, "").length >= 8) {
    const last9 = normalized.replace(/\D/g, "").slice(-9);
    const { data, error } = await supabaseAdmin
      .from("crm_contacts")
      .select("id, account_id, first_name, last_name, phone")
      .not("phone", "is", null)
      .ilike("phone", `%${last9}`)
      .limit(5);
    if (error) console.error("[voice-tools] contact search failed:", error.message);
    matched = (data ?? []).find((c) => phonesMatch(c.phone, identity.callerPhone)) ?? null;
  }

  if (matched) {
    const first = matched.first_name ?? "";
    const full = [matched.first_name, matched.last_name].filter(Boolean).join(" ");
    await upsertContext(identity, {
      contact_id: matched.id,
      account_id: matched.account_id,
      first_name: first,
      full_name: full,
      contact_state: "RESOLVED",
      contact_found: true,
      contact_created: false,
      source: "resolve_contact",
    });
    return {
      success: true,
      contactId: matched.id,
      firstName: first,
      fullName: full,
      phone: identity.callerPhone,
      contactState: "RESOLVED",
      contactFound: true,
      contactCreated: false,
      nextAction: "continueConversation",
      message: `Existing contact resolved successfully. The caller's first name is ${first}. Use this first name naturally in the next spoken response.`,
    };
  }

  // 2) Unknown caller with no name yet: ask once, then call again with names.
  const anyName = fullName || firstNameArg || lastNameArg;
  if (!anyName) {
    await upsertContext(identity, {
      contact_state: "NEEDS_NAME",
      contact_found: false,
      contact_created: false,
      source: "resolve_contact",
    });
    return {
      success: true,
      contactState: "NEEDS_NAME",
      requiresName: true,
      nextAction: "askForFullName",
      message:
        "No contact matches this number. Ask the caller for their full name once, then call resolve_contact again with the name fields.",
    };
  }

  // 3) Create the contact — an account (lifecycle: lead) plus its person.
  const firstName = firstNameArg || fullName.split(/\s+/)[0];
  const lastName = lastNameArg || fullName.split(/\s+/).slice(1).join(" ") || null;
  const displayName = [firstName, lastName].filter(Boolean).join(" ");

  const { data: account, error: accountError } = await supabaseAdmin
    .from("crm_accounts")
    .insert({
      name: displayName || identity.callerPhone,
      lifecycle_stage: "lead",
      source: "voice_inbound",
      notes: "Created by the inbound voice agent from an unrecognised caller.",
    })
    .select("id")
    .single();
  if (accountError) throw accountError;

  const { data: contact, error: contactError } = await supabaseAdmin
    .from("crm_contacts")
    .insert({
      account_id: account.id,
      first_name: firstName,
      last_name: lastName,
      phone: normalized || identity.callerPhone,
      is_primary: true,
    })
    .select("id")
    .single();
  if (contactError) throw contactError;

  const { error: journeyError } = await supabaseAdmin.from("crm_client_journeys").insert({
    contact_id: contact.id,
    account_id: account.id,
    stage_key: "new_lead",
    metadata: { created_by: "voice_inbound" } as Json,
  });
  if (journeyError) console.error("[voice-tools] journey create failed:", journeyError.message);

  await upsertContext(identity, {
    contact_id: contact.id,
    account_id: account.id,
    first_name: firstName,
    full_name: displayName,
    contact_state: "RESOLVED",
    contact_found: false,
    contact_created: true,
    source: "resolve_contact",
  });

  return {
    success: true,
    contactId: contact.id,
    firstName,
    fullName: displayName,
    phone: identity.callerPhone,
    contactState: "RESOLVED",
    contactFound: false,
    contactCreated: true,
    nextAction: "continueConversation",
    message: `New contact created. The caller's first name is ${firstName}. Use this first name naturally in the next spoken response.`,
  };
}

async function handleGetCallContext(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const ctx = await readContext(identity);
  if (!ctx || !ctx.contact_id) {
    return {
      success: true,
      contextFound: false,
      vapiCallId: identity.vapiCallId,
      callerPhone: identity.callerPhone,
      contactState: "UNRESOLVED",
      handoffReady: false,
      nextAction: "continueWithoutStoredContext",
      message: "No stored caller context found. Continue the conversation and resolve the contact.",
    };
  }
  return {
    success: true,
    contextFound: true,
    vapiCallId: ctx.vapi_call_id,
    callerPhone: ctx.caller_phone,
    contactId: ctx.contact_id,
    firstName: ctx.first_name,
    fullName: ctx.full_name,
    phone: ctx.caller_phone,
    contactState: ctx.contact_state,
    contactFound: ctx.contact_found,
    contactCreated: ctx.contact_created,
    confirmedIntent: ctx.confirmed_intent,
    callerReason: ctx.caller_reason,
    handoffReady: ctx.handoff_ready,
    nextAction: "continueConversation",
    message: `Stored caller context found. The caller's first name is ${ctx.first_name ?? "unknown"}. Use this first name naturally in the next spoken response.`,
  };
}

async function handlePhoneNumberInject(
  tc: ToolCall,
  message: Rec,
): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const ctx = await readContext(identity);
  const confirmedIntent =
    tc.args.confirmedIntent ?? tc.args.confirmed_intent ?? ctx?.confirmed_intent ?? null;
  const callerReason = tc.args.callerReason ?? tc.args.caller_reason ?? ctx?.caller_reason ?? null;
  await upsertContext(identity, {
    confirmed_intent: confirmedIntent,
    caller_reason: callerReason,
    handoff_ready: true,
    source: ctx?.source ?? "phone_number_inject",
  });
  return {
    success: true,
    contactId: ctx?.contact_id ?? tc.args.contactId ?? null,
    firstName: ctx?.first_name ?? tc.args.firstName ?? null,
    fullName: ctx?.full_name ?? tc.args.fullName ?? null,
    phone: identity.callerPhone,
    contactState: ctx?.contact_state ?? "UNRESOLVED",
    confirmedIntent,
    callerReason,
    handoffReady: true,
    vapiCallId: identity.vapiCallId,
    nextAction: "handoff_to_assistant",
  };
}

async function handleCheckAvailability(tc: ToolCall): Promise<Record<string, unknown>> {
  const intent = classifyBookingIntent(
    tc.args.booking_intent_text ?? tc.args.bookingIntentText ?? tc.args.search_reason ?? "",
  );
  if (!intent.kind) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: intent.clarificationQuestion,
      allowed_booking_types: Object.values(KIND_LABEL),
    };
  }
  const slots = await freeSlots(new Date());
  return {
    success: true,
    booking_type: KIND_LABEL[intent.kind],
    kind: intent.kind,
    timezone: BOOKING_WINDOW.timezone,
    duration_minutes: BOOKING_WINDOW.slotMinutes,
    availability: slots.map((s) => ({
      startIso: s.toISOString(),
      endIso: new Date(s.getTime() + BOOKING_WINDOW.slotMinutes * 60_000).toISOString(),
      spoken: slotLabel(s),
    })),
    message:
      slots.length > 0
        ? "Availability returned. Offer only slots from the availability list. Do not create a booking from this tool."
        : "No slots are free in the next week. Offer to have the team call the customer back instead.",
  };
}

async function handleBookAppointment(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const intent = classifyBookingIntent(
    tc.args.booking_intent_text ?? tc.args.bookingIntentText ?? tc.args.booking_type ?? "",
  );
  if (!intent.kind) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: intent.clarificationQuestion,
      allowed_booking_types: Object.values(KIND_LABEL),
    };
  }
  const startRaw: string = tc.args.startTime ?? tc.args.start_time ?? tc.args.startIso ?? "";
  const startMs = Date.parse(startRaw);
  if (!startRaw || Number.isNaN(startMs)) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question:
        "Which exact time slot should be booked? Pass the startTime from the availability list.",
    };
  }
  const start = new Date(startMs);
  const stillFree = (await freeSlots(new Date(), 200)).some(
    (s) => Math.abs(s.getTime() - start.getTime()) < 60_000,
  );
  if (!stillFree) {
    return {
      success: false,
      appointment_created: false,
      slot_taken: true,
      message:
        "That slot is no longer available. Call check_availability again and offer a fresh slot.",
    };
  }

  const ctx = await readContext(identity);
  if (!ctx?.contact_id || !ctx.account_id) {
    return {
      success: false,
      appointment_created: false,
      message:
        "The caller is not resolved to a contact yet. Call resolve_contact first, then book again.",
    };
  }

  const { data: journey } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id")
    .eq("contact_id", ctx.contact_id)
    .maybeSingle();

  const { data: callRow } = await supabaseAdmin
    .from("voice_calls")
    .select("id")
    .eq("vapi_call_id", identity.vapiCallId)
    .maybeSingle();

  const ends = new Date(start.getTime() + BOOKING_WINDOW.slotMinutes * 60_000);
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .insert({
      account_id: ctx.account_id,
      contact_id: ctx.contact_id,
      journey_id: journey?.id ?? null,
      kind: intent.kind,
      title: `${KIND_LABEL[intent.kind]} — ${ctx.full_name ?? identity.callerPhone}`,
      starts_at: start.toISOString(),
      ends_at: ends.toISOString(),
      status: "scheduled",
      source: "voice_agent",
      booked_by_call_id: callRow?.id ?? null,
      notes: tc.args.notes ?? null,
    })
    .select("id, starts_at")
    .single();
  if (error) throw error;

  await upsertContext(identity, { confirmed_intent: intent.kind });

  // Booking consequences (reminder / confirmation calls, journey advance) are
  // one code path, shared with manual bookings from the tracker UI.
  const { onAppointmentScheduled } = await import("@/server/crm-journey.server");
  await onAppointmentScheduled(appointment.id);

  return {
    success: true,
    appointment_created: true,
    appointmentId: appointment.id,
    booking_type: KIND_LABEL[intent.kind],
    startTime: appointment.starts_at,
    timezone: BOOKING_WINDOW.timezone,
    spoken: slotLabel(new Date(appointment.starts_at)),
    message:
      "Booking confirmed in the calendar. Confirm the day and time back to the caller in natural speech.",
  };
}

/* ------------------------------ entry points ------------------------------- */

export async function handleToolCalls(message: Rec): Promise<Rec> {
  const calls = extractToolCalls(message);
  const results: Array<{ toolCallId: string; result: string }> = [];
  for (const tc of calls) {
    let result: Record<string, unknown>;
    try {
      switch (tc.name) {
        case "resolve_contact":
        case "ghl_resolve_contact":
          result = await handleResolveContact(tc, message);
          break;
        case "get_call_context":
          result = await handleGetCallContext(tc, message);
          break;
        case "phoneNumber_inject":
        case "phone_number_inject":
          result = await handlePhoneNumberInject(tc, message);
          break;
        case "check_availability":
          result = await handleCheckAvailability(tc);
          break;
        case "book_appointment":
          result = await handleBookAppointment(tc, message);
          break;
        default:
          result = { success: false, error: `unknown_tool_${tc.name}` };
      }
    } catch (err) {
      console.error(`[voice-tools] ${tc.name} failed:`, (err as Error).message);
      result = {
        success: false,
        error: "tool_failed",
        message: "The tool hit an internal error. Apologise briefly and continue the conversation.",
      };
    }
    results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
  }
  return { results };
}

/* ------------------------------ handoff router ----------------------------- */

export type HandoffIntent = "discovery" | "strategy" | "finance";

/** Deterministic transcript classifier for squad handoffs. */
export function classifyHandoffIntent(transcriptText: string): HandoffIntent {
  const t = transcriptText.toLowerCase();
  const scores: Record<HandoffIntent, number> = { discovery: 0, strategy: 0, finance: 0 };
  for (const m of t.matchAll(/finance|loan|lend|borrow|mortgage|broker|ifc/g)) {
    void m;
    scores.finance += 1;
  }
  for (const m of t.matchAll(/strategy|portfolio|plan(?:ning)?\b|structure/g)) {
    void m;
    scores.strategy += 1;
  }
  for (const m of t.matchAll(/discovery|get started|first (?:call|chat)|new (?:to|client)/g)) {
    void m;
    scores.discovery += 1;
  }
  const best = (Object.entries(scores) as Array<[HandoffIntent, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return best[1] > 0 ? best[0] : "discovery";
}

const HANDOFF_ROLE: Record<HandoffIntent, string> = {
  discovery: "handoff_discovery",
  strategy: "handoff_strategy",
  finance: "handoff_finance",
};

/**
 * Answer an assistant-request / transfer webhook: pick the specialist
 * assistant and re-inject the stored context as variableValues.
 */
export async function routeHandoff(message: Rec): Promise<Rec | null> {
  const call = asRecord(message.call);
  const identity: CallIdentity = {
    vapiCallId: call.id ?? "",
    callerPhone: asRecord(message.customer).number ?? asRecord(call.customer).number ?? "",
  };
  const ctx = await readContext(identity);

  const artifact = asRecord(message.artifact);
  const transcriptText: string = Array.isArray(artifact.messagesOpenAIFormatted)
    ? artifact.messagesOpenAIFormatted
        .map((m: Rec) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
    : (artifact.transcript ?? message.transcript ?? "");

  const intent: HandoffIntent =
    ctx?.confirmed_intent === "strategy_phone" || ctx?.confirmed_intent === "strategy_zoom"
      ? "strategy"
      : ctx?.confirmed_intent === "ifc_phone" || ctx?.confirmed_intent === "ifc_zoom"
        ? "finance"
        : ctx?.confirmed_intent === "discovery"
          ? "discovery"
          : classifyHandoffIntent(transcriptText);

  const { data: agent, error } = await supabaseAdmin
    .from("voice_agents")
    .select("vapi_assistant_id")
    .eq("role", HANDOFF_ROLE[intent])
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("[voice-tools] handoff agent read failed:", error.message);
    return null;
  }
  if (!agent) return null;

  const now = new Date();
  return {
    assistantId: agent.vapi_assistant_id,
    assistantOverrides: {
      variableValues: {
        firstName: ctx?.first_name ?? "",
        fullName: ctx?.full_name ?? "",
        contactId: ctx?.contact_id ?? "",
        callerPhone: identity.callerPhone,
        currentDate: now.toISOString(),
        currentDateUnix: Math.floor(now.getTime() / 1000),
      },
    },
  };
}
