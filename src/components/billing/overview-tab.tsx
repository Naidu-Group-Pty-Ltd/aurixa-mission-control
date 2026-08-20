import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTokenUsageSummary } from "@/lib/tokens.functions";
import { fmt } from "./utils";

export function OverviewTab() {
  const fn = useServerFn(getTokenUsageSummary);
  const { data, isLoading } = useQuery({ queryKey: ["token-usage-summary"], queryFn: () => fn() });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data) return null;
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Stat label="Tenants" value={fmt(data.totalTenants)} />
      <Stat label="Available (fleet)" value={fmt(data.totalAvailable)} />
      <Stat label="Spent 30d" value={fmt(data.totalSpent30d)} />
      <Stat label="Jobs 30d" value={fmt(data.jobCount30d)} />
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm">Top report kinds (30d)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.topKinds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No jobs yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.topKinds.map((k) => (
                <li key={k.kind} className="flex justify-between">
                  <span className="font-mono">{k.kind}</span>
                  <span>{fmt(k.tokens)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm">Daily spend (30d)</CardTitle>
        </CardHeader>
        <CardContent>
          <Sparkline series={data.series.map((s) => s.tokens)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function Sparkline({ series }: { series: number[] }) {
  if (series.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  const max = Math.max(1, ...series);
  return (
    <div className="flex h-16 items-end gap-[2px]">
      {series.map((v, i) => (
        <div key={i} className="flex-1 bg-primary/70" style={{ height: `${(v / max) * 100}%` }} />
      ))}
    </div>
  );
}

// ─── Tenants ─────────────────────────────────────────────────────────────────
