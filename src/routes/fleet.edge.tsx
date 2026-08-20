// Fleet-wide edge security dashboard.
// Admin-only view of every clone's edge configuration and quick actions.
import { createFileRoute, Link } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Shield, RefreshCw, ExternalLink, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { toast } from "sonner";
import { useUserRoles } from "@/lib/use-user-roles";
import {
  enqueueEdgeJob,
  applyEdgePreset,
  listEdgePresets,
  listEdgeProviders,
} from "@/server/edge-provisioning.functions";
import { formatDistanceToNow } from "@/lib/format";

type FleetRow = {
  clone_id: string;
  clone_name: string;
  provider_slug: string | null;
  hostname: string | null;
  status: string | null;
  status_detail: string | null;
  posture_preset: string | null;
  last_synced_at: string | null;
  pending_jobs: number;
  failed_jobs: number;
};

const getFleetEdge = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const s = context.supabase as any;
    const { data: clones } = await s.from("clones").select("id, name").order("name");
    const { data: configs } = await s
      .from("clone_edge_config")
      .select(
        "clone_id, provider_slug, hostname, status, status_detail, posture_preset, last_synced_at",
      );
    const { data: pending } = await s
      .from("edge_provisioning_jobs")
      .select("clone_id, status")
      .in("status", ["queued", "running"]);
    const { data: failed } = await s
      .from("edge_provisioning_jobs")
      .select("clone_id, status")
      .eq("status", "failed");

    const rows: FleetRow[] = [];
    const configsByClone = new Map<string, any[]>();
    for (const c of configs ?? []) {
      const arr = configsByClone.get(c.clone_id) ?? [];
      arr.push(c);
      configsByClone.set(c.clone_id, arr);
    }
    const pendingByClone = new Map<string, number>();
    for (const p of pending ?? [])
      pendingByClone.set(p.clone_id, (pendingByClone.get(p.clone_id) ?? 0) + 1);
    const failedByClone = new Map<string, number>();
    for (const f of failed ?? [])
      failedByClone.set(f.clone_id, (failedByClone.get(f.clone_id) ?? 0) + 1);

    for (const clone of clones ?? []) {
      const cfgs = configsByClone.get(clone.id);
      if (!cfgs || cfgs.length === 0) {
        rows.push({
          clone_id: clone.id,
          clone_name: clone.name,
          provider_slug: null,
          hostname: null,
          status: null,
          status_detail: null,
          posture_preset: null,
          last_synced_at: null,
          pending_jobs: pendingByClone.get(clone.id) ?? 0,
          failed_jobs: failedByClone.get(clone.id) ?? 0,
        });
      } else {
        for (const c of cfgs) {
          rows.push({
            clone_id: clone.id,
            clone_name: clone.name,
            provider_slug: c.provider_slug,
            hostname: c.hostname,
            status: c.status,
            status_detail: c.status_detail,
            posture_preset: c.posture_preset,
            last_synced_at: c.last_synced_at,
            pending_jobs: pendingByClone.get(clone.id) ?? 0,
            failed_jobs: failedByClone.get(clone.id) ?? 0,
          });
        }
      }
    }
    return { rows };
  });

export const Route = createFileRoute("/fleet/edge")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <FleetEdge />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [{ title: "Edge security fleet — Aurixa Systems Mission Control" }],
  }),
});

function toneFor(status: string | null | undefined) {
  if (status === "active") return "text-success border-success/40";
  if (status === "error") return "text-destructive border-destructive/40";
  if (status === "waitlisted") return "text-warning border-warning/40";
  if (status === "attaching" || status === "syncing") return "text-info border-info/40";
  return "text-muted-foreground";
}

function FleetEdge() {
  const { isAdmin } = useUserRoles();
  const fetchFleet = useServerFn(getFleetEdge);
  const enqueue = useServerFn(enqueueEdgeJob);
  const applyPreset = useServerFn(applyEdgePreset);
  const listPresets = useServerFn(listEdgePresets);
  const listProviders = useServerFn(listEdgeProviders);

  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPreset, setBulkPreset] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const rowKey = (r: FleetRow) => `${r.clone_id}::${r.provider_slug ?? "none"}`;

  // useQuery gives us caching + a real error path — the old hand-rolled load()
  // had try/finally with no catch, so a fetch failure surfaced as "No matches".
  const query = useQuery({
    queryKey: ["fleet-edge"],
    queryFn: async () => {
      const [f, p, pr] = await Promise.all([fetchFleet(), listPresets(), listProviders()]);
      return {
        rows: (f.rows ?? []) as FleetRow[],
        presets: p.presets ?? [],
        providers: pr.providers ?? [],
      };
    },
  });

  const rows = query.data?.rows ?? [];
  const presets = query.data?.presets ?? [];
  const providers = query.data?.providers ?? [];
  const loading = query.isPending;
  const load = () => {
    void query.refetch();
  };

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== "all") {
        if (statusFilter === "unattached" && r.status) return false;
        if (statusFilter !== "unattached" && r.status !== statusFilter) return false;
      }
      if (filter && !r.clone_name.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [rows, filter, statusFilter]);

  const stats = useMemo(() => {
    const attached = rows.filter((r) => r.status === "active").length;
    const errors = rows.filter((r) => r.status === "error").length;
    const waitlisted = rows.filter((r) => r.status === "waitlisted").length;
    const pending = rows.reduce((s, r) => s + r.pending_jobs, 0);
    const uniqueClones = new Set(rows.map((r) => r.clone_id)).size;
    return { attached, errors, waitlisted, pending, uniqueClones };
  }, [rows]);

  const sync = async (row: FleetRow) => {
    if (!row.provider_slug) return;
    setBusy(`sync:${row.clone_id}:${row.provider_slug}`);
    try {
      await enqueue({
        data: {
          cloneId: row.clone_id,
          providerSlug: row.provider_slug as any,
          action: "sync",
          payload: {},
        },
      });
      toast.success("Sync queued");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const changePreset = async (row: FleetRow, presetSlug: string) => {
    if (!row.provider_slug) return;
    setBusy(`preset:${row.clone_id}:${row.provider_slug}`);
    try {
      await applyPreset({
        data: {
          cloneId: row.clone_id,
          providerSlug: row.provider_slug as any,
          presetSlug,
        },
      });
      toast.success("Posture update queued");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const selectableRows = useMemo(
    () => filtered.filter((r) => r.provider_slug && r.status !== "waitlisted"),
    [filtered],
  );
  const allSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selected.has(rowKey(r)));
  const someSelected = selected.size > 0 && !allSelected;
  const toggleRow = (r: FleetRow) => {
    const k = rowKey(r);
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(selectableRows.map(rowKey)));
  };
  const clearSelection = () => setSelected(new Set());

  const selectedRows = useMemo(
    () => filtered.filter((r) => selected.has(rowKey(r))),
    [filtered, selected],
  );

  const bulkSync = async () => {
    if (selectedRows.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        selectedRows.map((r) =>
          enqueue({
            data: {
              cloneId: r.clone_id,
              providerSlug: r.provider_slug as any,
              action: "sync",
              payload: {},
            },
          }),
        ),
      );
      toast.success(`Queued sync for ${selectedRows.length} clone(s)`);
      clearSelection();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk sync failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkApplyPreset = async () => {
    if (selectedRows.length === 0 || !bulkPreset) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        selectedRows.map((r) =>
          applyPreset({
            data: {
              cloneId: r.clone_id,
              providerSlug: r.provider_slug as any,
              presetSlug: bulkPreset,
            },
          }),
        ),
      );
      toast.success(`Applied "${bulkPreset}" to ${selectedRows.length} clone(s)`);
      clearSelection();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk apply failed");
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet"
        icon={<Shield className="h-7 w-7 text-info" />}
        title="Edge security"
        description="Fleet-wide view of edge/CDN providers attached to every clone."
        actions={
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      <div className="glass grid overflow-hidden md:grid-cols-5">
        <StatTile label="Clones" value={stats.uniqueClones} />
        <StatTile label="Active" value={stats.attached} tone="text-success" />
        <StatTile label="Errors" value={stats.errors} tone="text-destructive" />
        <StatTile label="Waitlisted" value={stats.waitlisted} tone="text-warning" />
        <StatTile label="Pending jobs" value={stats.pending} tone="text-info" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fleet coverage</CardTitle>
          <CardDescription>
            {providers.length} providers registered · {presets.length} posture presets
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Filter by clone name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-xs"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="unattached">Unattached</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="waitlisted">Waitlisted</SelectItem>
                <SelectItem value="attaching">Attaching</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isAdmin && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border border-primary/40 bg-primary/5 px-3 py-2">
              <Badge variant="outline" className="border-primary/40 text-primary">
                {selected.size} selected
              </Badge>
              <Select value={bulkPreset} onValueChange={setBulkPreset}>
                <SelectTrigger className="h-8 w-[180px] text-xs">
                  <SelectValue placeholder="Apply preset…" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.slug} value={p.slug}>
                      {p.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={bulkApplyPreset} disabled={bulkBusy || !bulkPreset}>
                Reapply posture
              </Button>
              <Button size="sm" variant="outline" onClick={bulkSync} disabled={bulkBusy}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${bulkBusy ? "animate-spin" : ""}`} />
                Sync selected
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy}>
                Clear
              </Button>
            </div>
          )}

          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  {isAdmin && (
                    <th className="w-8 px-3 py-2 text-left">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={toggleAll}
                        aria-label="Select all"
                      />
                    </th>
                  )}
                  <th className="px-3 py-2 text-left">Clone</th>
                  <th className="px-3 py-2 text-left">Provider</th>
                  <th className="px-3 py-2 text-left">Hostname</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Posture</th>
                  <th className="px-3 py-2 text-left">Last sync</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={isAdmin ? 8 : 7} className="p-6 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && query.error && (
                  <tr>
                    <td colSpan={isAdmin ? 8 : 7} className="p-6 text-center">
                      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                        <AlertTriangle className="h-6 w-6 text-destructive" />
                        <span>
                          {query.error instanceof Error
                            ? query.error.message
                            : "Couldn't load the edge fleet."}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && !query.error && filtered.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 8 : 7} className="p-6 text-center text-muted-foreground">
                      {rows.length === 0
                        ? "No edge configuration found across the fleet."
                        : "No clones match this filter."}
                    </td>
                  </tr>
                )}
                {!query.error &&
                  filtered.map((r, i) => {
                    const canSelect = !!r.provider_slug && r.status !== "waitlisted";
                    return (
                      <tr
                        key={`${r.clone_id}-${r.provider_slug ?? "none"}-${i}`}
                        className="border-t"
                      >
                        {isAdmin && (
                          <td className="px-3 py-2">
                            {canSelect && (
                              <Checkbox
                                checked={selected.has(rowKey(r))}
                                onCheckedChange={() => toggleRow(r)}
                                aria-label={`Select ${r.clone_name}`}
                              />
                            )}
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <Link
                            to="/clones/$cloneId"
                            params={{ cloneId: r.clone_id }}
                            className="font-mono hover:text-primary"
                          >
                            {r.clone_name}
                          </Link>
                          {r.failed_jobs > 0 && (
                            <Badge variant="outline" className="ml-2 text-[10px] text-destructive">
                              {r.failed_jobs} failed
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {r.provider_slug ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {r.hostname ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {r.status ? (
                            <Badge
                              variant="outline"
                              className={`font-mono text-[10px] ${toneFor(r.status)}`}
                            >
                              {r.status}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">not attached</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.provider_slug && isAdmin ? (
                            <Select
                              value={r.posture_preset ?? ""}
                              onValueChange={(v) => changePreset(r, v)}
                              disabled={busy !== null || r.status === "waitlisted"}
                            >
                              <SelectTrigger className="h-7 w-[140px] text-xs">
                                <SelectValue placeholder="—" />
                              </SelectTrigger>
                              <SelectContent>
                                {presets.map((p) => (
                                  <SelectItem key={p.slug} value={p.slug}>
                                    {p.display_name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="font-mono text-xs">{r.posture_preset ?? "—"}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                          {r.last_synced_at ? formatDistanceToNow(r.last_synced_at) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            {r.provider_slug && isAdmin && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy !== null || r.status === "waitlisted"}
                                onClick={() => sync(r)}
                                className="h-7 px-2"
                              >
                                <RefreshCw
                                  className={`h-3.5 w-3.5 ${
                                    busy === `sync:${r.clone_id}:${r.provider_slug}`
                                      ? "animate-spin"
                                      : ""
                                  }`}
                                />
                              </Button>
                            )}
                            <Link
                              to="/clones/$cloneId"
                              params={{ cloneId: r.clone_id }}
                              className="inline-flex h-7 items-center px-2 text-muted-foreground hover:text-foreground"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const TONE_CLASS_TO_TONE = {
  "text-success": "success",
  "text-destructive": "destructive",
  "text-warning": "warning",
  "text-info": "primary",
} as const;

function StatTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const mapped = tone ? TONE_CLASS_TO_TONE[tone as keyof typeof TONE_CLASS_TO_TONE] : undefined;
  return <MetricCell label={label} value={value} tone={mapped} alarm={Boolean(mapped)} />;
}
