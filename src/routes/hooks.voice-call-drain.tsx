import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked (every minute, `voice-call-drain-1min`): enriches queued
// end-of-call reports — contact matching, transcript analysis, CRM activity,
// alert rules, outbound retry decisions — and closes phantom live calls.
// Auth: requires Bearer CRON_SECRET.
export const Route = createFileRoute("/hooks/voice-call-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { processVoiceCallEvents } = await import("@/server/voice.server");
          const result = await processVoiceCallEvents();
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
