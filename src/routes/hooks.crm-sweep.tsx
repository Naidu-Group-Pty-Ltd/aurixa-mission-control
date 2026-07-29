import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked CRM sweep: raises SLA-breach notifications, opens renewal
// tasks inside each contract's notice window, recomputes account health
// scores, and flags exports whose retention clock has expired.
// Auth: requires Bearer DRIFT_REFRESH_TOKEN.
export const Route = createFileRoute("/hooks/crm-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        const { data: sweep, error } = await supabaseAdmin.rpc("crm_sweep");
        if (error) {
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Data-retention clock: flag offboarding runs whose destruction window
        // has passed so an operator can approve the purge (never automatic).
        const { data: due } = await supabaseAdmin
          .from("crm_offboarding_runs")
          .select("id, account_id, destroy_after")
          .is("destroyed_at", null)
          .lt("destroy_after", new Date().toISOString())
          .limit(50);

        let retentionAlerts = 0;
        for (const run of due ?? []) {
          const dedupe = `crm_retention_${run.id}`;
          const { data: existing } = await supabaseAdmin
            .from("notifications")
            .select("id")
            .eq("kind", "crm_retention_due")
            .contains("metadata", { dedupe_key: dedupe })
            .maybeSingle();
          if (existing) continue;
          await supabaseAdmin.from("notifications").insert({
            kind: "crm_retention_due",
            severity: "warning",
            title: "Client data retention window expired",
            body: "Approve destruction of the exported data pack for this offboarded client.",
            url: `/crm/accounts/${run.account_id}`,
            metadata: { dedupe_key: dedupe, offboarding_run_id: run.id },
          });
          retentionAlerts += 1;
        }

        return new Response(
          JSON.stringify({ success: true, ...(sweep as object), retention_alerts: retentionAlerts }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
