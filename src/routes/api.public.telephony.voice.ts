// POST /api/public/telephony/voice — the TwiML App's Voice URL: Twilio calls
// it when an operator's browser places an outgoing call. Answers TwiML that
// bridges the dialled number with the purchased caller id, and ledgers the
// call. Auth: X-Twilio-Signature, fails closed; 503 until Twilio env secrets
// exist.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/telephony/voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { readTwilioRequest, telephonyConfig, buildOutboundTwiml, twimlResponse, ledgerOutboundStart } =
            await import("@/server/telephony.server");
          const auth = await readTwilioRequest(request, "/api/public/telephony/voice");
          if (!auth.ok) return auth.response;
          const to = auth.params.To ?? "";
          if (!to || to.startsWith("client:")) {
            return twimlResponse(`<Say voice="alice" language="en-AU">That destination is not callable.</Say>`);
          }
          await ledgerOutboundStart(auth.params);
          return twimlResponse(buildOutboundTwiml(telephonyConfig(), to));
        } catch (err) {
          console.error("telephony voice webhook failed:", (err as Error).message);
          return new Response(JSON.stringify({ ok: false, error: "webhook_failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
