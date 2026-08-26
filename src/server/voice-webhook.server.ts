// VAPI webhook ingestion. The route is a shell; this decides.
//
// Auth fails closed on a shared secret: no configured secret means no webhook,
// and a refusal is written to the audit log — the prime repo lost six weeks of
// call logs to silent 401s, so a rejection here is never quiet.
//
// Fast events (status updates) are applied inline; the end-of-call report is
// queued to voice_call_events for the drain, because enrichment calls vendors
// and a webhook that answers slowly gets retried into duplicates. Tool calls
// and handoff routing MUST answer synchronously — the assistant is holding
// the conversation open waiting for them.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { timingSafeEqualStr } from "@/server/cron-auth.server";
import { writeAuditLog } from "@/server/audit.server";
import { enforceBlacklist } from "@/server/voice.server";
import { handleToolCalls, routeHandoff } from "@/server/voice-tools.server";

type Rec = Record<string, any>;

function asRecord(v: unknown): Rec {
  return v && typeof v === "object" ? (v as Rec) : {};
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function rejected(reason: string): Promise<Response> {
  await writeAuditLog({
    action: "voice_webhook_rejected",
    entityType: "voice_webhook",
    metadata: { reason },
  });
  return json({ ok: false, error: reason }, 401);
}

export async function ingestVapiWebhook(request: Request): Promise<Response> {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || secret.length < 16) return rejected("secret_not_configured");
  const presented =
    request.headers.get("x-vapi-secret") ?? request.headers.get("x-vapi-webhook-secret") ?? "";
  if (!presented) return rejected("secret_not_presented");
  if (!timingSafeEqualStr(presented, secret)) return rejected("secret_mismatch");

  let payload: Rec;
  try {
    payload = asRecord(await request.json());
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const message = asRecord(payload.message);
  const type: string = message.type ?? "";

  try {
    switch (type) {
      case "status-update":
        return json(await applyStatusUpdate(message));

      case "end-of-call-report": {
        const call = asRecord(message.call);
        const vapiCallId: string | null = call.id ?? message.callId ?? null;
        const { error } = await supabaseAdmin.from("voice_call_events").insert({
          vapi_call_id: vapiCallId,
          event_type: "end-of-call-report",
          payload: payload as Json,
        });
        if (error) {
          console.error("[voice-webhook] event queue insert failed:", error.message);
          return json({ ok: false, error: "queue_failed" }, 500);
        }
        // Mark ended right away so the live monitor drops the call now, not on
        // the next drain tick.
        if (vapiCallId) {
          const { error: endError } = await supabaseAdmin
            .from("voice_calls")
            .update({ call_status: "ended", ended_at: message.endedAt ?? new Date().toISOString() })
            .eq("vapi_call_id", vapiCallId)
            .neq("call_status", "ended");
          if (endError) console.error("[voice-webhook] end mark failed:", endError.message);
        }
        return json({ ok: true, queued: true });
      }

      case "tool-calls":
        return json(await handleToolCalls(message));

      case "assistant-request":
      case "transfer-destination-request": {
        const destination = await routeHandoff(message);
        if (!destination) {
          return json({ error: "no_handoff_destination_configured" });
        }
        return json(destination);
      }

      default:
        return json({ ok: true, ignored: type || "unknown" });
    }
  } catch (err) {
    console.error(`[voice-webhook] ${type} handling failed:`, (err as Error).message);
    return json({ ok: false, error: "webhook_failed" }, 500);
  }
}

const LIVE_STATUSES = new Set(["queued", "ringing", "in-progress", "forwarding"]);

async function applyStatusUpdate(message: Rec): Promise<Rec> {
  const call = asRecord(message.call);
  const vapiCallId: string | null = call.id ?? message.callId ?? null;
  if (!vapiCallId) return { ok: true, ignored: "no_call_id" };

  const status: string = message.status ?? call.status ?? "";
  const normalized = LIVE_STATUSES.has(status) ? status : status === "ended" ? "ended" : null;
  if (!normalized) return { ok: true, ignored: `status_${status}` };

  const phone: string | null =
    asRecord(message.customer).number ?? asRecord(call.customer).number ?? null;
  const callType: string = call.type ?? "";
  const direction = callType === "outboundPhoneCall" ? "outbound" : "inbound";

  const { error } = await supabaseAdmin.from("voice_calls").upsert(
    {
      vapi_call_id: vapiCallId,
      call_status: normalized,
      call_direction: direction,
      phone_number: phone,
      agent_id: call.assistantId ?? asRecord(message.assistant).id ?? null,
      squad_id: call.squadId ?? null,
      is_squad_call: Boolean(call.squadId) || direction === "inbound",
      started_at: message.startedAt ?? call.startedAt ?? null,
    },
    { onConflict: "vapi_call_id" },
  );
  if (error) {
    console.error("[voice-webhook] status upsert failed:", error.message);
    return { ok: false, error: "status_upsert_failed" };
  }

  let blacklist: string | undefined;
  if (normalized === "in-progress" && direction === "inbound" && phone) {
    blacklist = await enforceBlacklist(vapiCallId, phone);
  }
  return { ok: true, status: normalized, blacklist };
}
