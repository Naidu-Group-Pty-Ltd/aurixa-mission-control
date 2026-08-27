// Call detail — the six-tab modal from the prime repo's Call Logs page:
// Overview, Squad (conditional), Transcript, Tool Calls, Analysis, Metadata.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getCall, refreshRecordingUrl, updateCall } from "@/lib/voice.functions";
import {
  callQualityScore,
  formatDuration,
  outcomeLabel,
  RESOLUTION_STATUSES,
  ROOT_CAUSE_CATEGORIES,
} from "@/lib/voice-vocab";
import { MonoStatus, OutcomeStatus, SentimentStatus } from "@/components/voice/tone";
import { PhoneIncoming, PhoneOutgoing, RefreshCw } from "lucide-react";

type Rec = Record<string, any>;

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="-mt-px -ml-px border-t border-l border-border/50 px-4 py-3">
      <p className="label-mono text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function TranscriptChat({
  messages,
  transcript,
}: {
  messages: unknown;
  transcript: string | null;
}) {
  const rows = Array.isArray(messages)
    ? (messages as Rec[]).filter(
        (m) =>
          typeof m?.content === "string" &&
          (m.role === "user" || m.role === "assistant" || m.role === "bot"),
      )
    : [];
  if (rows.length === 0) {
    if (!transcript) {
      return <p className="text-sm text-muted-foreground">No transcript was captured.</p>;
    }
    return <pre className="text-sm whitespace-pre-wrap font-sans">{transcript}</pre>;
  }
  return (
    <div className="space-y-2">
      {rows.map((m, i) => {
        const isAgent = m.role !== "user";
        return (
          <div key={i} className={isAgent ? "pr-10" : "pl-10"}>
            <div className="glass-inset px-3 py-2">
              <p className="label-mono text-muted-foreground">{isAgent ? "agent" : "caller"}</p>
              <p className="mt-1 text-sm whitespace-pre-wrap">{m.content}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToolCallsView({ messages }: { messages: unknown }) {
  const calls = useMemo(() => {
    if (!Array.isArray(messages)) return [];
    const results = new Map<string, string>();
    for (const m of messages as Rec[]) {
      if (m?.role === "tool" && typeof m.tool_call_id === "string") {
        results.set(
          m.tool_call_id,
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        );
      }
    }
    const out: Array<{ id: string; name: string; args: string; result: string | null }> = [];
    for (const m of messages as Rec[]) {
      for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        const fn = tc?.function ?? {};
        out.push({
          id: tc?.id ?? `${out.length}`,
          name: fn.name ?? "unknown_tool",
          args:
            typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          result: results.get(tc?.id) ?? null,
        });
      }
    }
    return out;
  }, [messages]);

  if (calls.length === 0) {
    return <p className="text-sm text-muted-foreground">No tool calls on this call.</p>;
  }
  return (
    <div className="space-y-3">
      {calls.map((c) => (
        <div key={c.id} className="glass-inset px-3 py-2">
          <p className="font-mono text-sm">{c.name}</p>
          <p className="label-mono mt-2 text-muted-foreground">arguments</p>
          <pre className="mt-1 overflow-x-auto text-xs">{c.args}</pre>
          <p className="label-mono mt-2 text-muted-foreground">result</p>
          <pre className="mt-1 overflow-x-auto text-xs">{c.result ?? "(no result recorded)"}</pre>
        </div>
      ))}
    </div>
  );
}

export function CallDetailDialog({
  callId,
  onClose,
}: {
  callId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["voice", "call", callId],
    queryFn: () => getCall({ data: { id: callId! } }),
    enabled: Boolean(callId),
  });
  const call = q.data as Rec | undefined;
  const [notes, setNotes] = useState<string | null>(null);

  const refreshRecording = useMutation({
    mutationFn: () => refreshRecordingUrl({ data: { id: callId! } }),
    onSuccess: (r) => {
      if (r.url) qc.invalidateQueries({ queryKey: ["voice", "call", callId] });
      else toast.error("No recording is available for this call.");
    },
  });

  const saveReview = useMutation({
    mutationFn: (patch: {
      resolutionStatus?: (typeof RESOLUTION_STATUSES)[number];
      rootCauseCategory?: string | null;
      resolutionNotes?: string | null;
    }) => updateCall({ data: { id: callId!, ...patch } }),
    onSuccess: () => {
      toast.success("Review saved");
      qc.invalidateQueries({ queryKey: ["voice"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const quality = call
    ? callQualityScore({
        sentiment: call.sentiment,
        durationSeconds: call.duration_seconds,
        outcome: call.call_outcome,
        cost: call.cost != null ? Number(call.cost) : null,
        hasTranscript: Boolean(call.transcript),
      })
    : null;

  const handoffs = Array.isArray(call?.handoff_sequence) ? (call!.handoff_sequence as Rec[]) : [];
  const assistants = Array.isArray(call?.assistants_involved)
    ? (call!.assistants_involved as Rec[])
    : [];

  return (
    <Dialog open={Boolean(callId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            {call?.call_direction === "outbound" ? (
              <PhoneOutgoing className="h-4 w-4 text-info" />
            ) : (
              <PhoneIncoming className="h-4 w-4 text-success" />
            )}
            {call?.customer_name || call?.phone_number || "Call detail"}
            {call?.is_squad_call && <Badge variant="secondary">squad</Badge>}
          </DialogTitle>
        </DialogHeader>

        {q.isLoading && <p className="text-sm text-muted-foreground">Loading call…</p>}
        {call && (
          <Tabs defaultValue="overview">
            <TabsList className="flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {call.is_squad_call && <TabsTrigger value="squad">Squad</TabsTrigger>}
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="tools">Tool Calls</TabsTrigger>
              <TabsTrigger value="analysis">Analysis</TabsTrigger>
              <TabsTrigger value="metadata">Metadata</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
                <Cell label="customer">
                  {call.customer_name || "Unknown caller"}
                  <p className="font-mono text-xs text-muted-foreground">{call.phone_number}</p>
                </Cell>
                <Cell label="agent">
                  {call.agent_name || "—"}
                  {call.squad_name && (
                    <p className="text-xs text-muted-foreground">{call.squad_name}</p>
                  )}
                </Cell>
                <Cell label="outcome">
                  <OutcomeStatus outcome={call.call_outcome} />
                </Cell>
                <Cell label="sentiment">
                  <SentimentStatus sentiment={call.sentiment} /> {!call.sentiment && "—"}
                </Cell>
                <Cell label="started">
                  {call.started_at ? format(new Date(call.started_at), "PPpp") : "—"}
                </Cell>
                <Cell label="duration">
                  <span className="numeral">{formatDuration(call.duration_seconds)}</span>
                </Cell>
                <Cell label="cost">
                  <span className="numeral">
                    {call.cost != null ? `$${Number(call.cost).toFixed(4)}` : "—"}
                  </span>
                </Cell>
                <Cell label="quality">
                  <span className="numeral">{quality ? `${quality.total}/100` : "—"}</span>
                </Cell>
              </div>

              {call.summary && (
                <div className="glass-inset px-4 py-3">
                  <p className="label-mono text-muted-foreground">summary</p>
                  <p className="mt-1 text-sm">{call.summary}</p>
                </div>
              )}

              <div className="glass-inset px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="label-mono text-muted-foreground">recording</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refreshRecording.mutate()}
                    disabled={refreshRecording.isPending}
                  >
                    <RefreshCw className="mr-1 h-3 w-3" /> Refresh link
                  </Button>
                </div>
                {call.recording_url ? (
                  // VAPI recording links expire; the refresh button re-signs.
                  <audio className="mt-2 w-full" controls src={call.recording_url} />
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">No recording stored.</p>
                )}
              </div>
            </TabsContent>

            {call.is_squad_call && (
              <TabsContent value="squad" className="space-y-4">
                <div className="glass grid grid-cols-2 overflow-hidden">
                  <Cell label="intent">{call.call_intent ?? "—"}</Cell>
                  <Cell label="handoffs">
                    <span className="numeral">{handoffs.length}</span>
                  </Cell>
                </div>
                {assistants.length > 0 && (
                  <div className="glass-inset px-4 py-3">
                    <p className="label-mono text-muted-foreground">assistants involved</p>
                    <ol className="mt-1 list-decimal pl-5 text-sm">
                      {assistants.map((a, i) => (
                        <li key={i}>
                          {a.name ?? a.id ?? "unknown"}{" "}
                          {a.role && <span className="text-muted-foreground">({a.role})</span>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {handoffs.length > 0 && (
                  <div className="glass-inset px-4 py-3">
                    <p className="label-mono text-muted-foreground">handoff sequence</p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {handoffs.map((h, i) => (
                        <li key={i} className="font-mono text-xs">
                          {(h.from ?? h.fromAssistant ?? "?") +
                            " → " +
                            (h.to ?? h.toAssistant ?? "?")}
                          {h.timestamp && (
                            <span className="text-muted-foreground"> · {h.timestamp}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {Array.isArray(call.structured_data_multi) &&
                  call.structured_data_multi.length > 0 && (
                    <div className="glass-inset px-4 py-3">
                      <p className="label-mono text-muted-foreground">collected data</p>
                      <pre className="mt-1 overflow-x-auto text-xs">
                        {JSON.stringify(call.structured_data_multi, null, 2)}
                      </pre>
                    </div>
                  )}
              </TabsContent>
            )}

            <TabsContent value="transcript">
              <TranscriptChat messages={call.artifact_messages} transcript={call.transcript} />
            </TabsContent>

            <TabsContent value="tools">
              <ToolCallsView messages={call.artifact_messages} />
            </TabsContent>

            <TabsContent value="analysis" className="space-y-4">
              {quality && (
                <div className="glass grid grid-cols-5 overflow-hidden">
                  <Cell label="sentiment /30">
                    <span className="numeral">{quality.sentiment}</span>
                  </Cell>
                  <Cell label="duration /25">
                    <span className="numeral">{quality.duration}</span>
                  </Cell>
                  <Cell label="outcome /30">
                    <span className="numeral">{quality.outcome}</span>
                  </Cell>
                  <Cell label="cost /10">
                    <span className="numeral">{quality.cost}</span>
                  </Cell>
                  <Cell label="data /5">
                    <span className="numeral">{quality.data}</span>
                  </Cell>
                </div>
              )}
              {Array.isArray(call.key_topics) && call.key_topics.length > 0 && (
                <div className="glass-inset px-4 py-3">
                  <p className="label-mono text-muted-foreground">key topics</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {call.key_topics.map((t: string) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {Array.isArray(call.action_items) && call.action_items.length > 0 && (
                <div className="glass-inset px-4 py-3">
                  <p className="label-mono text-muted-foreground">action items</p>
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {call.action_items.map((a: string, i: number) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {Array.isArray(call.ai_recommendations) && call.ai_recommendations.length > 0 && (
                <div className="glass-inset px-4 py-3">
                  <p className="label-mono text-muted-foreground">recommendations</p>
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {call.ai_recommendations.map((a: string, i: number) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rule-top space-y-3 pt-3">
                <p className="label-mono text-muted-foreground">review</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={call.resolution_status ?? "needs_review"}
                    onValueChange={(v) =>
                      saveReview.mutate({
                        resolutionStatus: v as (typeof RESOLUTION_STATUSES)[number],
                      })
                    }
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RESOLUTION_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={call.root_cause_category ?? "none"}
                    onValueChange={(v) =>
                      saveReview.mutate({ rootCauseCategory: v === "none" ? null : v })
                    }
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="root cause" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">no root cause</SelectItem>
                      {ROOT_CAUSE_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {call.escalation_severity != null && (
                    <MonoStatus
                      label={`escalation ${call.escalation_severity}/5`}
                      tone={call.escalation_severity >= 4 ? "destructive" : "warning"}
                    />
                  )}
                </div>
                <Textarea
                  placeholder="Resolution notes"
                  value={notes ?? call.resolution_notes ?? ""}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => {
                    if (notes !== null && notes !== (call.resolution_notes ?? "")) {
                      saveReview.mutate({ resolutionNotes: notes });
                    }
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="metadata">
              <pre className="overflow-x-auto text-xs">
                {JSON.stringify(
                  { vapi_call_id: call.vapi_call_id, ...((call.metadata as Rec) ?? {}) },
                  null,
                  2,
                )}
              </pre>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { outcomeLabel };
