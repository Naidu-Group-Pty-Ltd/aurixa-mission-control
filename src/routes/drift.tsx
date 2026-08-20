import { createFileRoute, Link } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { applyDriftSuggestion, dismissDriftSuggestion } from "@/server/drift-suggestions.functions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DriftListSkeleton } from "@/components/list-skeletons";
import { RecordRow } from "@/components/record-row";
import { useUrlState } from "@/lib/use-url-state";
import { useOptimisticMutation } from "@/lib/use-optimistic-mutation";

export const Route = createFileRoute("/drift")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <DriftDashboard />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Fleet drift — Aurixa Systems Mission Control" }] }),
});

type Suggestion = {
  id: string;
  status: "open" | "applied" | "dismissed";
  recommended_mode: "pr" | "auto_merge" | "notify";
  summary: string;
  files: string[];
  risk: "low" | "medium" | "high";
  category: string;
  rationale: string;
  created_at: string;
  applied_event_id?: string | null;
};

type Row = {
  cloneId: string;
  cloneName: string;
  suggestion: Suggestion;
};

const DRIFT_KEY = ["drift-suggestions"] as const;

function DriftDashboard() {
  const apply = useServerFn(applyDriftSuggestion);
  const dismiss = useServerFn(dismissDriftSuggestion);
  // Persist the risk filter in the URL so it survives reload and is shareable.
  const [filter, setFilter] = useUrlState<"all" | "low" | "medium" | "high">("risk", "all");

  const query = useQuery({
    queryKey: DRIFT_KEY,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await supabase.from("clones").select("id, name, drift_suggestions");
      if (error) throw error;
      const out: Row[] = [];
      for (const c of data ?? []) {
        const sugs = (c.drift_suggestions as unknown as Suggestion[] | null) ?? [];
        for (const s of sugs) {
          if (s.status === "open") out.push({ cloneId: c.id, cloneName: c.name, suggestion: s });
        }
      }
      out.sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 } as const;
        return rank[a.suggestion.risk] - rank[b.suggestion.risk];
      });
      return out;
    },
  });

  const rows = query.data ?? [];
  const loading = query.isPending;
  const refresh = () => query.refetch();

  const filtered = filter === "all" ? rows : rows.filter((r) => r.suggestion.risk === filter);

  // Optimistic: drop the row from the list immediately, roll back + toast on
  // failure, and reconcile against the server on settle (invalidateOnSettled).
  const dropRow = (old: Row[], r: Row) =>
    old.filter((row) => !(row.cloneId === r.cloneId && row.suggestion.id === r.suggestion.id));

  const applyMut = useOptimisticMutation<{ cascade_event_id: string }, Row, Row[]>({
    mutationFn: async (r) => {
      const res = await apply({ data: { cloneId: r.cloneId, suggestionId: r.suggestion.id } });
      if (!res.ok) throw new Error(res.error);
      return res;
    },
    queryKey: DRIFT_KEY,
    applyOptimistic: dropRow,
    successMessage: (res) => `Applied · cascade ${res.cascade_event_id.slice(0, 8)}`,
  });

  const dismissMut = useOptimisticMutation<unknown, Row, Row[]>({
    mutationFn: (r) => dismiss({ data: { cloneId: r.cloneId, suggestionId: r.suggestion.id } }),
    queryKey: DRIFT_KEY,
    applyOptimistic: dropRow,
  });

  const busy = applyMut.isPending || dismissMut.isPending;
  const onApply = (r: Row) => applyMut.mutate(r);
  const onDismiss = (r: Row) => dismissMut.mutate(r);

  const groups: Record<string, Row[]> = {};
  for (const r of filtered) (groups[r.suggestion.category] ??= []).push(r);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet-wide"
        title="Drift dashboard"
        description="All open AI suggestions across the fleet, grouped by category."
        actions={
          <Button
            variant="outline"
            size="sm"
            aria-label="Refresh drift suggestions"
            onClick={() => void refresh()}
            disabled={query.isFetching}
          >
            <RefreshCw className={cn("mr-1.5 h-4 w-4", query.isFetching && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "high", "medium", "low"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
          >
            {f === "all"
              ? `All (${rows.length})`
              : `${f} (${rows.filter((r) => r.suggestion.risk === f).length})`}
          </Button>
        ))}
      </div>

      {loading ? (
        <DriftListSkeleton count={4} />
      ) : query.error ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Couldn't load drift suggestions"
          description={
            query.error instanceof Error
              ? query.error.message
              : "Something went wrong fetching fleet drift."
          }
          action={
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title={rows.length === 0 ? "No open suggestions" : "No suggestions match this filter"}
          description={
            rows.length === 0
              ? "Run drift analysis on individual clones to populate this dashboard."
              : "Try switching the risk filter to see more suggestions."
          }
        />
      ) : (
        Object.entries(groups).map(([cat, items]) => (
          <RecordRow key={cat}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge variant="outline" className="font-mono uppercase">
                  {cat}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">{items.length} open</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {items.map((r) => (
                <div
                  key={`${r.cloneId}:${r.suggestion.id}`}
                  className="flex flex-col gap-2 border border-border bg-surface p-3 md:flex-row md:items-start md:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <RiskIcon risk={r.suggestion.risk} />
                      <span className="text-sm font-medium">{r.suggestion.summary}</span>
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] uppercase", riskTone(r.suggestion.risk))}
                      >
                        {r.suggestion.risk}
                      </Badge>
                      <Link
                        to="/clones/$cloneId"
                        params={{ cloneId: r.cloneId }}
                        className="font-mono text-[11px] text-muted-foreground hover:text-primary"
                      >
                        {r.cloneName} <ExternalLink className="inline h-3 w-3" />
                      </Link>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {r.suggestion.files.slice(0, 3).join(" · ")}
                      {r.suggestion.files.length > 3 && ` · +${r.suggestion.files.length - 3}`}
                      {" · "}
                      {formatDistanceToNow(r.suggestion.created_at)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" disabled={busy} onClick={() => onApply(r)}>
                      Apply
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(r)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </RecordRow>
        ))
      )}
    </div>
  );
}

function RiskIcon({ risk }: { risk: "low" | "medium" | "high" }) {
  if (risk === "low") return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
  return (
    <AlertTriangle
      className={cn("h-4 w-4 shrink-0", risk === "high" ? "text-destructive" : "text-warning")}
    />
  );
}

function riskTone(r: "low" | "medium" | "high") {
  if (r === "high") return "border-destructive/40 text-destructive";
  if (r === "medium") return "border-warning/40 text-warning";
  return "border-success/40 text-success";
}
