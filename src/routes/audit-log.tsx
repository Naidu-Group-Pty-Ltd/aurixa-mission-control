import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
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
import { ScrollText, Filter, X, Inbox, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { AuditLogSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import { AuditLogDetailDrawer } from "@/components/audit-log-detail-drawer";
import { RefreshButton } from "@/components/refresh-button";

type AuditLog = Database["public"]["Tables"]["audit_log"]["Row"];

const PAGE_SIZE = 50;

const ACTION_VALUES = ["all", "cascade.executed", "fleet.drift_scan", "modules.detected"] as const;

const ENTITY_VALUES = ["all", "cascade_event", "clone", "module"] as const;

const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "cascade.executed", label: "Cascades executed" },
  { value: "fleet.drift_scan", label: "Fleet drift scans" },
  { value: "modules.detected", label: "Module detections" },
];

const ENTITY_OPTIONS = [
  { value: "all", label: "All entities" },
  { value: "cascade_event", label: "Cascade events" },
  { value: "clone", label: "Clones" },
  { value: "module", label: "Modules" },
];

const searchSchema = z.object({
  action: fallback(z.enum(ACTION_VALUES), "all").default("all"),
  entity: fallback(z.enum(ENTITY_VALUES), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  page: fallback(z.number().int().min(0).max(10_000), 0).default(0),
});

export const Route = createFileRoute("/audit-log")({
  errorComponent: RouteError,
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <AuditLogPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Audit Log — Aurixa Systems Mission Control" }] }),
});

function AuditLogPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/audit-log" });
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<AuditLog | null>(null);

  type SearchState = typeof search;

  const updateFilter = useCallback(
    (patch: Partial<SearchState>) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, ...patch, page: 0 }),
        replace: true,
      });
    },
    [navigate],
  );
  const setPage = useCallback(
    (page: number) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, page }),
        replace: true,
      });
    },
    [navigate],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const from = search.page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    let q = supabase
      .from("audit_log")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    if (search.action !== "all") q = q.eq("action", search.action);
    if (search.entity !== "all") q = q.eq("entity_type", search.entity);
    const { data, count } = await q;
    setLogs(data ?? []);
    setTotal(count ?? 0);
    setLoading(false);
    setLastUpdated(new Date());
  }, [search.action, search.entity, search.page]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visible = search.q
    ? logs.filter(
        (l) =>
          l.action.toLowerCase().includes(search.q.toLowerCase()) ||
          (l.entity_type ?? "").toLowerCase().includes(search.q.toLowerCase()) ||
          JSON.stringify(l.metadata).toLowerCase().includes(search.q.toLowerCase()),
      )
    : logs;

  const hasFilters = search.action !== "all" || search.entity !== "all" || search.q.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clearFilters = () =>
    navigate({
      search: () => ({ action: "all", entity: "all", q: "", page: 0 }),
      replace: true,
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
            <ScrollText className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="label-mono">timeline</p>
            <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Audit Log</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every cascade, detection, and drift scan in one place.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { exportAuditLog } = await import("@/server/operator-ux.functions");
              const res = await exportAuditLog({
                data: { action: search.action, entity: search.entity, limit: 5000 },
              });
              if (!res.ok) return;
              const header = [
                "created_at",
                "action",
                "entity_type",
                "entity_id",
                "actor_user_id",
                "metadata",
              ];
              const csv = [header.join(",")]
                .concat(
                  res.rows.map((r) =>
                    [
                      r.created_at,
                      r.action,
                      r.entity_type ?? "",
                      r.entity_id ?? "",
                      r.actor_user_id ?? "",
                      JSON.stringify(r.metadata).replace(/"/g, '""'),
                    ]
                      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                      .join(","),
                  ),
                )
                .join("\n");
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export CSV
          </Button>
          <RefreshButton onRefresh={refresh} loading={loading} lastUpdated={lastUpdated} />
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Select
            value={search.action}
            onValueChange={(v) => updateFilter({ action: v as typeof search.action })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.entity}
            onValueChange={(v) => updateFilter({ entity: v as typeof search.entity })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Input
              placeholder="Search actions, metadata…"
              value={search.q}
              onChange={(e) => updateFilter({ q: e.target.value })}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 px-2"
                onClick={clearFilters}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardDescription className="font-mono text-[11px] uppercase tracking-wider">
            {total.toLocaleString()} {total === 1 ? "entry" : "entries"}
            {total > 0 && (
              <span className="ml-2 text-muted-foreground/70">
                · page {search.page + 1} of {totalPages}
              </span>
            )}
          </CardDescription>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={search.page === 0 || loading}
              onClick={() => setPage(search.page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={search.page + 1 >= totalPages || loading}
              onClick={() => setPage(search.page + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <AuditLogSkeleton count={6} />
          ) : visible.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Inbox />}
                title="No audit entries"
                description={
                  hasFilters
                    ? "Nothing matches these filters. Try clearing them to see the full timeline."
                    : "Cascades, drift scans, and module detections will appear here as they happen."
                }
              />
            </div>
          ) : (
            <ol className="relative">
              {visible.map((log, i) => (
                <LogRow
                  key={log.id}
                  log={log}
                  isLast={i === visible.length - 1}
                  onOpen={() => setSelected(log)}
                />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <AuditLogDetailDrawer log={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

function LogRow({ log, isLast, onOpen }: { log: AuditLog; isLast: boolean; onOpen: () => void }) {
  const tone = actionTone(log.action);

  return (
    <li className={cn("relative px-4 py-3", !isLast && "border-b border-border/60")}>
      <div className="flex items-start gap-3">
        <div className="relative flex flex-col items-center pt-1">
          <div className={cn("h-2 w-2 rounded-full ring-2 ring-background", tone.dot)} />
          {!isLast && <div className="absolute top-3 h-full w-px bg-border/60" />}
        </div>
        <button type="button" onClick={onOpen} className="flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <code className={cn("font-mono text-sm font-medium", tone.text)}>{log.action}</code>
            {log.entity_type && (
              <Badge variant="outline" className="text-[10px] uppercase">
                {log.entity_type}
              </Badge>
            )}
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatDistanceToNow(log.created_at)}
            </span>
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/50" />
          </div>
          {Object.keys(log.metadata as object).length > 0 && (
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {summarizeMeta(log.metadata)}
            </div>
          )}
        </button>
      </div>
    </li>
  );
}

function summarizeMeta(meta: AuditLog["metadata"]): string {
  if (!meta || typeof meta !== "object") return "";
  const m = meta as Record<string, unknown>;
  return Object.entries(m)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

function actionTone(action: string): { dot: string; text: string } {
  if (action.startsWith("cascade")) return { dot: "bg-info", text: "text-foreground" };
  if (action.startsWith("fleet")) return { dot: "bg-accent", text: "text-foreground" };
  if (action.startsWith("modules")) return { dot: "bg-primary", text: "text-foreground" };
  if (action.includes("fail") || action.includes("error"))
    return { dot: "bg-destructive", text: "text-destructive" };
  return { dot: "bg-muted-foreground", text: "text-foreground" };
}
