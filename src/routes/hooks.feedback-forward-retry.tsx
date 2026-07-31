import { createFileRoute } from "@tanstack/react-router";
import { retryPendingForwards } from "@/server/feedback.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked. pg_cron POSTs here every ten minutes.
// Auth: Bearer CRON_SECRET (or DRIFT_REFRESH_TOKEN), same as every other hook.
//
// Drains the backlog of feedback submissions that have not reached Make.com.
// Without it, a submission whose delivery failed stayed failed forever: the
// answer and the credits were safe in Postgres, but the row never appeared in
// Airtable and the only evidence was a number on an operator screen.
export const Route = createFileRoute("/hooks/feedback-forward-retry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const result = await retryPendingForwards(25);
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "feedback retry failed";
          console.error("[feedback-forward-retry]", msg);
          // 500 rather than a quiet 200: a sweep that cannot run is exactly the
          // condition this endpoint exists to prevent going unnoticed, and
          // pg_cron records the response.
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
