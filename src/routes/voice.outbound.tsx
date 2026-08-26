// Outbound Queue — every scheduled dial, live in the dispatch pipeline. Jobs
// arrive from client-journey triggers (or an operator's manual call) and are
// placed by the per-minute dispatcher.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  cancelOutboundJob,
  createManualCall,
  listOutboundJobs,
  OUTBOUND_STATUSES,
  retryOutboundJob,
} from "@/lib/voice-outbound.functions";
import { getFleet } from "@/lib/voice.functions";
import { MonoStatus } from "@/components/voice/tone";
import { PhoneOutgoing, RotateCcw, X } from "lucide-react";

export const Route = createFileRoute("/voice/outbound")({
  component: () => (
    <ProtectedRoute>
      <OutboundQueuePage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Outbound Queue — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Scheduled outbound voice calls: follow-ups, reminders and no-show rebooks queued by the client journey and dispatched to VAPI.",
      },
      { property: "og:title", content: "Outbound Queue — Aurixa Mission Control" },
      { property: "og:description", content: "The dispatch pipeline for outbound voice calls." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const STATUS_SPINE: Record<string, SpineTone> = {
  pending: "idle",
  dispatching: "live",
  dispatched: "live",
  completed: "ok",
  failed: "bad",
  canceled: "idle",
  expired: "warn",
};

const STATUS_TONE = {
  pending: "neutral",
  dispatching: "info",
  dispatched: "info",
  completed: "success",
  failed: "destructive",
  canceled: "neutral",
  expired: "warning",
} as const;

function OutboundQueuePage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>("all");
  const q = useQuery({
    queryKey: ["voice", "outbound", status],
    queryFn: () => listOutboundJobs({ data: { status: status as never } }),
    refetchInterval: 15000,
  });
  const fleetQ = useQuery({ queryKey: ["voice", "fleet"], queryFn: () => getFleet({ data: {} }) });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelOutboundJob({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voice", "outbound"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const retry = useMutation({
    mutationFn: (id: string) => retryOutboundJob({ data: { id } }),
    onSuccess: () => {
      toast.success("Job requeued for immediate dispatch");
      qc.invalidateQueries({ queryKey: ["voice", "outbound"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const jobs = q.data ?? [];
  const counts = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="voice operations"
        title="Outbound Queue"
        description="Every scheduled dial: opt-in follow-ups, quiz follow-ups, nurture calls, appointment reminders and no-show rebooks — queued by the client journey, placed by the dispatcher."
        actions={<ManualCallDialog />}
      />

      <div className="glass grid grid-cols-3 overflow-hidden sm:grid-cols-6">
        <MetricCell label="pending" value={counts.pending ?? 0} />
        <MetricCell
          label="in flight"
          value={(counts.dispatching ?? 0) + (counts.dispatched ?? 0)}
        />
        <MetricCell label="completed" value={counts.completed ?? 0} />
        <MetricCell
          label="failed"
          value={counts.failed ?? 0}
          tone="destructive"
          alarm={(counts.failed ?? 0) > 0}
        />
        <MetricCell label="expired" value={counts.expired ?? 0} />
        <MetricCell label="canceled" value={counts.canceled ?? 0} />
      </div>

      <div className="flex justify-end">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {OUTBOUND_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!q.isLoading && jobs.length === 0 && (
        <EmptyState
          icon={<PhoneOutgoing className="h-6 w-6" />}
          title="No outbound jobs"
          description="Jobs are queued automatically when the client journey fires a trigger."
        />
      )}

      <div className="space-y-2">
        {jobs.map((j) => {
          const contact = j.crm_contacts as unknown as {
            first_name: string;
            last_name: string | null;
          } | null;
          const account = j.crm_accounts as unknown as { name: string } | null;
          const who =
            [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") ||
            account?.name ||
            j.phone;
          const scheduled = new Date(j.scheduled_at);
          const future = scheduled.getTime() > Date.now();
          return (
            <RecordRow
              key={j.id}
              spine={STATUS_SPINE[j.status] ?? "idle"}
              className="flex items-center gap-3 px-4 py-3"
            >
              <PhoneOutgoing className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {who}
                  <Badge variant="secondary" className="ml-2">
                    {j.trigger_type.replace(/_/g, " ")}
                  </Badge>
                  {j.attempts > 1 && (
                    <Badge variant="outline" className="ml-1">
                      attempt {j.attempts}/{j.max_attempts}
                    </Badge>
                  )}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {j.phone} · {future ? "dials" : "was due"}{" "}
                  {formatDistanceToNow(scheduled, { addSuffix: true })} ·{" "}
                  {format(scheduled, "MMM d, h:mm a")}
                  {j.last_error && ` · ${j.last_error}`}
                </p>
              </div>
              <MonoStatus
                label={j.status}
                tone={STATUS_TONE[j.status as keyof typeof STATUS_TONE] ?? "neutral"}
                pulse={j.status === "dispatching" || j.status === "dispatched"}
              />
              {["pending", "dispatching"].includes(j.status) && (
                <Button variant="ghost" size="sm" onClick={() => cancel.mutate(j.id)}>
                  <X className="h-3 w-3" />
                </Button>
              )}
              {["failed", "expired", "canceled"].includes(j.status) && (
                <Button variant="ghost" size="sm" onClick={() => retry.mutate(j.id)}>
                  <RotateCcw className="h-3 w-3" />
                </Button>
              )}
            </RecordRow>
          );
        })}
      </div>
    </div>
  );

  function ManualCallDialog() {
    const [open, setOpen] = useState(false);
    const [phone, setPhone] = useState("");
    const [assistant, setAssistant] = useState("");
    const [fullName, setFullName] = useState("");
    const agents = (fleetQ.data?.agents ?? []).filter((a) => a.is_active);

    const create = useMutation({
      mutationFn: () =>
        createManualCall({
          data: {
            phone,
            vapiAssistantId: assistant,
            fullName: fullName || null,
          },
        }),
      onSuccess: () => {
        toast.success("Call queued for immediate dispatch");
        setOpen(false);
        setPhone("");
        setFullName("");
        qc.invalidateQueries({ queryKey: ["voice", "outbound"] });
      },
      onError: (e: Error) => toast.error(e.message),
    });

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>
            <PhoneOutgoing className="mr-2 h-4 w-4" /> Call now
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Place an outbound call</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="+61…" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Input
              placeholder="Customer name (optional)"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Select value={assistant} onValueChange={setAssistant}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.vapi_assistant_id} value={a.vapi_assistant_id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="w-full"
              disabled={!phone.trim() || !assistant || create.isPending}
              onClick={() => create.mutate()}
            >
              Queue the call
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
}
