// POST /api/public/telephony/incoming — the purchased number's Voice URL:
// Twilio calls it when a client dials in. Rings every freshly-registered
// operator browser; with nobody registered, apologises, hangs up, and the
// missed call is notified. Auth: X-Twilio-Signature, fails closed; 503 until
// Twilio env secrets exist.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/telephony/incoming")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { readTwilioRequest, buildInboundTwiml, twimlResponse, ledgerInboundStart, freshRingableIdentities } =
            await import("@/server/telephony.server");
          const auth = await readTwilioRequest(request, "/api/public/telephony/incoming");
          if (!auth.ok) return auth.response;
          await ledgerInboundStart(auth.params);
          const identities = await freshRingableIdentities();
          return twimlResponse(buildInboundTwiml(identities));
        } catch (err) {
          console.error("telephony incoming webhook failed:", (err as Error).message);
          return new Response(JSON.stringify({ ok: false, error: "webhook_failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
