// POST /api/public/voice/webhook — the VAPI server URL for every assistant,
// squad and phone number in the fleet.
//
// Auth: `x-vapi-secret` (or `x-vapi-webhook-secret`) shared secret, checked
// constant-time against VAPI_WEBHOOK_SECRET; fails closed and audits every
// refusal. All handling lives in src/server/voice-webhook.server.ts.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/voice/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { ingestVapiWebhook } = await import("@/server/voice-webhook.server");
          return await ingestVapiWebhook(request);
        } catch (err) {
          console.error("voice webhook failed:", (err as Error).message);
          return new Response(JSON.stringify({ ok: false, error: "webhook_failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
