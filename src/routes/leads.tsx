// @ts-nocheck
// Waitlist lead capture console.
//
// Every lead captured by the Aurixa Systems landing-page waitlist form lands
// in `waitlist_leads` (via /api/public/leads/capture) and shows up here:
// full history with filters + triage, live-updating via Supabase realtime so
// a new lead appears (with a toast) the moment the CTA fires on the website.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
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
import {
  UserPlus,
  Users,
  Filter,
  X,
  Inbox,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Mail,
  Phone,
  Building2,
  Globe,
  CalendarClock,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { RefreshButton } from "@/components/refresh-button";
import { toast } from "sonner";

type Lead = Database["public"]["Tables"]["waitlist_leads"]["Row"];
type LeadStatus = Database["public"]["Enums"]["lead_status"];

const PAGE_SIZE = 25;

const STATUS_VALUES = [
  "all",
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
] as const;

const STATUS_OPTIONS: { value: (typeof STATUS_VALUES)[number]; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "disqualified", label: "Disqualified" },
  { value: "converted", label: "Converted" },
];

// Mirrors the waitlist form's "Entity Classification" select on the website.
const CLASSIFICATION_LABELS: Record<string, string> = {
  buyers_agent: "Buyers Agency",
  property_advisory: "Property Advisory Firm",
  real_estate_agency: "Real Estate Agency",
  mortgage_finance: "Mortgage & Finance Business",
  wealth_advisor: "Wealth Management Firm",
  financial_planner: "Financial Planning Office",
  investment_group: "Investment Group",
  developer: "Developer",
  enterprise: "Enterprise Aggregate",
  enterprise_property_network: "Enterprise Property Network",
};

// Mirrors the form's "Annual Origination / Transaction Volume" brackets.
const VOLUME_LABELS: Record<string, string> = {
  tier_1: "Under $50M",
  tier_2: "$50M – $150M",
  tier_3: "$150M – $500M",
  tier_4: "$500M+",
};

const CLASSIFICATION_VALUES = ["all", ...Object.keys(CLASSIFICATION_LABELS)] as const;
const VOLUME_VALUES = ["all", ...Object.keys(VOLUME_LABELS)] as const;

const searchSchema = z.object({
  status: fallback(z.enum(STATUS_VALUES), "all").default("all"),
  classification: fallback(z.string(), "all").default("all"),
  volume: fallback(z.string(), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  page: fallback(z.number().int().min(0).max(10_000), 0).default(0),
});

export const Route = createFileRoute("/leads")({
  errorComponent: RouteError,
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <LeadsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Leads — Aurixa Systems Mission Control" }] }),
});

function statusTone(status: LeadStatus): string {
  switch (status) {
    case "new":
      return "border-primary/40 text-primary";
    case "contacted":
      return "border-info/40 text-info";
    case "qualified":
      return "border-success/40 text-success";
    case "converted":
      return "border-accent/40 text-accent";
    case "disqualified":
      return "border-muted-foreground/40 text-muted-foreground";
  }
}

function classificationLabel(value: string | null): string {
  if (!value) return "—";
  return CLASSIFICATION_LABELS[value] ?? value.replace(/_/g, " ");
}

function volumeLabel(value: string | null): string {
  if (!value) return "—";
  return VOLUME_LABELS[value] ?? value.replace(/_/g, " ");
}

type Stats = { total: number; last24h: number; last7d: number; untriaged: number };

function LeadsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/leads" });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const loadStats = useCallback(async () => {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [totalQ, dayQ, weekQ, newQ] = await Promise.all([
      supabase.from("waitlist_leads").select("id", { count: "exact", head: true }),
      supabase
        .from("waitlist_leads")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayAgo),
      supabase
        .from("waitlist_leads")
        .select("id", { count: "exact", head: true })
        .gte("created_at", weekAgo),
      supabase
        .from("waitlist_leads")
        .select("id", { count: "exact", head: true })
        .eq("status", "new"),
    ]);
    setStats({
      total: totalQ.count ?? 0,
      last24h: dayQ.count ?? 0,
      last7d: weekQ.count ?? 0,
      untriaged: newQ.count ?? 0,
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const from = search.page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    let q = supabase
      .from("waitlist_leads")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    if (search.status !== "all") q = q.eq("status", search.status);
    if (search.classification !== "all") q = q.eq("entity_classification", search.classification);
    if (search.volume !== "all") q = q.eq("transaction_volume", search.volume);
    if (search.q) {
      const term = search.q.replace(/[%_,()]/g, " ").trim();
      if (term) {
        q = q.or(
          `first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,entity_name.ilike.%${term}%`,
        );
      }
    }
    const { data, count } = await q;
    setLeads(data ?? []);
    setTotal(count ?? 0);
    setLoading(false);
    setLastUpdated(new Date());
    void loadStats();
  }, [search.status, search.classification, search.volume, search.q, search.page, loadStats]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live tie-up: a new lead captured on the website appears here instantly.
  useEffect(() => {
    const channel = supabase
      .channel(`leads:page:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "waitlist_leads" },
        (payload) => {
          const lead = payload.new as Lead;
          toast.success(`New waitlist lead: ${lead.first_name} ${lead.last_name}`, {
            description: `${lead.entity_name ?? "Unknown entity"} · ${lead.email}`,
          });
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "waitlist_leads" },
        () => void refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const setStatus = async (lead: Lead, status: LeadStatus) => {
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, status } : l)));
    const { error } = await supabase.from("waitlist_leads").update({ status }).eq("id", lead.id);
    if (error) {
      toast.error("Failed to update lead status", { description: error.message });
      void refresh();
    } else {
      void loadStats();
    }
  };

  const exportCsv = async () => {
    let q = supabase
      .from("waitlist_leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (search.status !== "all") q = q.eq("status", search.status);
    if (search.classification !== "all") q = q.eq("entity_classification", search.classification);
    if (search.volume !== "all") q = q.eq("transaction_volume", search.volume);
    const { data, error } = await q;
    if (error) {
      toast.error("Export failed", { description: error.message });
      return;
    }
    const header = [
      "created_at",
      "submitted_at",
      "first_name",
      "last_name",
      "email",
      "mobile_number",
      "entity_name",
      "entity_classification",
      "transaction_volume",
      "status",
      "source",
      "page",
      "tech_stack_bottlenecks",
    ];
    const csv = [header.join(",")]
      .concat(
        (data ?? []).map((r) =>
          header
            .map((k) => `"${String((r as Record<string, unknown>)[k] ?? "").replace(/"/g, '""')}"`)
            .join(","),
        ),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `waitlist-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const hasFilters =
    search.status !== "all" ||
    search.classification !== "all" ||
    search.volume !== "all" ||
    search.q.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clearFilters = () =>
    navigate({
      search: () => ({ status: "all", classification: "all", volume: "all", q: "", page: 0 }),
      replace: true,
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
            <UserPlus className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
              lead capture
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Waitlist Leads</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every lead captured by the Aurixa Systems waitlist form — live, with full history.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
          <RefreshButton onRefresh={refresh} loading={loading} lastUpdated={lastUpdated} />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={Users} label="Total leads" value={stats?.total} />
        <StatTile icon={Sparkles} label="Last 24 hours" value={stats?.last24h} accent />
        <StatTile icon={CalendarClock} label="Last 7 days" value={stats?.last7d} />
        <StatTile icon={Inbox} label="Awaiting triage" value={stats?.untriaged} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <Select
            value={search.status}
            onValueChange={(v) => updateFilter({ status: v as typeof search.status })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.classification}
            onValueChange={(v) => updateFilter({ classification: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All segments" />
            </SelectTrigger>
            <SelectContent>
              {CLASSIFICATION_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v === "all" ? "All segments" : CLASSIFICATION_LABELS[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={search.volume} onValueChange={(v) => updateFilter({ volume: v })}>
            <SelectTrigger>
              <SelectValue placeholder="All volume brackets" />
            </SelectTrigger>
            <SelectContent>
              {VOLUME_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v === "all" ? "All volume brackets" : VOLUME_LABELS[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Input
              placeholder="Search name, email, entity…"
              value={search.q}
              onChange={(e) => updateFilter({ q: e.target.value })}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-7 -translate-y-1/2 px-2"
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
            {total.toLocaleString()} {total === 1 ? "lead" : "leads"}
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
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-md bg-muted/40" />
              ))}
            </div>
          ) : leads.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Inbox />}
                title="No leads yet"
                description={
                  hasFilters
                    ? "Nothing matches these filters. Try clearing them to see all captured leads."
                    : "Leads captured by the website waitlist form will appear here the moment they come in."
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {leads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  expanded={expandedId === lead.id}
                  onToggle={() => setExpandedId((cur) => (cur === lead.id ? null : lead.id))}
                  onStatusChange={(status) => void setStatus(lead, status)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: number | undefined;
  accent?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md ring-1",
            accent ? "bg-accent/15 ring-accent/40" : "bg-primary/15 ring-primary/40",
          )}
        >
          <Icon className={cn("h-4 w-4", accent ? "text-accent" : "text-primary")} />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold tabular-nums tracking-tight">
            {value === undefined ? "—" : value.toLocaleString()}
          </div>
          <div className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LeadRow({
  lead,
  expanded,
  onToggle,
  onStatusChange,
}: {
  lead: Lead;
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (status: LeadStatus) => void;
}) {
  const meta = (lead.metadata ?? {}) as Record<string, unknown>;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {lead.first_name} {lead.last_name}
              </span>
              {lead.entity_classification && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  {classificationLabel(lead.entity_classification)}
                </Badge>
              )}
              {lead.transaction_volume && (
                <Badge
                  variant="outline"
                  className="border-accent/40 text-[10px] uppercase text-accent"
                >
                  {volumeLabel(lead.transaction_volume)}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {lead.entity_name ?? "—"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" /> {lead.email}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider">
                {formatDistanceToNow(lead.created_at)}
              </span>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className={cn("text-[10px] uppercase", statusTone(lead.status))}>
            {lead.status}
          </Badge>
          <ConvertLeadButton lead={lead} />
          <Select value={lead.status} onValueChange={(v) => onStatusChange(v as LeadStatus)}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.filter((o) => o.value !== "all").map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

      </div>

      {expanded && (
        <div className="ml-6 mt-3 space-y-3 rounded-md border border-border/60 bg-surface p-3">
          <div className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <DetailItem icon={Phone} label="Mobile" value={lead.mobile_number ?? "—"} />
            <DetailItem
              icon={Globe}
              label="Source"
              value={`${lead.source}${lead.page ? ` · ${lead.page}` : ""}`}
            />
            <DetailItem
              icon={CalendarClock}
              label="Submitted"
              value={
                lead.submitted_at ? new Date(lead.submitted_at).toLocaleString() : "not reported"
              }
            />
            <DetailItem
              icon={Sparkles}
              label="Channel"
              value={typeof meta.channel === "string" ? meta.channel.replace(/_/g, " ") : "—"}
            />
          </div>
          {lead.tech_stack_bottlenecks && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Current tech stack bottlenecks
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground/90">
                {lead.tech_stack_bottlenecks}
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DetailItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-foreground/90">{value}</span>
    </div>
  );
}
