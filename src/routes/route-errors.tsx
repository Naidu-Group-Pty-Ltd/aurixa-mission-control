import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/copy-button";
import { ListPager } from "@/components/list-pager";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "@/lib/format";
import { AlertTriangle, RefreshCw, Search, Filter, ExternalLink, Download } from "lucide-react";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { exportRowsAsCSV } from "@/lib/csv";

type Row = {
  id: string;
  route_path: string;
  message: string;
  stack: string | null;
  user_agent: string | null;
  user_id: string | null;
  created_at: string;
};

export const Route = createFileRoute("/route-errors")({
  component: () => (
    <ProtectedRoute>
      <RouteErrorsPage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({
    meta: [
      { title: "Route Errors — Aurixa Systems Mission Control" },
      {
        name: "description",
        content:
          "Telemetry of routes that crashed in production, with frequency and most recent stack.",
      },
    ],
  }),
});

const WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
} as const;

type Window = keyof typeof WINDOWS;

function RouteErrorsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [windowKey, setWindowKey] = useUrlState<Window>("window", "7d");
  const [search, setSearch] = useUrlState<string>("q", "");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const load = async () => {
    setLoading(true);
    const sinceMs = WINDOWS[windowKey];
    let query = supabase
      .from("route_errors")
      .select("id, route_path, message, stack, user_agent, user_id, created_at")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (Number.isFinite(sinceMs)) {
      query = query.gte("created_at", new Date(Date.now() - sinceMs).toISOString());
    }
    const { data, error } = await query;
    if (error) toast.error(error.message);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<
      string,
      {
        route_path: string;
        count: number;
        lastAt: string;
        lastMessage: string;
        lastStack: string | null;
        samples: Row[];
      }
    >();
    for (const r of rows) {
      if (q && !r.route_path.toLowerCase().includes(q) && !r.message.toLowerCase().includes(q))
        continue;
      const cur = map.get(r.route_path);
      if (!cur) {
        map.set(r.route_path, {
          route_path: r.route_path,
          count: 1,
          lastAt: r.created_at,
          lastMessage: r.message,
          lastStack: r.stack,
          samples: [r],
        });
      } else {
        cur.count += 1;
        if (r.created_at > cur.lastAt) {
          cur.lastAt = r.created_at;
          cur.lastMessage = r.message;
          cur.lastStack = r.stack;
        }
        if (cur.samples.length < 5) cur.samples.push(r);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [rows, search]);

  const total = rows.length;
  const distinctRoutes = grouped.length;

  // Cap rendered groups; the fetch already limits to 1000 rows, but a noisy
  // window can still produce many distinct routes. Paginate client-side.
  const PAGE_SIZE = 20;
  const pageCount = Math.max(1, Math.ceil(grouped.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageGroups = grouped.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  // Reset to the first page whenever the filter/window changes.
  useEffect(() => {
    setPage(0);
  }, [search, windowKey]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="label-mono">telemetry</p>
          <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Route errors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Routes that crashed in production, grouped by path. Reported automatically by the in-app
            error boundary.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={() => {
              exportRowsAsCSV(
                `route-errors-${windowKey}-${new Date().toISOString().slice(0, 10)}.csv`,
                rows,
                [
                  { key: "created_at", header: "created_at" },
                  { key: "route_path", header: "route_path" },
                  { key: "message", header: "message" },
                  { key: "user_id", header: "user_id" },
                  { key: "user_agent", header: "user_agent" },
                  { key: "stack", header: "stack" },
                  { key: "id", header: "id" },
                ],
              );
              toast.success(`Exported ${rows.length} rows`);
            }}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Reload
          </Button>
        </div>
      </header>

      <TrendSparkline rows={rows} />

      <div className="grid gap-2 md:grid-cols-3">
        <SummaryTile label="Total reports" value={String(total)} tone="info" />
        <SummaryTile label="Distinct routes" value={String(distinctRoutes)} tone="warning" />
        <SummaryTile label="Window" value={windowKey} tone="muted" />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <CardTitle className="text-base">Failures by route</CardTitle>
              <CardDescription>
                Sorted by count. Click a row to inspect the most recent stack.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full md:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter routes / messages…"
                  className="h-9 pl-8 font-mono text-xs"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <Select value={windowKey} onValueChange={(v) => setWindowKey(v as Window)}>
                  <SelectTrigger className="h-9 w-28 text-xs font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24h">24h</SelectItem>
                    <SelectItem value="7d">7d</SelectItem>
                    <SelectItem value="30d">30d</SelectItem>
                    <SelectItem value="all">all time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              Loading telemetry…
            </div>
          ) : grouped.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              No route errors recorded for this window. 🎉
            </div>
          ) : (
            pageGroups.map((g) => {
              const open = expandedId === g.route_path;
              return (
                <div
                  key={g.route_path}
                  className={cn(
                    "rounded-md border bg-surface transition-colors",
                    open ? "border-destructive/40" : "border-border hover:bg-muted/30",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : g.route_path)}
                    className="flex w-full items-center gap-3 p-3 text-left"
                  >
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="truncate font-mono text-sm">{g.route_path}</code>
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px] uppercase border-destructive/40 text-destructive"
                        >
                          {g.count} {g.count === 1 ? "fail" : "fails"}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        last {formatDistanceToNow(g.lastAt)} · {g.lastMessage}
                      </div>
                    </div>
                    <Link
                      to={g.route_path as "/"}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase text-accent hover:underline"
                    >
                      open <ExternalLink className="h-3 w-3" />
                    </Link>
                  </button>
                  {open && (
                    <div className="space-y-2 border-t px-3 pb-3 pt-2">
                      {g.lastStack && (
                        <div>
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                              latest stack
                            </span>
                            <CopyButton value={g.lastStack} label="stack" size="xs" />
                          </div>
                          <pre className="max-h-60 overflow-auto bg-muted/40 p-2 font-mono text-[10px] text-destructive">
                            {g.lastStack}
                          </pre>
                        </div>
                      )}
                      <div>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          recent samples
                        </span>
                        <ul className="mt-1 space-y-1">
                          {g.samples.map((s) => (
                            <li
                              key={s.id}
                              className="flex items-center gap-2 border px-2 py-1 font-mono text-[10px]"
                            >
                              <span className="text-muted-foreground">
                                {formatDistanceToNow(s.created_at)}
                              </span>
                              <span className="truncate">{s.message}</span>
                              <CopyButton
                                value={s.id}
                                label="report id"
                                size="icon"
                                className="ml-auto"
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
          <ListPager page={clampedPage} pageCount={pageCount} onPage={setPage} />
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "info" | "warning" | "success" | "destructive" | "muted";
}) {
  const tones: Record<typeof tone, string> = {
    info: "border-info/30 text-info",
    warning: "border-warning/30 text-warning",
    success: "border-success/30 text-success",
    destructive: "border-destructive/30 text-destructive",
    muted: "border-border text-muted-foreground",
  };
  return (
    <Card className={cn("bg-surface", tones[tone])}>
      <CardContent className="p-4">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      </CardContent>
    </Card>
  );
}

function TrendSparkline({ rows }: { rows: Row[] }) {
  const buckets = useMemo(() => {
    const days = 14;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const arr: { day: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      arr.push({ day: d.toISOString().slice(0, 10), count: 0 });
    }
    const idx = new Map(arr.map((b, i) => [b.day, i]));
    for (const r of rows) {
      const k = r.created_at.slice(0, 10);
      const i = idx.get(k);
      if (i !== undefined) arr[i].count += 1;
    }
    return arr;
  }, [rows]);

  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              14-day trend
            </div>
            <div className="text-sm font-medium">
              {total} reports · peak {max}/day
            </div>
          </div>
        </div>
        <div className="flex h-16 items-end gap-1">
          {buckets.map((b) => (
            <div key={b.day} className="group relative flex-1" title={`${b.day}: ${b.count}`}>
              <div
                className={cn(
                  "w-full rounded-sm transition-colors",
                  b.count === 0
                    ? "bg-muted/30"
                    : b.count >= max * 0.66
                      ? "bg-destructive/70"
                      : b.count >= max * 0.33
                        ? "bg-warning/70"
                        : "bg-info/60",
                )}
                style={{ height: `${Math.max(4, (b.count / max) * 100)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground">
          <span>{buckets[0].day}</span>
          <span>{buckets[buckets.length - 1].day}</span>
        </div>
      </CardContent>
    </Card>
  );
}
