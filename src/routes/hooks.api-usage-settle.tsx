import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { sweepApiUsageSettlement } from "@/server/api-usage-settlement.server";

/**
 * Cron-invoked settlement for piggybacked API usage.
 *
 * Closes every billing period that has ended and pushes what it owes onto the
 * tenant's next Stripe invoice. Daily is enough — a period only becomes
 * closeable when it ends, so a missed run costs latency, never revenue, and the
 * whole sweep is idempotent on re-entry.
 *
 * Auth: Bearer DRIFT_REFRESH_TOKEN, same as the other cron hooks.
 */
export const Route = createFileRoute("/hooks/api-usage-settle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const result = await sweepApiUsageSettlement();

          await supabaseAdmin.from("audit_log").insert({
            action: "api_usage_settle_cron",
            entity_type: "cron",
            metadata: result as never,
          });

          // A tenant we metered but cannot bill is money already spent with our
          // vendors and no way to recover it — that needs a person, not a log line.
          if (result.failed > 0) {
            await supabaseAdmin.from("notifications").insert({
              kind: "api_usage_settlement_failed",
              severity: "warning",
              title: `API usage settlement: ${result.failed} charge(s) could not be billed`,
              body: result.errors
                .slice(0, 5)
                .map((e) => `${e.tenant_id} ${e.period_start}: ${e.error}`)
                .join("\n"),
              url: "/billing/api-usage",
              metadata: { errors: result.errors.slice(0, 20) } as never,
            });
          }

          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "settlement failed";
          console.error("api-usage-settle cron failed:", msg);
          await supabaseAdmin.from("audit_log").insert({
            action: "api_usage_settle_cron",
            entity_type: "cron",
            metadata: { error: msg },
          });
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
