// Operator view of whether scheduled jobs are actually reaching the app.
// A green pg_cron run only proves the SQL succeeded; delivery is the HTTP
// response, which is what this card reports.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CircleCheck, CircleX, Clock, Loader2, RefreshCw, Timer } from "lucide-react";
import { formatDistanceToNow } from "@/lib/format";
import {
  fetchCronDeliveryHealth,
  type CronDeliveryHealth,
  type CronDeliveryRow,
} from "@/lib/cron-health.functions";

function DeliveryPill({ row }: { row: CronDeliveryRow }) {
  if (row.delivered === true) {
    return (
      <Badge variant="secondary" className="gap-1">
        <CircleCheck className="h-3 w-3 text-emerald-500" />
        {row.last_http_status ?? 200}
      </Badge>
    );
  }
  if (row.delivered === false) {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleX className="h-3 w-3" />
        {row.last_http_status ?? "no response"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Clock className="h-3 w-3" />
      unknown
    </Badge>
  );
}

export function CronDeliveryHealthCard() {
  const fetchFn = useServerFn(fetchCronDeliveryHealth);
  const [data, setData] = useState<CronDeliveryHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchFn({ data: { sinceHours: 24 } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load cron delivery health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = data?.rows ?? [];
  const sorted = [...rows].sort((a, b) => {
    const rank = (r: CronDeliveryRow) => (r.delivered === false ? 0 : r.delivered == null ? 1 : 2);
    return rank(a) - rank(b) || a.jobname.localeCompare(b.jobname);
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Timer className="h-4 w-4" />
            Cron delivery
          </CardTitle>
          <CardDescription>
            Whether each scheduled job&apos;s HTTP call actually came back — last 24 hours.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">{data?.delivered ?? 0} delivered</Badge>
              <Badge variant={data?.failing ? "destructive" : "outline"}>
                {data?.failing ?? 0} failing
              </Badge>
              <Badge variant="outline">{data?.unknown ?? 0} unknown</Badge>
            </div>
            <div className="divide-y rounded-md border">
              {sorted.length === 0 && !loading ? (
                <p className="p-3 text-sm text-muted-foreground">No scheduled jobs found.</p>
              ) : (
                sorted.map((r) => (
                  <div
                    key={r.jobname}
                    className="flex flex-wrap items-center justify-between gap-2 p-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.jobname}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {r.schedule}
                        {r.last_run_at
                          ? ` · ran ${formatDistanceToNow(new Date(r.last_run_at))}`
                          : " · never ran in window"}
                        {r.runs ? ` · ${r.runs} runs` : ""}
                        {r.last_http_error ? ` · ${r.last_http_error}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!r.active && <Badge variant="outline">paused</Badge>}
                      <DeliveryPill row={r} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
