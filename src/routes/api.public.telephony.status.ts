// POST /api/public/telephony/status — Twilio call lifecycle callbacks (and
// the inbound <Dial> action result, distinguished by ?leg=inbound-result).
// Folds every event into the phone_calls ledger; a completed call writes the
// CRM activity, an unanswered inbound one raises the missed-call
// notification. Auth: X-Twilio-Signature, fails closed; 503 until Twilio env
// secrets exist. The inbound-result leg must answer TwiML (Twilio continues
// the parent call with it); plain callbacks get 204.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/telephony/status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { readTwilioRequest, ingestStatusCallback, twimlResponse } =
            await import("@/server/telephony.server");
          const auth = await readTwilioRequest(request, "/api/public/telephony/status");
          if (!auth.ok) return auth.response;
          const leg = new URL(request.url).searchParams.get("leg");
          await ingestStatusCallback(auth.params, leg);
          if (leg === "inbound-result") return twimlResponse("");
          return new Response(null, { status: 204 });
        } catch (err) {
          console.error("telephony status webhook failed:", (err as Error).message);
          return new Response(JSON.stringify({ ok: false, error: "webhook_failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
