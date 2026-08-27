// Operator telephony — the human softphone beside the AI voice fleet.
//
// The browser runs Twilio's Voice JS SDK as a registered client; this module
// is everything that has to happen on the server: minting the access token
// (a plain HS256 JWT — no Twilio SDK on the Worker), validating Twilio's
// webhook signatures, answering TwiML for both call directions, keeping the
// registration table that decides which browsers ring, and folding call
// lifecycle callbacks into the phone_calls ledger and the CRM.
//
// The Twilio number does not exist yet, and that is a supported state: every
// credential is a Worker env secret, `telephonyConfig()` names exactly which
// are missing, the UI reports "not configured" instead of erroring, and the
// webhook routes answer 503 rather than pretending. Nothing here invents a
// credential or a phone number.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { findContactByPhone, normalizePhone } from "@/server/voice.server";
import type { Database, Json } from "@/integrations/supabase/types";

/* --------------------------------- config --------------------------------- */

export type TelephonyConfig = {
  ready: boolean;
  missing: string[];
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  authToken: string;
  twimlAppSid: string;
  callerId: string;
};

const REQUIRED_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_CALLER_ID",
] as const;

export function telephonyConfig(): TelephonyConfig {
  const values = Object.fromEntries(REQUIRED_ENV.map((k) => [k, process.env[k] ?? ""]));
  const missing = REQUIRED_ENV.filter((k) => !values[k]);
  return {
    ready: missing.length === 0,
    missing: [...missing],
    accountSid: values.TWILIO_ACCOUNT_SID,
    apiKeySid: values.TWILIO_API_KEY_SID,
    apiKeySecret: values.TWILIO_API_KEY_SECRET,
    authToken: values.TWILIO_AUTH_TOKEN,
    twimlAppSid: values.TWILIO_TWIML_APP_SID,
    callerId: values.TWILIO_CALLER_ID,
  };
}

// Twilio signs the URL it actually called. Behind Cloudflare the incoming
// Request's host is reliable enough in production, but the canonical public
// origin is what gets configured in the Twilio console, so signatures are
// checked against it — never against a proxy-rewritten host.
const PUBLIC_ORIGIN = (process.env.PUBLIC_APP_URL ?? "https://mission-control.aurixasystems.com.au")
  .replace(/\/+$/, "");

export function publicUrlFor(pathnameAndQuery: string): string {
  return PUBLIC_ORIGIN + pathnameAndQuery;
}

/* ----------------------------- token minting ------------------------------ */

const encoder = new TextEncoder();

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(encoder.encode(JSON.stringify(value)));
}

async function hmac(algorithm: "SHA-1" | "SHA-256", secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

export const TOKEN_TTL_SECONDS = 3600;

/**
 * A Twilio Voice access token is an ordinary HS256 JWT with a `cty` of
 * `twilio-fpa;v=1`, issued by the API key and subject to the account, whose
 * grants name the client identity and the TwiML App that answers its
 * outgoing calls. Hand-rolled because the Twilio Node SDK assumes Node
 * crypto and this runs on a Cloudflare Worker.
 */
export async function mintVoiceToken(
  config: TelephonyConfig,
  identity: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${config.apiKeySid}-${nowSeconds}`,
    iss: config.apiKeySid,
    sub: config.accountSid,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: config.twimlAppSid },
      },
    },
  };
  const signingInput = `${base64UrlFromJson(header)}.${base64UrlFromJson(payload)}`;
  const signature = await hmac("SHA-256", config.apiKeySecret, signingInput);
  return `${signingInput}.${base64UrlFromBytes(signature)}`;
}

/* --------------------------- signature validation -------------------------- */

/**
 * Twilio's webhook signature: base64(HMAC-SHA1(authToken, url + sorted
 * concatenated POST params)). Compared constant-time. The url is the
 * canonical public URL for the route, query string included.
 */
export async function expectedTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const mac = await hmac("SHA-1", authToken, data);
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type TwilioRequest =
  | { ok: true; params: Record<string, string> }
  | { ok: false; response: Response };

/**
 * Parse and authenticate a Twilio webhook POST. Fails closed: no config →
 * 503, bad or missing signature → 403 with an audit row. Returns the form
 * params on success.
 */
export async function readTwilioRequest(request: Request, pathname: string): Promise<TwilioRequest> {
  const config = telephonyConfig();
  if (!config.authToken) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "telephony_not_configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  const raw = await request.text();
  const parsed = new URLSearchParams(raw);
  const params: Record<string, string> = {};
  for (const [k, v] of parsed.entries()) params[k] = v;

  const requestUrl = new URL(request.url);
  const url = publicUrlFor(pathname + requestUrl.search);
  const provided = request.headers.get("x-twilio-signature") ?? "";
  const expected = await expectedTwilioSignature(config.authToken, url, params);

  if (!provided || !constantTimeEqual(provided, expected)) {
    await writeAuditLog({
      action: "telephony_webhook_refused",
      entityType: "telephony",
      entityId: pathname,
      metadata: { reason: provided ? "bad_signature" : "missing_signature" },
    }).catch(() => undefined);
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return { ok: true, params };
}

/* --------------------------------- TwiML ---------------------------------- */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twimlResponse(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

const STATUS_CALLBACK_PATH = "/api/public/telephony/status";

/**
 * TwiML for an operator's outgoing call (the TwiML App's Voice URL). The
 * browser dials `To` (a real number); we bridge it with the purchased
 * number as caller id and follow the far leg's lifecycle via status
 * callbacks on the <Number> noun.
 */
export function buildOutboundTwiml(config: TelephonyConfig, to: string): string {
  const callback = publicUrlFor(STATUS_CALLBACK_PATH);
  return (
    `<Dial callerId="${escapeXml(config.callerId)}" answerOnBridge="true">` +
    `<Number statusCallback="${escapeXml(callback)}" statusCallbackEvent="initiated ringing answered completed">` +
    escapeXml(to) +
    `</Number></Dial>`
  );
}

/**
 * TwiML for an inbound call to the purchased number. Rings every registered
 * browser whose heartbeat is fresh; with nobody registered, says so and
 * hangs up (the missed call is ledgered and notified either way).
 */
export function buildInboundTwiml(identities: string[]): string {
  if (identities.length === 0) {
    return (
      `<Say voice="alice" language="en-AU">Thanks for calling Aurixa Systems. ` +
      `Nobody is available to take your call right now. The team has been notified ` +
      `and will call you back as soon as possible.</Say>`
    );
  }
  const clients = identities
    .slice(0, 8)
    .map((identity) => `<Client>${escapeXml(identity)}</Client>`)
    .join("");
  const action = publicUrlFor(`${STATUS_CALLBACK_PATH}?leg=inbound-result`);
  return (
    `<Dial answerOnBridge="true" timeout="25" action="${escapeXml(action)}" method="POST">` +
    clients +
    `</Dial>`
  );
}

/* ------------------------------ registrations ----------------------------- */

export const REGISTRATION_FRESH_MINUTES = 3;

export function identityForUser(userId: string): string {
  return `op_${userId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export async function upsertRegistration(input: {
  userId: string;
  displayName?: string | null;
  ringEnabled?: boolean;
}): Promise<{ identity: string }> {
  const identity = identityForUser(input.userId);
  const patch: Record<string, unknown> = {
    identity,
    user_id: input.userId,
    last_seen_at: new Date().toISOString(),
  };
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.ringEnabled !== undefined) patch.ring_enabled = input.ringEnabled;
  const { error } = await supabaseAdmin
    .from("telephony_registrations")
    .upsert(patch as never, { onConflict: "identity" });
  if (error) console.error("[telephony] registration upsert failed:", error.message);
  return { identity };
}

export async function freshRingableIdentities(): Promise<string[]> {
  const cutoff = new Date(Date.now() - REGISTRATION_FRESH_MINUTES * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("telephony_registrations")
    .select("identity")
    .eq("ring_enabled", true)
    .gte("last_seen_at", cutoff)
    .order("last_seen_at", { ascending: false });
  if (error) {
    console.error("[telephony] registration read failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => r.identity);
}

/* ------------------------------- call ledger ------------------------------- */

async function contactForNumber(phone: string) {
  if (!phone || phone.startsWith("client:")) return null;
  try {
    return await findContactByPhone(phone);
  } catch {
    return null;
  }
}

/** The operator placed a call from the browser (TwiML App leg). */
export async function ledgerOutboundStart(params: Record<string, string>): Promise<void> {
  const to = params.To ?? "";
  const fromIdentity = (params.From ?? "").replace(/^client:/, "");
  const matched = await contactForNumber(to);
  const { error } = await supabaseAdmin.from("phone_calls").insert({
    twilio_call_sid: params.CallSid ?? null,
    direction: "outbound",
    operator_identity: fromIdentity || null,
    phone_number: normalizePhone(to) || to,
    contact_id: matched?.id ?? null,
    account_id: matched?.account_id ?? null,
    customer_name: matched ? [matched.first_name, matched.last_name].filter(Boolean).join(" ") : null,
    status: "initiated",
    metadata: { source: "softphone" } as Json,
  });
  if (error && error.code !== "23505") {
    console.error("[telephony] outbound ledger insert failed:", error.message);
  }
}

/** An inbound call hit the purchased number. */
export async function ledgerInboundStart(params: Record<string, string>): Promise<void> {
  const from = params.From ?? "";
  const matched = await contactForNumber(from);
  const { error } = await supabaseAdmin.from("phone_calls").insert({
    twilio_call_sid: params.CallSid ?? null,
    direction: "inbound",
    phone_number: normalizePhone(from) || from,
    contact_id: matched?.id ?? null,
    account_id: matched?.account_id ?? null,
    customer_name: matched ? [matched.first_name, matched.last_name].filter(Boolean).join(" ") : null,
    status: "ringing",
    metadata: { source: "softphone" } as Json,
  });
  if (error && error.code !== "23505") {
    console.error("[telephony] inbound ledger insert failed:", error.message);
  }
}

// Twilio's call lifecycle vocabulary, folded to the handful of terminal and
// transitional states the ledger reasons about. Unknown values pass through
// verbatim — status is TEXT for exactly that reason.
const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
export const MISSED_STATUSES = new Set(["busy", "failed", "no-answer", "canceled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Fold a status callback (or an inbound <Dial> action result) into the
 * ledger. Callbacks arrive out of order and for legs we may not have seen;
 * an upsert keyed by CallSid absorbs both.
 */
export async function ingestStatusCallback(
  params: Record<string, string>,
  leg: string | null,
): Promise<void> {
  const callSid = params.CallSid ?? "";
  if (!callSid) return;

  // The inbound <Dial> action reports the DIAL outcome on the parent call.
  const dialStatus = leg === "inbound-result" ? (params.DialCallStatus ?? "") : "";
  const callStatus = (params.CallStatus ?? "").toLowerCase();
  const status = dialStatus ? (dialStatus === "answered" ? "completed" : dialStatus) : callStatus;
  if (!status) return;

  const { data: existing, error: readError } = await supabaseAdmin
    .from("phone_calls")
    .select("id, direction, status, contact_id, account_id, phone_number, customer_name, answered_at, metadata")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (readError) {
    console.error("[telephony] ledger read failed:", readError.message);
    return;
  }

  const nowIso = new Date().toISOString();
  const patch: Database["public"]["Tables"]["phone_calls"]["Update"] = { status };
  if (status === "in-progress" && !existing?.answered_at) patch.answered_at = nowIso;
  if (isTerminalStatus(status)) {
    patch.ended_at = nowIso;
    const duration = Number(params.CallDuration ?? params.DialCallDuration ?? "");
    if (Number.isFinite(duration) && duration >= 0) patch.duration_seconds = duration;
  }

  if (existing) {
    const { error } = await supabaseAdmin.from("phone_calls").update(patch).eq("id", existing.id);
    if (error) console.error("[telephony] ledger update failed:", error.message);
  } else {
    const to = params.To ?? "";
    const from = params.From ?? "";
    const far = to.startsWith("client:") ? from : from.startsWith("client:") ? to : to || from;
    const direction = (params.Direction ?? "").startsWith("outbound") ? "outbound" : "inbound";
    const matched = await contactForNumber(far);
    const { error } = await supabaseAdmin.from("phone_calls").insert({
      twilio_call_sid: callSid,
      parent_call_sid: params.ParentCallSid ?? null,
      direction,
      phone_number: normalizePhone(far) || far || "unknown",
      contact_id: matched?.id ?? null,
      account_id: matched?.account_id ?? null,
      customer_name: matched
        ? [matched.first_name, matched.last_name].filter(Boolean).join(" ")
        : null,
      ...patch,
      metadata: { source: "softphone", late_ledger: true } as Json,
    });
    if (error && error.code !== "23505") {
      console.error("[telephony] late ledger insert failed:", error.message);
    }
  }

  if (!isTerminalStatus(status)) return;

  // Terminal follow-through: CRM activity for a connected call, a missed-call
  // notification for an inbound one nobody answered. Re-read for the final row.
  const { data: final } = await supabaseAdmin
    .from("phone_calls")
    .select("id, direction, status, contact_id, phone_number, customer_name, duration_seconds, metadata")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (!final) return;
  const meta = (final.metadata ?? {}) as Record<string, unknown>;

  if (final.status === "completed" && final.contact_id && !meta.activity_logged) {
    const { data: contactRow } = await supabaseAdmin
      .from("crm_contacts")
      .select("account_id")
      .eq("id", final.contact_id)
      .maybeSingle();
    if (!contactRow?.account_id) return;
    const { error } = await supabaseAdmin.from("crm_activities").insert({
      account_id: contactRow.account_id,
      contact_id: final.contact_id,
      kind: "call",
      title:
        `${final.direction === "inbound" ? "Inbound" : "Outbound"} phone call` +
        (final.duration_seconds ? ` (${final.duration_seconds}s)` : ""),
      occurred_at: new Date().toISOString(),
      actor_label: "Operator softphone",
      entity_type: "phone_call",
      entity_id: final.id,
      metadata: { source: "softphone", duration_seconds: final.duration_seconds } as Json,
    });
    if (error) console.error("[telephony] activity insert failed:", error.message);
    await supabaseAdmin
      .from("phone_calls")
      .update({ metadata: { ...meta, activity_logged: true } as Json })
      .eq("id", final.id);
  }

  if (final.direction === "inbound" && MISSED_STATUSES.has(final.status) && !meta.missed_notified) {
    await notifyOperators({
      kind: "phone_missed_call",
      severity: "warning",
      title: "Missed phone call",
      body: `${final.customer_name || final.phone_number} called and nobody answered.`,
      url: "/voice/phone",
      metadata: { phone_call_id: final.id },
    }).catch((err) => console.error("[telephony] missed-call notify failed:", (err as Error).message));
    await supabaseAdmin
      .from("phone_calls")
      .update({ metadata: { ...meta, missed_notified: true } as Json })
      .eq("id", final.id);
  }
}
