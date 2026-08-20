import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fireTokenWebhook, retryDueDeliveries } from "@/server/token-webhooks.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// How many active tenants one run alerts on. Reported back as `truncated`
// when the batch comes back full.
const TENANT_BATCH = 500;

// Cron-invoked. Scans tenants for allowance thresholds and cancel-rate spikes,
// fans notifications, fires webhooks, and retries failed webhook deliveries.
// Auth: requires Bearer DRIFT_REFRESH_TOKEN.
export const Route = createFileRoute("/hooks/token-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        const out = {
          tenants_checked: 0,
          // True when the batch came back full — past that, some active tenants
          // were not looked at this run.
          truncated: false,
          allowance_alerts: 0,
          cancel_spike_alerts: 0,
          webhook_retries: 0,
        };

        const { data: tenants } = await supabaseAdmin
          .from("tenants")
          .select("id, clone_id, external_ref, display_name, status")
          .eq("status", "active")
          // Oldest first. Unordered, the cap silently picks an arbitrary 500
          // active tenants — so past that count some tenants would simply never
          // be alerted, and which ones would change run to run.
          .order("created_at", { ascending: true })
          .limit(TENANT_BATCH);

        out.truncated = (tenants ?? []).length >= TENANT_BATCH;

        for (const t of tenants ?? []) {
          out.tenants_checked += 1;
          const summary = await supabaseAdmin.rpc("tenant_usage_summary", { _tenant_id: t.id });
          const s = (summary.data ?? {}) as Record<string, number | null>;

          const pct = Number(s.allowance_used_pct ?? 0);
          for (const threshold of [80, 100]) {
            if (pct >= threshold) {
              const dedupeKey = `allowance_${threshold}_${t.id}_${new Date().toISOString().slice(0, 10)}`;
              const existing = await supabaseAdmin
                .from("notifications")
                .select("id")
                .eq("kind", "tokens_alert")
                .contains("metadata", { dedupe_key: dedupeKey })
                .maybeSingle();
              if (!existing.data) {
                await supabaseAdmin.from("notifications").insert({
                  kind: "tokens_alert",
                  severity: threshold >= 100 ? "error" : "warning",
                  title: `${t.display_name ?? t.external_ref} crossed ${threshold}% allowance`,
                  body: `Used ${Math.round(pct)}% of monthly allowance.`,
                  clone_id: t.clone_id,
                  url: "/settings/billing",
                  metadata: { dedupe_key: dedupeKey, tenant_id: t.id, pct },
                });
                await fireTokenWebhook(
                  "tokens.alert",
                  {
                    alert: "allowance_threshold",
                    threshold,
                    pct,
                    tenant_ref: t.external_ref,
                    summary: s,
                  },
                  t.clone_id,
                );
                out.allowance_alerts += 1;
              }
            }
          }

          const cancelRate = Number(s.cancel_rate_24h ?? 0);
          const total24 = Number(s.cancels_24h ?? 0) + Number(s.completed_24h ?? 0);
          if (cancelRate >= 0.3 && total24 >= 5) {
            const dedupeKey = `cancel_spike_${t.id}_${new Date().toISOString().slice(0, 10)}`;
            const existing = await supabaseAdmin
              .from("notifications")
              .select("id")
              .eq("kind", "tokens_alert")
              .contains("metadata", { dedupe_key: dedupeKey })
              .maybeSingle();
            if (!existing.data) {
              await supabaseAdmin.from("notifications").insert({
                kind: "tokens_alert",
                severity: "warning",
                title: `Cancel spike on ${t.display_name ?? t.external_ref}`,
                body: `${Math.round(cancelRate * 100)}% of last-24h jobs canceled/failed.`,
                clone_id: t.clone_id,
                url: "/report-jobs",
                metadata: { dedupe_key: dedupeKey, tenant_id: t.id, cancel_rate: cancelRate },
              });
              await fireTokenWebhook(
                "tokens.alert",
                {
                  alert: "cancel_spike",
                  cancel_rate: cancelRate,
                  tenant_ref: t.external_ref,
                  summary: s,
                },
                t.clone_id,
              );
              out.cancel_spike_alerts += 1;
            }
          }
        }

        const retried = await retryDueDeliveries();
        out.webhook_retries = retried.retried;

        return new Response(JSON.stringify({ success: true, ...out }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
