// Entitlement worker — reconciles a clone's installed modules against its
// billing plan after a tier change on the Aurixa Systems pricing page.
//
// This runs on a cron drain rather than inline with the plan-change webhook
// for the usual reason: installing modules touches the module catalogue and
// the clone's install set, which is far slower than Stripe's delivery timeout.
// A webhook that times out gets retried, and a retried plan change that
// installs modules synchronously would do the work twice.
//
// Idempotency is not a property of this drainer — it belongs to
// `drainPlanChangeReconciliations`, which claims work by
// `plan_change_events.modules_reconciled_at IS NULL` and stamps that column
// inside the same reconciliation. A duplicate webhook, a retry, or two
// overlapping cron ticks all converge on the same diff.
//
// Failures are deliberately NOT marked reconciled: a clone whose plan moved
// but whose modules could not be installed stays in the queue and is retried
// on the next tick, because silently dropping it would leave a paying customer
// without the features they bought.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { drainPlanChangeReconciliations } from "@/server/entitlement-modules.server";

const MAX_EVENTS_PER_RUN = 25;

export const Route = createFileRoute("/hooks/entitlement-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const res = await drainPlanChangeReconciliations({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            supabase: supabaseAdmin as any,
            limit: MAX_EVENTS_PER_RUN,
          });

          const failed = res.results.filter((r) => !r.ok);
          const installed = res.results.reduce((n, r) => n + r.installed.length, 0);
          const revoked = res.results.reduce((n, r) => n + r.revoked.length, 0);

          return new Response(
            JSON.stringify({
              success: true,
              processed: res.processed,
              installed,
              revoked,
              failed: failed.length,
              errors: failed.slice(0, 5).map((f) => ({ cloneId: f.cloneId, error: f.error })),
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drain_failed";
          console.error("entitlement-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
