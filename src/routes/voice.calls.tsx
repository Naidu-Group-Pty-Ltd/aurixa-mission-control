// Call Logs — the voice-operation monitor, replicating the prime repo's Call
// Logs page: stat plane, filters, the log itself, live monitor, negative-call
// review, blacklist, alert rules and analytics.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { ListPager } from "@/components/list-pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { callStats, exportCalls, listCalls, listCallTags, getFleet } from "@/lib/voice.functions";
import { CALL_INTENTS, formatDuration, INTENT_LABELS } from "@/lib/voice-vocab";
import { callSpine, OutcomeStatus, SentimentStatus } from "@/components/voice/tone";
import { CallDetailDialog } from "@/components/voice/call-detail-dialog";
import { LiveMonitor } from "@/components/voice/live-monitor";
import { IssuesPanel } from "@/components/voice/issues-panel";
import { BlacklistPanel } from "@/components/voice/blacklist-panel";
import { AlertsPanel } from "@/components/voice/alerts-panel";
import { AnalyticsPanel } from "@/components/voice/analytics-panel";
import { exportRowsAsCSV } from "@/lib/csv";
import { Download, PhoneIncoming, PhoneOutgoing, RefreshCw, Phone } from "lucide-react";

export const Route = createFileRoute("/voice/calls")({
  component: () => (
    <ProtectedRoute>
      <VoiceCallsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Call Logs — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Every inbound and outbound voice-agent call: live monitor, transcripts, recordings, sentiment, squad handoffs, blacklist and alerts.",
      },
      { property: "og:title", content: "Call Logs — Aurixa Mission Control" },
      {
        property: "og:description",
        content: "Monitor the whole voice-agent operation from one log.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const PAGE_SIZE = 50;

type Filters = {
  search: string;
  agentId: string;
  outcome: string;
  direction: "all" | "inbound" | "outbound";
  intent: string;
  squad: "all" | "squad" | "non-squad";
  tag: string;
  startDate: string;
  endDate: string;
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  agentId: "all",
  outcome: "all",
  direction: "all",
  intent: "all",
  squad: "all",
  tag: "all",
  startDate: "",
  endDate: "",
};

function quickRange(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60_000);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function VoiceCallsPage() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const [openCallId, setOpenCallId] = useState<string | null>(null);

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  const callsQ = useQuery({
    queryKey: ["voice", "calls", filters, page],
    queryFn: () => listCalls({ data: { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE } }),
  });
  const statsQ = useQuery({
    queryKey: ["voice", "stats", filters],
    queryFn: () => callStats({ data: filters }),
  });
  const fleetQ = useQuery({ queryKey: ["voice", "fleet"], queryFn: () => getFleet({ data: {} }) });
  const tagsQ = useQuery({
    queryKey: ["voice", "tags"],
    queryFn: () => listCallTags({ data: {} }),
  });

  const calls = callsQ.data?.calls ?? [];
  const total = callsQ.data?.total ?? 0;
  const s = statsQ.data;
  const agents = fleetQ.data?.agents ?? [];

  const filterActive = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  const doExport = async () => {
    const rows = await exportCalls({ data: filters });
    exportRowsAsCSV(
      `voice-calls-${format(new Date(), "yyyy-MM-dd")}.csv`,
      rows.map((r) => ({
        "Call ID": r.vapi_call_id,
        "Customer Name": r.customer_name ?? "",
        "Phone Number": r.phone_number ?? "",
        Agent: r.agent_name ?? "",
        Direction: r.call_direction ?? "",
        Outcome: r.call_outcome ?? "",
        Sentiment: r.sentiment ?? "",
        "Duration (s)": r.duration_seconds ?? "",
        Cost: r.cost ?? "",
        Squad: r.squad_name ?? "",
        Intent: r.call_intent ?? "",
        "Started At": r.started_at ?? "",
        Summary: r.summary ?? "",
      })),
    );
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="voice operations"
        title="Call Logs"
        description="Every call the voice agents take or make — live, transcribed, analysed and tied back to the client record."
        actions={
          <>
            <Button variant="outline" onClick={doExport}>
              <Download className="mr-2 h-4 w-4" /> CSV
            </Button>
            <Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ["voice"] })}>
              <RefreshCw className="mr-2 h-4 w-4" /> Refresh
            </Button>
          </>
        }
      />

      <div className="glass grid grid-cols-3 overflow-hidden sm:grid-cols-5 lg:grid-cols-9">
        <MetricCell label="total" value={s?.total ?? "—"} />
        <MetricCell label="done" value={s?.completed ?? "—"} />
        <MetricCell label="rate" value={s ? `${s.successRate}%` : "—"} size="sm" />
        <MetricCell label="avg" value={s ? formatDuration(s.avgDurationSeconds) : "—"} size="sm" />
        <MetricCell label="cost" value={s ? `$${s.totalCost.toFixed(2)}` : "—"} size="sm" />
        <MetricCell label="inbound" value={s?.inbound ?? "—"} />
        <MetricCell label="outbound" value={s?.outbound ?? "—"} />
        <MetricCell label="voicemail" value={s?.voicemail ?? "—"} />
        <MetricCell
          label="negative"
          value={s?.negative ?? "—"}
          tone="destructive"
          alarm={(s?.negative ?? 0) > 0}
        />
      </div>

      <Tabs defaultValue="logs">
        <TabsList className="flex-wrap">
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="issues">Issues</TabsTrigger>
          <TabsTrigger value="blacklist">Blacklist</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="squads">Squad Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="logs" className="space-y-4">
          <div className="glass flex flex-wrap items-center gap-2 p-3">
            <Input
              className="w-56"
              placeholder="Search name, phone, summary…"
              value={filters.search}
              onChange={(e) => set({ search: e.target.value })}
            />
            <Select value={filters.agentId} onValueChange={(v) => set({ agentId: v })}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.vapi_assistant_id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.direction}
              onValueChange={(v) => set({ direction: v as Filters["direction"] })}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Both directions</SelectItem>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.squad}
              onValueChange={(v) => set({ squad: v as Filters["squad"] })}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All call types</SelectItem>
                <SelectItem value="squad">Squad calls</SelectItem>
                <SelectItem value="non-squad">Single agent</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.intent} onValueChange={(v) => set({ intent: v })}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All intents</SelectItem>
                {CALL_INTENTS.map((i) => (
                  <SelectItem key={i} value={i}>
                    {INTENT_LABELS[i]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.tag} onValueChange={(v) => set({ tag: v })}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tags</SelectItem>
                {(tagsQ.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => set(quickRange(1))}>
                Today
              </Button>
              <Button variant="ghost" size="sm" onClick={() => set(quickRange(7))}>
                7d
              </Button>
              <Button variant="ghost" size="sm" onClick={() => set(quickRange(30))}>
                30d
              </Button>
            </div>
            {filterActive && (
              <Button variant="ghost" size="sm" onClick={() => set(DEFAULT_FILTERS)}>
                Clear all
              </Button>
            )}
          </div>

          {!callsQ.isLoading && calls.length === 0 && (
            <EmptyState
              icon={<Phone className="h-6 w-6" />}
              title="No calls yet"
              description="Calls appear here as soon as the VAPI webhook is pointed at this deployment."
            />
          )}

          <div className="space-y-2">
            {calls.map((c) => {
              const handoffs = Array.isArray(c.handoff_sequence) ? c.handoff_sequence.length : 0;
              return (
                <RecordRow
                  key={c.id}
                  spine={callSpine(c)}
                  className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/30"
                  onClick={() => setOpenCallId(c.id)}
                >
                  {c.call_direction === "outbound" ? (
                    <PhoneOutgoing className="h-4 w-4 shrink-0 text-info" />
                  ) : (
                    <PhoneIncoming className="h-4 w-4 shrink-0 text-success" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {c.customer_name || c.phone_number || "Unknown caller"}
                      {c.is_squad_call && (
                        <Badge variant="secondary" className="ml-2">
                          {c.squad_name ?? "squad"}
                        </Badge>
                      )}
                      {c.call_intent && (
                        <Badge variant="outline" className="ml-1">
                          {INTENT_LABELS[c.call_intent] ?? c.call_intent}
                        </Badge>
                      )}
                      {handoffs > 0 && (
                        <Badge variant="outline" className="ml-1">
                          {handoffs} handoff{handoffs === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {c.phone_number ?? "—"} · {c.agent_name ?? c.agent_id ?? "—"}
                      {c.started_at && ` · ${format(new Date(c.started_at), "MMM d, h:mm a")}`}
                    </p>
                  </div>
                  {(c.tags ?? []).slice(0, 3).map((t: string) => (
                    <Badge key={t} variant="secondary" className="hidden lg:inline-flex">
                      {t}
                    </Badge>
                  ))}
                  <span className="numeral hidden text-xs text-muted-foreground sm:inline">
                    {formatDuration(c.duration_seconds)}
                  </span>
                  <span className="numeral hidden text-xs text-muted-foreground md:inline">
                    {c.cost != null ? `$${Number(c.cost).toFixed(3)}` : "—"}
                  </span>
                  <SentimentStatus sentiment={c.sentiment} />
                  <OutcomeStatus outcome={c.call_outcome} />
                </RecordRow>
              );
            })}
          </div>

          <ListPager
            page={page}
            pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
            onPage={setPage}
          />
        </TabsContent>

        <TabsContent value="live">
          <LiveMonitor />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesPanel onOpenCall={setOpenCallId} />
        </TabsContent>
        <TabsContent value="blacklist">
          <BlacklistPanel />
        </TabsContent>
        <TabsContent value="alerts">
          <AlertsPanel />
        </TabsContent>
        <TabsContent value="analytics">
          <AnalyticsPanel />
        </TabsContent>
        <TabsContent value="squads">
          <AnalyticsPanel squadOnly />
        </TabsContent>
      </Tabs>

      <CallDetailDialog callId={openCallId} onClose={() => setOpenCallId(null)} />
    </div>
  );
}
