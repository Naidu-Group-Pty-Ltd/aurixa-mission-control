import { createFileRoute, Link, useParams, useNavigate, notFound } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useEffect, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Boxes, Waves, ChevronRight, X } from "lucide-react";
import { StatusPill } from "@/components/status-pill";
import { formatDistanceToNow } from "@/lib/format";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { bulkSyncModuleFn } from "@/server/module-sync.functions";
import { ModuleBackendCard } from "@/components/module-backend-card";
import { MetricCell } from "@/components/metric-bar";
import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";

type Module = Database["public"]["Tables"]["modules"]["Row"];
type Clone = Database["public"]["Tables"]["clones"]["Row"];
type SyncStatus = Database["public"]["Enums"]["sync_status"];

const STATUS_VALUES = ["in_sync", "behind", "failed", "cascading", "unknown"] as const;

const searchSchema = z.object({
  status: fallback(z.enum(STATUS_VALUES).optional(), undefined).optional(),
});

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "destructive";
}) {
  return <MetricCell label={label} value={value} tone={tone} alarm={Boolean(tone)} />;
}

function FilterChip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "success" | "warning" | "destructive";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const toneCls = !active
    ? "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
    : tone === "success"
      ? "border-success/50 bg-success/10 text-success"
      : tone === "warning"
        ? "border-warning/50 bg-warning/10 text-warning"
        : tone === "destructive"
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-primary/50 bg-primary/10 text-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        toneCls,
      )}
    >
      {children}
    </button>
  );
}

export const Route = createFileRoute("/modules/$slug")({
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <ModuleDetail />
    </ProtectedRoute>
  ),
  notFoundComponent: () => (
    <div className="space-y-3">
      <Link
        to="/modules"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> modules
      </Link>
      <div>Module not found.</div>
    </div>
  ),
});

function ModuleDetail() {
  const { slug } = useParams({ from: "/modules/$slug" });
  const { status: statusFilter } = Route.useSearch();
  const navigate = useNavigate({ from: "/modules/$slug" });
  const [module, setModule] = useState<Module | null>(null);
  const [clones, setClones] = useState<Clone[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const bulkSync = useServerFn(bulkSyncModuleFn);

  const setStatusFilter = (s: SyncStatus | null) =>
    navigate({
      search: (prev: { status?: SyncStatus }) => ({ ...prev, status: s ?? undefined }),
      replace: true,
    });

  const load = async () => {
    setLoading(true);
    const { data: m } = await supabase.from("modules").select("*").eq("slug", slug).maybeSingle();
    setModule(m ?? null);
    if (m) {
      const { data: cm } = await supabase
        .from("clone_modules")
        .select("clone_id, clones(*)")
        .eq("module_id", m.id);
      setClones(
        ((cm ?? []) as Array<{ clones: Clone | null }>)
          .map((r) => r.clones)
          .filter((c): c is Clone => Boolean(c)),
      );
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [slug]);

  const syncAll = async () => {
    if (!module) return;
    setSyncing(true);
    try {
      const res = await bulkSync({
        data: {
          moduleId: module.id,
          cloneIds: clones.map((c) => c.id),
          action: "install",
          cascade: true,
          cascadeMode: "pr",
        },
      });
      if (!res.ok) {
        toast.error(res.error ?? "Sync failed");
      } else {
        toast.success(`Sync-all queued — ${clones.length} clone(s)`);
        load();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div className="font-mono text-sm text-muted-foreground">loading…</div>;
  }

  if (!module) {
    throw notFound();
  }

  const globCount = (module.file_globs ?? []).length;
  const edgeFnCount = (module.edge_functions ?? []).length;
  const secretCount = (module.required_secrets ?? []).length;
  const behind = clones.filter((c) => c.sync_status === "behind").length;
  const failed = clones.filter((c) => c.sync_status === "failed").length;
  const inSync = clones.filter((c) => c.sync_status === "in_sync").length;

  return (
    <div className="space-y-6">
      <Link
        to="/modules"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> modules
      </Link>

      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="label-mono">module health</p>
          <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">{module.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {module.status}
            </Badge>
            <span className="font-mono">{module.slug}</span>
            <span className="font-mono">
              · {globCount} glob{globCount === 1 ? "" : "s"}
            </span>
            {edgeFnCount > 0 && (
              <span className="font-mono">
                · {edgeFnCount} edge fn{edgeFnCount === 1 ? "" : "s"}
              </span>
            )}
            {secretCount > 0 && (
              <span className="font-mono text-warning">
                · {secretCount} secret{secretCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
        <Button onClick={syncAll} disabled={syncing || clones.length === 0 || globCount === 0}>
          <Waves className="mr-2 h-4 w-4" />
          {syncing ? "Queueing…" : `Sync-all (${clones.length})`}
        </Button>
      </div>

      <div className="glass grid overflow-hidden md:grid-cols-4">
        <StatTile label="installed on" value={clones.length} />
        <StatTile label="in sync" value={inSync} tone="success" />
        <StatTile label="behind" value={behind} tone="warning" />
        <StatTile label="failed" value={failed} tone="destructive" />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base">Coverage</CardTitle>
              <CardDescription>
                Clones with this module installed and their current sync state.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip active={!statusFilter} onClick={() => setStatusFilter(null)}>
                all · {clones.length}
              </FilterChip>
              <FilterChip
                active={statusFilter === "in_sync"}
                tone="success"
                onClick={() => setStatusFilter("in_sync")}
              >
                in sync · {inSync}
              </FilterChip>
              <FilterChip
                active={statusFilter === "behind"}
                tone="warning"
                onClick={() => setStatusFilter("behind")}
              >
                behind · {behind}
              </FilterChip>
              <FilterChip
                active={statusFilter === "failed"}
                tone="destructive"
                onClick={() => setStatusFilter("failed")}
              >
                failed · {failed}
              </FilterChip>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {clones.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              <Boxes className="mx-auto mb-2 h-5 w-5" />
              No clones have this module installed yet.
            </div>
          ) : (
            (() => {
              const filtered = statusFilter
                ? clones.filter((c) => c.sync_status === statusFilter)
                : clones;
              if (filtered.length === 0) {
                return (
                  <div className="flex flex-col items-center gap-2 border border-dashed p-6 text-center text-sm text-muted-foreground">
                    <Boxes className="h-5 w-5" />
                    No clones match the {statusFilter?.replace("_", " ")} filter.
                    <button
                      type="button"
                      onClick={() => setStatusFilter(null)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-primary hover:underline"
                    >
                      <X className="h-3 w-3" /> clear filter
                    </button>
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  {filtered.map((c) => (
                    <Link
                      key={c.id}
                      to="/clones/$cloneId"
                      params={{ cloneId: c.id }}
                      className="block"
                    >
                      <Card className="transition-colors hover:border-primary/40">
                        <CardContent className="flex items-center justify-between p-4">
                          <div className="min-w-0">
                            <div className="font-mono text-sm font-medium">{c.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {c.github_owner}/{c.github_repo}
                              {c.last_cascade_at && (
                                <> · last cascade {formatDistanceToNow(c.last_cascade_at)}</>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusPill status={c.sync_status} behind={c.commits_behind} />
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              );
            })()
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">File globs</CardTitle>
          <CardDescription>
            Only files matching these patterns get pushed during a scoped sync.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {(module.file_globs ?? []).map((g) => (
              <code key={g} className="bg-muted px-2 py-1 font-mono text-[11px]">
                {g}
              </code>
            ))}
            {(module.file_globs ?? []).length === 0 && (
              <span className="text-sm text-muted-foreground">No globs configured.</span>
            )}
          </div>
        </CardContent>
      </Card>

      <ModuleBackendCard module={module} />
    </div>
  );
}
