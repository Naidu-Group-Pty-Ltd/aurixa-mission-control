// Call analytics — distributions over the filtered window, drawn as divided
// planes and hairline bars rather than a charting library.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { exportCalls } from "@/lib/voice.functions";
import { formatDuration, getOutcomeCategory, outcomeLabel } from "@/lib/voice-vocab";

type Row = {
  agent_name: string | null;
  call_direction: string | null;
  call_outcome: string | null;
  sentiment: string | null;
  duration_seconds: number | null;
  cost: number | null;
  squad_name: string | null;
  call_intent: string | null;
  started_at: string | null;
};

function DistBar({
  label,
  count,
  total,
  detail,
}: {
  label: string;
  count: number;
  total: number;
  detail?: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate">{label}</span>
        <span className="numeral shrink-0 text-xs text-muted-foreground">
          {count} · {pct}%{detail ? ` · ${detail}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full bg-muted">
        <div className="h-full bg-chart-1" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AnalyticsPanel({ squadOnly }: { squadOnly?: boolean }) {
  const q = useQuery({
    queryKey: ["voice", "analytics", squadOnly ?? false],
    queryFn: () => exportCalls({ data: squadOnly ? { squad: "squad" } : {} }),
  });
  const rows = (q.data ?? []) as Row[];

  const model = useMemo(() => {
    const byOutcome = new Map<string, number>();
    const byAgent = new Map<string, { count: number; duration: number; cost: number }>();
    const byIntent = new Map<string, number>();
    const bySentiment = new Map<string, number>();
    const bySquad = new Map<string, number>();
    let totalCost = 0;
    let totalDuration = 0;
    for (const r of rows) {
      byOutcome.set(
        getOutcomeCategory(r.call_outcome),
        (byOutcome.get(getOutcomeCategory(r.call_outcome)) ?? 0) + 1,
      );
      const agent = r.agent_name ?? "Unknown agent";
      const a = byAgent.get(agent) ?? { count: 0, duration: 0, cost: 0 };
      a.count += 1;
      a.duration += r.duration_seconds ?? 0;
      a.cost += Number(r.cost ?? 0);
      byAgent.set(agent, a);
      if (r.call_intent) byIntent.set(r.call_intent, (byIntent.get(r.call_intent) ?? 0) + 1);
      if (r.sentiment) bySentiment.set(r.sentiment, (bySentiment.get(r.sentiment) ?? 0) + 1);
      if (r.squad_name) bySquad.set(r.squad_name, (bySquad.get(r.squad_name) ?? 0) + 1);
      totalCost += Number(r.cost ?? 0);
      totalDuration += r.duration_seconds ?? 0;
    }
    const sorted = <K,>(m: Map<K, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]);
    return {
      total: rows.length,
      totalCost,
      avgDuration: rows.length > 0 ? totalDuration / rows.length : 0,
      byOutcome: sorted(byOutcome),
      byIntent: sorted(byIntent),
      bySentiment: sorted(bySentiment),
      bySquad: sorted(bySquad),
      byAgent: [...byAgent.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 8),
    };
  }, [rows]);

  if (!q.isLoading && model.total === 0) {
    return <p className="text-sm text-muted-foreground">No calls in the current window.</p>;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="glass space-y-3 p-5">
        <p className="label-mono text-muted-foreground">outcomes</p>
        {model.byOutcome.map(([k, v]) => (
          <DistBar key={k} label={outcomeLabel(k)} count={v} total={model.total} />
        ))}
      </div>

      <div className="glass space-y-3 p-5">
        <p className="label-mono text-muted-foreground">agents</p>
        {model.byAgent.map(([agent, a]) => (
          <DistBar
            key={agent}
            label={agent}
            count={a.count}
            total={model.total}
            detail={`${formatDuration(Math.round(a.duration / Math.max(1, a.count)))} avg · $${a.cost.toFixed(2)}`}
          />
        ))}
      </div>

      <div className="glass space-y-3 p-5">
        <p className="label-mono text-muted-foreground">intents</p>
        {model.byIntent.length === 0 && (
          <p className="text-sm text-muted-foreground">No intents detected yet.</p>
        )}
        {model.byIntent.map(([k, v]) => (
          <DistBar key={k} label={k.replace(/_/g, " ")} count={v} total={model.total} />
        ))}
      </div>

      <div className="glass space-y-3 p-5">
        <p className="label-mono text-muted-foreground">{squadOnly ? "squads" : "sentiment"}</p>
        {(squadOnly ? model.bySquad : model.bySentiment).map(([k, v]) => (
          <DistBar key={k} label={k} count={v} total={model.total} />
        ))}
        {(squadOnly ? model.bySquad : model.bySentiment).length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        )}
      </div>
    </div>
  );
}
