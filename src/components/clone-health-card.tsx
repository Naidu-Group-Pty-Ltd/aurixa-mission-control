import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  CircleCheck,
  CircleX,
  Loader2,
  RefreshCw,
  Sparkles,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { fetchCloneHealth, type CloneHealth } from "@/server/clone-health.functions";

export function CloneHealthCard({ cloneId }: { cloneId: string }) {
  const fetchFn = useServerFn(fetchCloneHealth);
  const [health, setHealth] = useState<CloneHealth | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    try {
      const data = await fetchFn({ data: { cloneId, force } });
      setHealth(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneId]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-info" /> Clone health
          </CardTitle>
          <CardDescription className="mt-1">
            Deploy uptime + last-week activity, summarized by AI.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load(true)} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!health && loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Probing deploy & summarizing…
          </div>
        )}
        {health && (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                icon={<UptimeIcon status={health.uptime.status} />}
                label="Deploy"
                value={
                  health.deployUrl
                    ? health.uptime.status === "up"
                      ? "Up"
                      : health.uptime.status === "down"
                        ? "Down"
                        : "Unknown"
                    : "No URL"
                }
                detail={
                  health.uptime.latencyMs !== null
                    ? `${health.uptime.latencyMs}ms · ${health.uptime.httpStatus ?? "—"}`
                    : "—"
                }
                tone={
                  health.uptime.status === "up"
                    ? "success"
                    : health.uptime.status === "down"
                      ? "destructive"
                      : "muted"
                }
              />
              <Stat
                icon={<Zap className="h-4 w-4" />}
                label="Cascades · 7d"
                value={String(health.cascadeCount7d)}
                detail={health.failureCount7d > 0 ? `${health.failureCount7d} failed` : "all clean"}
                tone={health.failureCount7d > 0 ? "warning" : "success"}
              />
              <Stat
                icon={<CircleCheck className="h-4 w-4" />}
                label="Last success"
                value={
                  health.lastSuccessfulCascadeAt
                    ? formatDistanceToNow(health.lastSuccessfulCascadeAt)
                    : "—"
                }
                detail={
                  health.lastFailedCascadeAt
                    ? `last fail ${formatDistanceToNow(health.lastFailedCascadeAt)}`
                    : "no failures"
                }
                tone="muted"
              />
              <Stat
                icon={<AlertTriangle className="h-4 w-4" />}
                label="Open drift"
                value={String(health.driftSuggestionsOpen)}
                detail={
                  health.driftSuggestionsOpen === 0
                    ? "in sync"
                    : `${health.driftSuggestionsOpen} suggestion${health.driftSuggestionsOpen === 1 ? "" : "s"}`
                }
                tone={health.driftSuggestionsOpen > 0 ? "warning" : "success"}
              />
            </div>
            {health.aiSummary && (
              <div className="border border-accent/30 bg-accent/5 p-3">
                <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-accent">
                  <Sparkles className="h-3 w-3" /> Last 7 days
                </div>
                <p className="text-sm text-foreground">{health.aiSummary}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UptimeIcon({ status }: { status: CloneHealth["uptime"]["status"] }) {
  const cls = "h-4 w-4";
  switch (status) {
    case "up":
      return <CircleCheck className={cn(cls, "text-success")} />;
    case "down":
      return <CircleX className={cn(cls, "text-destructive")} />;
    case "unknown":
      return <Activity className={cn(cls, "text-muted-foreground")} />;
  }
}

function Stat({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "success" | "warning" | "destructive" | "muted";
}) {
  const map = {
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
    muted: "text-muted-foreground",
  };
  return (
    <div className="border bg-surface p-3">
      <div className={cn("mb-1 flex items-center gap-1.5 [&>svg]:h-3.5 [&>svg]:w-3.5", map[tone])}>
        {icon}
        <span className="font-mono text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <div className={cn("font-mono text-lg font-semibold", map[tone])}>{value}</div>
      <div className="font-mono text-[10px] text-muted-foreground">{detail}</div>
      <Badge variant="outline" className="hidden">
        spacer
      </Badge>
    </div>
  );
}
