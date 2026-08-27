import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reconcileAllowedOrigins } from "@/server/cloneAllowedOrigins.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 15 min.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Keeps every clone's ALLOWED_ORIGINS equal to its own origins. Provisioning
// derives it and the deployment drain completes it; this is what covers the
// rest of a clone's life — a custom domain attached later, a re-allocated
// subdomain, a changed platform domain — and what makes clones provisioned
// before any of it existed set themselves without anybody pressing a button.
//
// It can only ever write to a clone: the project ref comes from
// `resolveCloneSecretTarget`, which refuses the prime's project and Mission
// Control's own. See `cloneSecretTarget.pure.ts`.
export const Route = createFileRoute("/hooks/allowed-origins-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const result = await reconcileAllowedOrigins(supabaseAdmin);
          // Deliberately 200 with the refusals in the body rather than 500:
          // one misconfigured clone is not a failed run, and a job that reports
          // failure for a state it correctly refused is one people stop reading.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "ALLOWED_ORIGINS reconcile failed";
          console.error("ALLOWED_ORIGINS reconcile failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
