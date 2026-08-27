// Client Journey — the client-lifecycle tracker, modelled on the prime repo's
// Client Tracker pipeline and wired so that stage transitions and appointment
// outcomes are what queue outbound voice calls.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  APPOINTMENT_KINDS,
  createAppointment,
  getJourney,
  journeyBoard,
  listAppointments,
  listContactsWithoutJourney,
  recordNurtureSignal,
  setAppointmentStatus,
  startJourney,
  transitionStage,
  updateJourney,
} from "@/lib/crm-journey.functions";
import { outcomeLabel } from "@/lib/voice-vocab";
import { MonoStatus } from "@/components/voice/tone";
import { CalendarClock, PhoneCall, Route as RouteIcon, UserPlus } from "lucide-react";

export const Route = createFileRoute("/crm/journey")({
  component: () => (
    <ProtectedRoute>
      <JourneyPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Client Journey — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "The client-lifecycle tracker: pipeline stages, follow-ups and appointments, each transition driving the outbound voice agents.",
      },
      { property: "og:title", content: "Client Journey — Aurixa Mission Control" },
      {
        property: "og:description",
        content: "Track every client through the pipeline that triggers the voice agents.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Rec = Record<string, any>;

function contactName(j: Rec): string {
  const c = j.crm_contacts as Rec | null;
  return [c?.first_name, c?.last_name].filter(Boolean).join(" ") || "Unnamed contact";
}

function dialToast(dial: Rec | null | undefined) {
  if (!dial) return;
  if (dial.queued) {
    toast.success(
      `Outbound call queued for ${format(new Date(dial.scheduledAt), "MMM d, h:mm a")}`,
    );
  } else if (dial.reason && !["no_rule", "rule_disabled"].includes(dial.reason)) {
    toast.info(`No call queued (${String(dial.reason).replace(/_/g, " ")})`);
  }
}

function JourneyPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [openJourneyId, setOpenJourneyId] = useState<string | null>(null);

  const boardQ = useQuery({
    queryKey: ["journey", "board", search],
    queryFn: () => journeyBoard({ data: { search } }),
  });

  const stages = boardQ.data?.stages ?? [];
  const journeys = (boardQ.data?.journeys ?? []) as Rec[];

  const move = useMutation({
    mutationFn: (input: { journeyId: string; toStage: string }) => transitionStage({ data: input }),
    onSuccess: (r) => {
      dialToast(r.dial as Rec | null);
      qc.invalidateQueries({ queryKey: ["journey"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const followUpsDue = journeys.filter(
    (j) => j.follow_up_at && new Date(j.follow_up_at) <= new Date(),
  ).length;
  const active = journeys.filter((j) => {
    const stage = stages.find((s) => s.key === j.stage_key);
    return stage && !stage.is_terminal;
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="client lifecycle"
        title="Client Journey"
        description="The pipeline that runs the voice operation: moving a client, booking a session or marking a no-show is what queues the next call."
        actions={<StartJourneyDialog />}
      />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <MetricCell label="on the board" value={journeys.length} />
        <MetricCell label="active" value={active.length} />
        <MetricCell
          label="follow-ups due"
          value={followUpsDue}
          tone="warning"
          alarm={followUpsDue > 0}
        />
        <MetricCell label="do not call" value={journeys.filter((j) => j.do_not_call).length} />
      </div>

      <Tabs defaultValue="board">
        <TabsList>
          <TabsTrigger value="board">Pipeline</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="space-y-4">
          <Input
            className="max-w-sm"
            placeholder="Search clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {!boardQ.isLoading && journeys.length === 0 && (
            <EmptyState
              icon={<RouteIcon className="h-6 w-6" />}
              title="Nobody on the board yet"
              description="Start a journey for a CRM contact, or let the inbound agent create one from a call."
            />
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {stages.map((stage) => {
              const inStage = journeys.filter((j) => j.stage_key === stage.key);
              return (
                <div key={stage.key} className="glass p-4">
                  <div className="flex items-baseline justify-between">
                    <p className="label-mono text-muted-foreground">{stage.name}</p>
                    <span className="numeral text-sm">{inStage.length}</span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {inStage.map((j) => {
                      const overdue = j.follow_up_at && new Date(j.follow_up_at) <= new Date();
                      return (
                        <RecordRow
                          key={j.id}
                          spine={
                            j.do_not_call
                              ? "idle"
                              : overdue
                                ? "warn"
                                : stage.is_terminal
                                  ? stage.key === "live"
                                    ? "ok"
                                    : "bad"
                                  : "live"
                          }
                          className="cursor-pointer px-3 py-2 hover:bg-muted/30"
                          onClick={() => setOpenJourneyId(j.id)}
                        >
                          <p className="truncate text-sm font-medium">{contactName(j)}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {(j.crm_contacts as Rec | null)?.phone ?? "no phone"}
                            {j.calls_total > 0 && ` · ${j.calls_total} calls`}
                            {j.last_call_outcome && ` · ${outcomeLabel(j.last_call_outcome)}`}
                          </p>
                          {overdue && (
                            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
                              follow-up due
                            </p>
                          )}
                          <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                            <Select
                              value={j.stage_key}
                              onValueChange={(v) => move.mutate({ journeyId: j.id, toStage: v })}
                            >
                              <SelectTrigger className="h-7 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {stages.map((s) => (
                                  <SelectItem key={s.key} value={s.key}>
                                    {s.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </RecordRow>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="appointments">
          <AppointmentsPanel />
        </TabsContent>
      </Tabs>

      <JourneyDetailDialog journeyId={openJourneyId} onClose={() => setOpenJourneyId(null)} />
    </div>
  );
}

function StartJourneyDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["journey", "candidates", search],
    queryFn: () => listContactsWithoutJourney({ data: { search } }),
    enabled: open,
  });

  const start = useMutation({
    mutationFn: (contactId: string) => startJourney({ data: { contactId } }),
    onSuccess: () => {
      toast.success(
        "Journey started — the questionnaire follow-up call is queued if the cadence is enabled.",
      );
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["journey"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="mr-2 h-4 w-4" /> Start a journey
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Put a contact on the board</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Search CRM contacts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {(q.data ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              className="glass-inset block w-full px-3 py-2 text-left hover:bg-muted/30"
              onClick={() => start.mutate(c.id)}
            >
              <p className="text-sm font-medium">
                {[c.first_name, c.last_name].filter(Boolean).join(" ")}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {c.phone ?? "no phone"} {c.email && `· ${c.email}`}
              </p>
            </button>
          ))}
          {!q.isLoading && (q.data ?? []).length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              Every matching contact is already on the board.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const KIND_LABELS: Record<string, string> = {
  strategic_review: "Strategic Review",
  discovery_session: "Discovery Session",
  guided_demo: "Guided Demonstration",
  enterprise_consultation: "Enterprise Consultation",
  kickoff: "Onboarding Kickoff",
  other: "Other",
};

function AppointmentsPanel() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"upcoming" | "past">("upcoming");
  const q = useQuery({
    queryKey: ["journey", "appointments", scope],
    queryFn: () => listAppointments({ data: { scope } }),
  });

  const setStatus = useMutation({
    mutationFn: (input: {
      appointmentId: string;
      status: "confirmed" | "completed" | "no_show" | "canceled";
    }) => setAppointmentStatus({ data: input }),
    onSuccess: (r, vars) => {
      if (vars.status === "no_show") {
        dialToast(r.dial as Rec | null);
        toast.success("No-show recorded — the rebooking agent will call.");
      }
      qc.invalidateQueries({ queryKey: ["journey"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = (q.data ?? []) as Rec[];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={scope} onValueChange={(v) => setScope(v as never)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="upcoming">Upcoming</SelectItem>
            <SelectItem value="past">Past</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!q.isLoading && rows.length === 0 && (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="No appointments"
          description="Bookings made by the inbound agents and from journey cards land here."
        />
      )}

      <div className="space-y-2">
        {rows.map((a) => {
          const contact = a.crm_contacts as Rec | null;
          const who =
            [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") ||
            (a.crm_accounts as Rec | null)?.name ||
            "—";
          return (
            <RecordRow
              key={a.id}
              spine={
                a.status === "no_show"
                  ? "bad"
                  : a.status === "completed"
                    ? "ok"
                    : a.status === "canceled"
                      ? "idle"
                      : "live"
              }
              className="flex items-center gap-3 px-4 py-3"
            >
              <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {who}
                  <Badge variant="secondary" className="ml-2">
                    {KIND_LABELS[a.kind] ?? a.kind}
                  </Badge>
                  {a.source === "voice_agent" && (
                    <Badge variant="outline" className="ml-1">
                      booked by agent
                    </Badge>
                  )}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {format(new Date(a.starts_at), "EEE d MMM, h:mm a")} ·{" "}
                  {formatDistanceToNow(new Date(a.starts_at), { addSuffix: true })}
                </p>
              </div>
              <MonoStatus
                label={a.status.replace(/_/g, " ")}
                tone={
                  a.status === "no_show"
                    ? "destructive"
                    : a.status === "completed"
                      ? "success"
                      : a.status === "canceled"
                        ? "neutral"
                        : "info"
                }
              />
              {["scheduled", "confirmed"].includes(a.status) && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStatus.mutate({ appointmentId: a.id, status: "completed" })}
                  >
                    Done
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-warning"
                    onClick={() => setStatus.mutate({ appointmentId: a.id, status: "no_show" })}
                  >
                    No-show
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStatus.mutate({ appointmentId: a.id, status: "canceled" })}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </RecordRow>
          );
        })}
      </div>
    </div>
  );
}

function JourneyDetailDialog({
  journeyId,
  onClose,
}: {
  journeyId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["journey", "detail", journeyId],
    queryFn: () => getJourney({ data: { id: journeyId! } }),
    enabled: Boolean(journeyId),
  });
  const data = q.data;
  const journey = data?.journey as Rec | undefined;

  const [bookKind, setBookKind] = useState<(typeof APPOINTMENT_KINDS)[number]>("strategic_review");
  const [bookAt, setBookAt] = useState("");
  const [nurtureNote, setNurtureNote] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["journey"] });
    qc.invalidateQueries({ queryKey: ["voice", "outbound"] });
  };

  const patch = useMutation({
    mutationFn: (input: { followUpAt?: string | null; doNotCall?: boolean }) =>
      updateJourney({ data: { journeyId: journeyId!, ...input } }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const book = useMutation({
    mutationFn: () =>
      createAppointment({
        data: {
          journeyId: journeyId!,
          kind: bookKind,
          startsAt: new Date(bookAt).toISOString(),
        },
      }),
    onSuccess: (r) => {
      dialToast(r.dial as Rec | null);
      toast.success("Appointment booked");
      setBookAt("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const nurture = useMutation({
    mutationFn: () =>
      recordNurtureSignal({ data: { journeyId: journeyId!, summary: nurtureNote || null } }),
    onSuccess: (r) => {
      dialToast(r as Rec);
      toast.success("Re-engagement call queued");
      setNurtureNote("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={Boolean(journeyId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            {journey ? contactName(journey) : "Journey"}
          </DialogTitle>
        </DialogHeader>
        {journey && (
          <div className="space-y-4">
            <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
              <div className="-mt-px -ml-px border-t border-l border-border/50 px-4 py-3">
                <p className="label-mono text-muted-foreground">stage</p>
                <p className="mt-1 text-sm">{journey.stage_key.replace(/_/g, " ")}</p>
              </div>
              <div className="-mt-px -ml-px border-t border-l border-border/50 px-4 py-3">
                <p className="label-mono text-muted-foreground">calls</p>
                <p className="numeral mt-1 text-sm">{journey.calls_total}</p>
              </div>
              <div className="-mt-px -ml-px border-t border-l border-border/50 px-4 py-3">
                <p className="label-mono text-muted-foreground">last call</p>
                <p className="mt-1 text-sm">
                  {journey.last_call_at
                    ? formatDistanceToNow(new Date(journey.last_call_at), { addSuffix: true })
                    : "never"}
                </p>
              </div>
              <div className="-mt-px -ml-px border-t border-l border-border/50 px-4 py-3">
                <p className="label-mono text-muted-foreground">do not call</p>
                <div className="mt-1">
                  <Switch
                    checked={journey.do_not_call}
                    onCheckedChange={(v) => patch.mutate({ doNotCall: v })}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div>
                <p className="label-mono mb-1 text-muted-foreground">follow-up</p>
                <Input
                  type="datetime-local"
                  value={
                    journey.follow_up_at
                      ? format(new Date(journey.follow_up_at), "yyyy-MM-dd'T'HH:mm")
                      : ""
                  }
                  onChange={(e) =>
                    patch.mutate({
                      followUpAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                    })
                  }
                />
              </div>
              <div className="flex-1" />
              <div className="flex items-end gap-2">
                <div>
                  <p className="label-mono mb-1 text-muted-foreground">book</p>
                  <Select value={bookKind} onValueChange={(v) => setBookKind(v as never)}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {APPOINTMENT_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {KIND_LABELS[k] ?? k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  type="datetime-local"
                  className="w-52"
                  value={bookAt}
                  onChange={(e) => setBookAt(e.target.value)}
                />
                <Button disabled={!bookAt || book.isPending} onClick={() => book.mutate()}>
                  Book
                </Button>
              </div>
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <p className="label-mono mb-1 text-muted-foreground">
                  re-engage (queues the nurture call)
                </p>
                <Input
                  placeholder="Context for the agent — where things left off"
                  value={nurtureNote}
                  onChange={(e) => setNurtureNote(e.target.value)}
                />
              </div>
              <Button
                variant="outline"
                disabled={nurture.isPending}
                onClick={() => nurture.mutate()}
              >
                <PhoneCall className="mr-2 h-4 w-4" /> Call
              </Button>
            </div>

            <div className="rule-top pt-3">
              <p className="label-mono mb-2 text-muted-foreground">queued calls</p>
              {(data?.jobs ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No outbound jobs for this client.</p>
              )}
              <div className="space-y-1">
                {(data?.jobs ?? []).map((j: Rec) => (
                  <div key={j.id} className="flex items-center justify-between text-sm">
                    <span>{j.trigger_type.replace(/_/g, " ")}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {j.status} · {format(new Date(j.scheduled_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rule-top pt-3">
              <p className="label-mono mb-2 text-muted-foreground">history</p>
              <div className="space-y-1">
                {(data?.events ?? []).map((e: Rec) => (
                  <div key={e.id} className="flex items-center justify-between text-sm">
                    <span>
                      {e.from_stage && e.to_stage
                        ? `${e.from_stage.replace(/_/g, " ")} → ${e.to_stage.replace(/_/g, " ")}`
                        : (e.reason ?? "event")}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {format(new Date(e.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
