import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked (every minute, `voice-outbound-dispatch-1min`): claims due
// voice_outbound_jobs and places the calls with VAPI, honouring expiry,
// per-rule retry policy and a last-moment blacklist re-check.
// Auth: requires Bearer CRON_SECRET.
export const Route = createFileRoute("/hooks/voice-outbound-dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { dispatchDueOutboundJobs } = await import("@/server/voice.server");
          const result = await dispatchDueOutboundJobs();
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
