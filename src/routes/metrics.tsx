import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricCell } from "@/components/metric-bar";
import { BarChart3, Activity, Sparkles, Bell, Bot } from "lucide-react";
import { getFleetMetrics } from "@/server/metrics.functions";
import { purchaseRollups } from "@/lib/purchases.functions";
import { formatMoneyByCurrency } from "@/lib/purchase-rollups";

const CascadesByDayChart = lazy(() =>
  import("@/components/charts/metrics-charts").then((m) => ({ default: m.CascadesByDayChart })),
);
const DriftByDayChart = lazy(() =>
  import("@/components/charts/metrics-charts").then((m) => ({ default: m.DriftByDayChart })),
);
const AiByDayChart = lazy(() =>
  import("@/components/charts/metrics-charts").then((m) => ({ default: m.AiByDayChart })),
);

function ChartFallback() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      Loading chart…
    </div>
  );
}

export const Route = createFileRoute("/metrics")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <MetricsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Metrics — Aurixa Systems Mission Control" }] }),
});

function MetricsPage() {
  const fn = useServerFn(getFleetMetrics);
  const q = useQuery({ queryKey: ["fleet-metrics"], queryFn: () => fn(), refetchInterval: 60_000 });
  const m = q.data?.summary;

  // Purchase attribution rollups (user-attributed pricing workflow, Phase 4).
  const rollupsFn = useServerFn(purchaseRollups);
  const rollupsQ = useQuery({
    queryKey: ["purchase-rollups", 30],
    queryFn: () => rollupsFn({ data: { days: 30 } }),
    refetchInterval: 60_000,
  });
  const rollups = rollupsQ.data?.ok ? rollupsQ.data : null;
  const topClone = rollups?.byClone?.[0] ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
          <BarChart3 className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="label-mono">observability</p>
          <h1 className="font-display text-[2.125rem] leading-[1.05]">Fleet Metrics</h1>
          <p className="text-sm text-muted-foreground">
            30-day rolling snapshot of cascades, drift, AI usage, and push delivery.
          </p>
        </div>
      </header>

      <div className="glass grid overflow-hidden md:grid-cols-4">
        <Stat label="Clones" value={m?.clones_total ?? 0} />
        <Stat label="Drifted" value={m?.clones_drifted ?? 0} accent="warning" />
        <Stat label="CF wrapped" value={m?.clones_cf ?? 0} />
        <Stat label="Cascades 30d" value={m?.cascades_30d ?? 0} />
      </div>

      <div className="glass grid overflow-hidden md:grid-cols-4">
        <Stat
          label="Cascade success"
          value={m ? `${Math.round(m.cascade_success_rate * 100)}%` : "—"}
          accent={m && m.cascade_success_rate > 0.9 ? "success" : "warning"}
        />
        <Stat label="Cascades failed" value={m?.cascades_failed ?? 0} accent="warning" />
        <Stat label="Drift alerts" value={m?.drift_alerts_30d ?? 0} />
        <Stat label="AI tokens" value={(m?.ai_tokens_30d ?? 0).toLocaleString()} />
      </div>

      {/* Revenue attribution (user-attributed pricing workflow) */}
      <div className="glass grid overflow-hidden md:grid-cols-4">
        <Stat
          label="Revenue 30d"
          value={rollups ? formatMoneyByCurrency(rollups.revenueByCurrency) : "—"}
          accent="success"
        />
        <Stat label="Purchases 30d" value={rollups?.completedCount ?? "—"} />
        <Stat
          label="Clone-initiated"
          value={rollups ? `${Math.round(rollups.attributedShare * 100)}%` : "—"}
        />
        <Stat
          label="Top clone by spend"
          value={topClone ? (topClone.cloneName ?? (topClone.cloneId ? "unnamed" : "Prime")) : "—"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Cascades / day
          </CardTitle>
          <CardDescription>Activity over the last 30 days</CardDescription>
        </CardHeader>
        <CardContent className="h-64">
          <Suspense fallback={<ChartFallback />}>
            <CascadesByDayChart data={q.data?.cascades_by_day} />
          </Suspense>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Drift alerts / day
            </CardTitle>
          </CardHeader>
          <CardContent className="h-48">
            <Suspense fallback={<ChartFallback />}>
              <DriftByDayChart data={q.data?.drift_by_day} />
            </Suspense>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Bot className="h-4 w-4" />
              AI calls / day
            </CardTitle>
          </CardHeader>
          <CardContent className="h-48">
            <Suspense fallback={<ChartFallback />}>
              <AiByDayChart data={q.data?.ai_by_day} />
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Push delivery
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-6">
          <div>
            <div className="font-mono text-[10px] uppercase text-muted-foreground">
              Success rate (30d)
            </div>
            <div className="text-2xl font-semibold">
              {m?.push_success_rate != null ? `${Math.round(m.push_success_rate * 100)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase text-muted-foreground">
              Total deliveries
            </div>
            <div className="text-2xl font-semibold">
              {(m?.push_total_30d ?? 0).toLocaleString()}
            </div>
          </div>
          {m?.push_total_30d ? (
            <Badge className="bg-success/15 text-success">tracked</Badge>
          ) : (
            <Badge variant="outline">no data</Badge>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "warning" | "success";
}) {
  return (
    <MetricCell
      label={label}
      value={value}
      size={typeof value === "string" ? "sm" : "lg"}
      tone={accent === "warning" ? "warning" : "success"}
      alarm={Boolean(accent)}
    />
  );
}
