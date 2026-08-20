// @ts-nocheck
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import { EmptyState } from "@/components/empty-state";
import { CloneGridSkeleton } from "@/components/list-skeletons";
import { ProtectedRoute } from "@/components/protected-route";
import { StatusPill } from "@/components/status-pill";
import { exportRowsAsCSV } from "@/lib/csv";
import { formatDistanceToNow } from "@/lib/format";
import { useClones, useFleetModules, usePrimeConfig } from "@/lib/queries";
import {
  bulkDeleteClones,
  bulkPauseClones,
  bulkReprovisionBackends,
} from "@/server/operator-ux.functions";
import {
  createBulkSecurityAssessments,
  listSecurityDashboardSummaries,
  listSecurityPartnersForAssignment,
} from "@/server/security-partner-dashboard.functions";
import {
  ArrowDownUp,
  Download,
  ExternalLink,
  GitBranch,
  Github,
  Package,
  PauseCircle,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

const dashboardSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  filter: fallback(z.enum(["all", "in_sync", "behind", "failed", "ai"]), "all").default("all"),
  sort: fallback(z.enum(["name", "commits_behind", "last_cascade_at", "ai_suggestions"]), "name").default(
    "name",
  ),
  module: fallback(z.string(), "").default(""),
});

type SecuritySummary = {
  id: string;
  clone_id: string;
  status: string;
  cycle: string;
  aurixa_review_status: string;
  partner?: { name: string; slug: string } | null;
  open_findings: number;
  critical_findings: number;
  report_count: number;
  pending_retests: number;
};

export const Route = createFileRoute("/dashboard")({
  validateSearch: zodValidator(dashboardSearchSchema),
  component: () => (
    <ProtectedRoute>
      <Dashboard />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Fleet — Aurixa Systems Mission Control" }] }),
});

function Dashboard() {
  const { data: clones, loading, refresh: refreshClones } = useClones();
  const { data: prime } = usePrimeConfig();
  const { byClone: modulesByClone } = useFleetModules();
  const { q, filter, sort, module: moduleFilter } = Route.useSearch();
  const navigate = useNavigate({ from: "/dashboard" });
  const listSecurity = useServerFn(listSecurityDashboardSummaries);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [securityRows, setSecurityRows] = useState<SecuritySummary[]>([]);

  type DashboardSearch = z.infer<typeof dashboardSearchSchema>;
  const setQ = (value: string) => navigate({ search: (prev: DashboardSearch) => ({ ...prev, q: value }), replace: true });
  const setFilter = (value: typeof filter) => navigate({ search: (prev: DashboardSearch) => ({ ...prev, filter: value }), replace: true });
  const setSort = (value: typeof sort) => navigate({ search: (prev: DashboardSearch) => ({ ...prev, sort: value }), replace: true });
  const setModuleFilter = (value: string) => navigate({ search: (prev: DashboardSearch) => ({ ...prev, module: value }), replace: true });

  const openSuggestionsCount = (clone: (typeof clones)[number]) => {
    const suggestions = (clone.drift_suggestions as unknown as Array<{ status?: string }> | null) ?? [];
    return suggestions.filter((suggestion) => (suggestion?.status ?? "open") === "open").length;
  };

  useEffect(() => {
    if (loading) return;
    if (clones.length === 0) {
      setSecurityRows((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void listSecurity({ data: { cloneIds: clones.map((clone) => clone.id) } })
      .then((result) => {
        if (!cancelled) setSecurityRows((result.summaries ?? []) as SecuritySummary[]);
      })
      .catch(() => {
        if (!cancelled) setSecurityRows((prev) => (prev.length === 0 ? prev : []));
      });
    return () => {
      cancelled = true;
    };
  }, [clones, loading, listSecurity]);


  const securityByClone = useMemo(() => {
    const map = new Map<string, SecuritySummary[]>();
    for (const row of securityRows) (map.get(row.clone_id) ?? map.set(row.clone_id, []).get(row.clone_id)!).push(row);
    return map;
  }, [securityRows]);

  const moduleFilterName = useMemo(() => {
    if (!moduleFilter) return null;
    for (const list of Object.values(modulesByClone)) {
      const hit = list.find((module) => module.module_id === moduleFilter);
      if (hit) return hit.module_name;
    }
    return null;
  }, [moduleFilter, modulesByClone]);

  const filtered = useMemo(() => {
    const list = clones.filter((clone) => {
      const matchQ =
        !q ||
        clone.name.toLowerCase().includes(q.toLowerCase()) ||
        clone.tags?.some((tag) => tag.toLowerCase().includes(q.toLowerCase()));
      const matchF = filter === "all" || (filter === "ai" ? openSuggestionsCount(clone) > 0 : clone.sync_status === filter);
      const matchM = !moduleFilter || (modulesByClone[clone.id]?.some((module) => module.module_id === moduleFilter) ?? false);
      return matchQ && matchF && matchM;
    });
    return [...list].sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "commits_behind":
          return (b.commits_behind ?? 0) - (a.commits_behind ?? 0);
        case "last_cascade_at":
          return new Date(b.last_cascade_at ?? 0).getTime() - new Date(a.last_cascade_at ?? 0).getTime();
        case "ai_suggestions":
          return openSuggestionsCount(b) - openSuggestionsCount(a);
        default:
          return 0;
      }
    });
  }, [clones, q, filter, sort, moduleFilter, modulesByClone]);

  const stats = useMemo(() => {
    const activeSecurity = securityRows.filter((row) => !["closed", "canceled"].includes(row.status));
    return {
      total: clones.length,
      in_sync: clones.filter((clone) => clone.sync_status === "in_sync").length,
      behind: clones.filter((clone) => clone.sync_status === "behind").length,
      failed: clones.filter((clone) => clone.sync_status === "failed").length,
      ai_open: clones.reduce((acc, clone) => acc + openSuggestionsCount(clone), 0),
      ai_clones: clones.filter((clone) => openSuggestionsCount(clone) > 0).length,
      security_active: activeSecurity.length,
      security_critical: securityRows.reduce((sum, row) => sum + row.critical_findings, 0),
    };
  }, [clones, securityRows]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">fleet overview</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Aurixa Systems Mission Control</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {prime ? (
              <>Prime: <span className="font-mono text-foreground">{prime.github_owner}/{prime.github_repo}</span> · branch <span className="font-mono">{prime.default_branch}</span></>
            ) : (
              <>No prime repo configured. <Link to="/settings" className="text-primary underline-offset-4 hover:underline">Set it up</Link></>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => exportRowsAsCSV("mission-control-clones", filtered)}>
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          <Link to="/security-partners"><Button variant="outline"><ShieldCheck className="mr-2 h-4 w-4" /> Security partners</Button></Link>
          <Link to="/cascades"><Button variant="outline"><Waves className="mr-2 h-4 w-4" /> New cascade</Button></Link>
          <Link to="/clones/new"><Button><Plus className="mr-2 h-4 w-4" /> New clone</Button></Link>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatCard label="Clones" value={stats.total} icon={<GitBranch className="h-4 w-4" />} />
        <StatCard label="In sync" value={stats.in_sync} tone="success" icon={<Zap className="h-4 w-4" />} />
        <StatCard label="Behind" value={stats.behind} tone="warning" icon={<Waves className="h-4 w-4" />} />
        <StatCard label="Failed" value={stats.failed} tone="destructive" icon={<Shield className="h-4 w-4" />} />
        <StatCard label={`AI suggestions${stats.ai_clones ? ` · ${stats.ai_clones} clones` : ""}`} value={stats.ai_open} tone="primary" icon={<Sparkles className="h-4 w-4" />} />
        <Link to="/security" className="contents"><StatCard label={`Security${stats.security_critical ? ` · ${stats.security_critical} critical` : ""}`} value={stats.security_active} tone={stats.security_critical ? "destructive" : "success"} icon={<ShieldCheck className="h-4 w-4" />} /></Link>
      </section>

      <section className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative max-w-sm flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="search by name or tag…" value={q} onChange={(event) => setQ(event.target.value)} className="pl-9 font-mono text-sm" /></div>
        <div className="flex flex-wrap gap-1 rounded-md border border-border bg-surface p-1">{(["all", "in_sync", "behind", "failed", "ai"] as const).map((key) => <button key={key} onClick={() => setFilter(key)} className={`rounded px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${filter === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{key === "ai" ? `ai${stats.ai_clones ? ` (${stats.ai_clones})` : ""}` : key.replace("_", " ")}</button>)}</div>
        <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}><SelectTrigger className="w-[200px] font-mono text-xs"><ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" /><SelectValue placeholder="Sort by…" /></SelectTrigger><SelectContent><SelectItem value="name" className="font-mono text-xs">name (a→z)</SelectItem><SelectItem value="commits_behind" className="font-mono text-xs">commits behind (high→low)</SelectItem><SelectItem value="last_cascade_at" className="font-mono text-xs">last cascade (recent first)</SelectItem><SelectItem value="ai_suggestions" className="font-mono text-xs">ai suggestions (high→low)</SelectItem></SelectContent></Select>
        {moduleFilter && <button onClick={() => setModuleFilter("")} className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-primary hover:bg-primary/20" title="Clear module filter"><Package className="h-3 w-3" /> module · {moduleFilterName ?? moduleFilter.slice(0, 6)} <X className="h-3 w-3" /></button>}
        {selected.size > 0 && <div className="ml-auto flex flex-wrap items-center gap-2"><Badge variant="secondary" className="font-mono">{selected.size} selected</Badge><Button size="sm" variant="outline" onClick={() => setBulkTagOpen(true)}><Tag className="mr-1.5 h-3.5 w-3.5" /> Edit tags</Button><BulkSecurityAssessmentButton ids={Array.from(selected)} onDone={() => { setSelected(new Set()); void refreshClones(); }} /><BulkPauseButton ids={Array.from(selected)} onDone={() => { setSelected(new Set()); void refreshClones(); }} /><BulkReprovisionButton ids={Array.from(selected)} onDone={() => { setSelected(new Set()); void refreshClones(); }} /><BulkDeleteButton ids={Array.from(selected)} onDone={() => { setSelected(new Set()); void refreshClones(); }} /></div>}
      </section>

      {loading ? <CloneGridSkeleton count={4} /> : filtered.length === 0 ? (clones.length === 0 ? <DashboardEmpty /> : <EmptyState icon={<Search />} title="No clones match" description="Try clearing the search or switching the filter to see more clones." />) : (
        <section className="grid gap-3 lg:grid-cols-2">
          {filtered.map((clone) => {
            const security = securityByClone.get(clone.id) ?? [];
            const activeSecurity = security.find((row) => !["closed", "canceled"].includes(row.status));
            return <Card key={clone.id} className="border-border/80 bg-card transition-colors hover:border-primary/40"><CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-5 pb-3"><div className="flex items-start gap-3"><Checkbox checked={selected.has(clone.id)} onCheckedChange={() => toggle(clone.id)} className="mt-1.5" /><div><Link to="/clones/$cloneId" params={{ cloneId: clone.id }} className="font-semibold leading-tight hover:text-primary">{clone.name}</Link><div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><Badge variant="outline" className="font-mono text-[10px] uppercase">{clone.provisioning_method}</Badge>{clone.cloudflare_enabled && <Tooltip><TooltipTrigger><Badge variant="outline" className="border-info/40 text-info"><Shield className="h-3 w-3" /></Badge></TooltipTrigger><TooltipContent>Cloudflare wrapper active</TooltipContent></Tooltip>}{activeSecurity && <Tooltip><TooltipTrigger asChild><Link to="/security-partners"><Badge variant="outline" className={activeSecurity.critical_findings ? "border-destructive/40 text-destructive" : "border-success/40 text-success"}><ShieldCheck className="mr-1 h-3 w-3" /> {activeSecurity.status.replaceAll("_", " ")}</Badge></Link></TooltipTrigger><TooltipContent>{activeSecurity.partner?.name ?? "Security partner"} · {activeSecurity.open_findings} open finding(s) · {activeSecurity.report_count} report(s)</TooltipContent></Tooltip>}{clone.tags?.map((tag) => <span key={tag} className="rounded bg-muted px-1.5 py-0.5 font-mono">#{tag}</span>)}</div></div></div><div className="flex flex-col items-end gap-1.5"><StatusPill status={clone.sync_status} behind={clone.commits_behind} />{openSuggestionsCount(clone) > 0 && <Tooltip><TooltipTrigger asChild><Link to="/clones/$cloneId" params={{ cloneId: clone.id }} className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary hover:bg-primary/20"><Sparkles className="h-3 w-3" />{openSuggestionsCount(clone)} ai</Link></TooltipTrigger><TooltipContent>{openSuggestionsCount(clone)} open AI suggestion{openSuggestionsCount(clone) === 1 ? "" : "s"}</TooltipContent></Tooltip>}</div></CardHeader><CardContent className="space-y-2 px-5 pb-5"><div className="font-mono text-xs text-muted-foreground">{clone.github_owner}/{clone.github_repo}</div><div className="flex flex-wrap items-center gap-1.5"><Package className="h-3 w-3 text-muted-foreground" />{(modulesByClone[clone.id] ?? []).length === 0 ? <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">no modules</span> : (modulesByClone[clone.id] ?? []).map((module) => { const active = moduleFilter === module.module_id; return <button key={module.module_id} onClick={() => setModuleFilter(active ? "" : module.module_id)} title={active ? "Clear filter" : `Filter fleet by ${module.module_name}`} className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${active ? "border-primary/60 bg-primary/15 text-primary" : "border-border bg-muted text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}>{module.module_name}</button>; })}</div><div className="flex flex-wrap gap-2 text-xs">{clone.github_url && <a href={clone.github_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><Github className="h-3.5 w-3.5" /> repo</a>}{clone.lovable_project_url && <a href={clone.lovable_project_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /> lovable</a>}{clone.deploy_url && <a href={clone.deploy_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /> deploy</a>}<span className="ml-auto text-muted-foreground">cascaded {formatDistanceToNow(clone.last_cascade_at)}</span></div></CardContent></Card>;
          })}
        </section>
      )}

      <BulkTagDialog open={bulkTagOpen} onOpenChange={setBulkTagOpen} clones={clones} selectedIds={selected} onDone={() => { setSelected(new Set()); void refreshClones(); }} />
    </div>
  );
}

function StatCard({ label, value, tone = "primary", icon }: { label: string; value: number; tone?: "primary" | "success" | "warning" | "destructive"; icon?: React.ReactNode }) {
  const toneCls = { primary: "text-primary", success: "text-success", warning: "text-warning", destructive: "text-destructive" }[tone];
  return <Card className="border-border/80 bg-card"><CardContent className="flex items-center justify-between p-5"><div><div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><div className={`mt-2 font-mono text-3xl font-semibold ${toneCls}`}>{value}</div></div><div className={`flex h-9 w-9 items-center justify-center rounded-md bg-muted ${toneCls}`}>{icon}</div></CardContent></Card>;
}

function DashboardEmpty() {
  return <EmptyState icon={<GitBranch />} title="No clones in the fleet" description="Provision your first clone from the prime codebase. It can be a fork, a template instance, or an independent clone." action={<Link to="/clones/new"><Button><Plus className="mr-2 h-4 w-4" /> Provision first clone</Button></Link>} />;
}

function BulkSecurityAssessmentButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const listPartners = useServerFn(listSecurityPartnersForAssignment);
  const createBulk = useServerFn(createBulkSecurityAssessments);
  const [partners, setPartners] = useState<Array<{ id: string; name: string }>>([]);
  const [partnerId, setPartnerId] = useState("");
  const [cycle, setCycle] = useState<"quarterly" | "bi_annual" | "annual" | "one_off">("quarterly");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listPartners().then((result) => {
      const rows = (result.partners ?? []) as Array<{ id: string; name: string }>;
      setPartners(rows);
      setPartnerId((current) => current || rows[0]?.id || "");
    });
  }, [listPartners]);

  return <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="outline"><ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Activate pentest</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Activate security partner testing?</AlertDialogTitle><AlertDialogDescription>Creates separated penetration-testing records for {ids.length} selected clone{ids.length === 1 ? "" : "s"}. Partner visibility remains limited to these cycles.</AlertDialogDescription></AlertDialogHeader><div className="grid gap-3 py-2"><div className="space-y-1"><Label>Security partner</Label><Select value={partnerId} onValueChange={setPartnerId}><SelectTrigger><SelectValue placeholder="Select partner" /></SelectTrigger><SelectContent>{partners.map((partner) => <SelectItem key={partner.id} value={partner.id}>{partner.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1"><Label>Testing cycle</Label><Select value={cycle} onValueChange={(value) => setCycle(value as typeof cycle)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="quarterly">Quarterly</SelectItem><SelectItem value="bi_annual">Bi-annual</SelectItem><SelectItem value="annual">Annual</SelectItem><SelectItem value="one_off">One-off</SelectItem></SelectContent></Select></div></div><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={async (event) => { event.preventDefault(); if (!partnerId) return toast.error("Choose a partner first"); setBusy(true); try { const result = await createBulk({ data: { partnerId, cloneIds: ids, cycle, retestRequired: true } }); toast.success(`Created ${(result.created as unknown[]).length} security cycle(s)`); if ((result.skipped as unknown[]).length) toast.info(`${(result.skipped as unknown[]).length} clone(s) already had active cycles`); onDone(); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not activate testing"); } finally { setBusy(false); } }} disabled={busy}>Activate</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

function BulkPauseButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const fn = useServerFn(bulkPauseClones);
  const [busy, setBusy] = useState(false);
  return <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); const result = await fn({ data: { cloneIds: ids, pause: true } }); setBusy(false); if (result.ok) { toast.success(`Paused ${result.count} clone${result.count === 1 ? "" : "s"}`); onDone(); } else toast.error("Pause failed"); }}><PauseCircle className="mr-1.5 h-3.5 w-3.5" /> Pause</Button>;
}

function BulkReprovisionButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const fn = useServerFn(bulkReprovisionBackends);
  const [busy, setBusy] = useState(false);
  return <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); const result = await fn({ data: { cloneIds: ids } }); setBusy(false); if (result.ok) { toast.success(`Re-queued ${result.count} backend${result.count === 1 ? "" : "s"}`); onDone(); } else toast.error(result.error ?? "Reprovision failed"); }}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reprovision</Button>;
}

function BulkDeleteButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const fn = useServerFn(bulkDeleteClones);
  const [busy, setBusy] = useState(false);
  return <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="destructive" disabled={busy}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {ids.length} clone{ids.length === 1 ? "" : "s"}?</AlertDialogTitle><AlertDialogDescription>This permanently removes the clone records and related Mission Control metadata. The underlying GitHub repos and backends are NOT affected.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={async () => { setBusy(true); const result = await fn({ data: { cloneIds: ids } }); setBusy(false); if (result.ok) { const okCount = result.results.filter((row) => row.ok).length; toast.success(`Deleted ${okCount}/${ids.length}`); onDone(); } else toast.error("Delete failed"); }}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}