import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getFleetMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const [clones, cascades, drift, ai, push, health] = await Promise.all([
      supabase.from("clones").select("id, sync_status, commits_behind, cloudflare_enabled"),
      supabase
        .from("cascade_events")
        .select("id, status, mode, created_at")
        .gte("created_at", since30),
      supabase
        .from("module_drift_alerts")
        .select("id, severity, created_at")
        .gte("created_at", since30),
      supabase
        .from("ai_usage_log")
        .select("feature, total_tokens, created_at")
        .gte("created_at", since30),
      supabase.from("push_delivery_log").select("success, created_at").gte("created_at", since30),
      supabase
        .from("clone_health_snapshots")
        .select("clone_id, payload, probed_at")
        .gte("probed_at", since30)
        .order("probed_at", { ascending: false })
        .limit(500),
    ]);

    const cs = cascades.data ?? [];
    const total = cs.length;
    const succeeded = cs.filter((c: any) => c.status === "succeeded").length;
    const failed = cs.filter((c: any) => c.status === "failed").length;

    const byDay = (rows: any[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) {
        const d = (r.created_at ?? r.probed_at ?? "").slice(0, 10);
        if (!d) continue;
        m[d] = (m[d] ?? 0) + 1;
      }
      return Object.entries(m)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));
    };

    const tokens = (ai.data ?? []).reduce((s: number, r: any) => s + (r.total_tokens ?? 0), 0);
    const pushTotal = push.data?.length ?? 0;
    const pushOk = (push.data ?? []).filter((p: any) => p.success).length;

    return {
      summary: {
        clones_total: clones.data?.length ?? 0,
        clones_drifted: (clones.data ?? []).filter((c: any) => (c.commits_behind ?? 0) > 0).length,
        clones_cf: (clones.data ?? []).filter((c: any) => c.cloudflare_enabled).length,
        cascades_30d: total,
        cascade_success_rate: total ? succeeded / total : 0,
        cascades_failed: failed,
        drift_alerts_30d: drift.data?.length ?? 0,
        ai_tokens_30d: tokens,
        push_success_rate: pushTotal ? pushOk / pushTotal : null,
        push_total_30d: pushTotal,
      },
      cascades_by_day: byDay(cs),
      drift_by_day: byDay(drift.data ?? []),
      ai_by_day: byDay(ai.data ?? []),
    };
  });

export const getCloneHealthHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneId: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("clone_health_snapshots")
      .select("payload, probed_at")
      .eq("clone_id", data.cloneId)
      .order("probed_at", { ascending: false })
      .limit(60);
    return { history: rows ?? [] };
  });
