// @ts-nocheck
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Support Ops — the ticket queue the Support Portal feeds, and the human
// half of the self-healing pipeline: the validation queue where parked
// remediation runs (P0/P1, destructive SQL, unverified or oversized
// patches) wait for an admin to release or reject them.
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  approveRemediationRun,
  getSupportTicketDetail,
  listAssistantActivity,
  listAwaitingValidation,
  listSupportTickets,
  overrideTicketPriority,
  rejectRemediationRun,
  resolveSupportTicket,
} from "@/lib/support-tickets.functions";
import { formatDistanceToNow } from "@/lib/format";
import { Bot, LifeBuoy, ShieldCheck, Wrench } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/support/tickets")({
  component: () => (
    <ProtectedRoute>
      <SupportOpsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Support Ops — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Support tickets from the Aurixa Support Portal, classified P0–P4, with the self-healing validation queue.",
      },
    ],
  }),
});

const PRIORITY_COLOR: Record<string, string> = {
  P0: "bg-red-600",
  P1: "bg-orange-500",
  P2: "bg-amber-500",
  P3: "bg-blue-500",
  P4: "bg-slate-500",
};

const TICKET_STATUSES = [
  "new",
  "triaged",
  "remediating",
  "awaiting_validation",
  "remediated",
  "resolved",
  "closed",
  "failed",
];

const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];

function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge className={`${PRIORITY_COLOR[priority] ?? "bg-slate-500"} text-white`}>{priority}</Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "failed"
      ? "destructive"
      : status === "awaiting_validation"
        ? "outline"
        : "secondary";
  return <Badge variant={variant}>{status.replace(/_/g, " ")}</Badge>;
}

function SupportOpsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const ticketsQuery = useQuery({
    queryKey: ["support", "tickets", status, priority, search],
    queryFn: () =>
      listSupportTickets({
        data: {
          ...(status !== "all" ? { status } : {}),
          ...(priority !== "all" ? { priority } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
        },
      }),
    refetchInterval: 15000,
  });

  const validationQuery = useQuery({
    queryKey: ["support", "validation-queue"],
    queryFn: () => listAwaitingValidation({ data: {} }),
    refetchInterval: 15000,
  });

  const activityQuery = useQuery({
    queryKey: ["support", "assistant-activity"],
    queryFn: () => listAssistantActivity({ data: {} }),
    refetchInterval: 30000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["support"] });
  };

  const kpis = ticketsQuery.data?.openByPriority ?? {};
  const awaitingCount =
    validationQuery.data?.runs?.length ?? ticketsQuery.data?.awaitingValidation ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        eyebrow="self-healing support"
        icon={<LifeBuoy className="h-6 w-6" />}
        title="Support Ops"
        description="Tickets from the Aurixa Support Portal, classified P0–P4. P2 and below self-remediate; everything the policy parks waits here for a human."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {PRIORITIES.map((p) => (
          <Card key={p}>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  {p} open
                </span>
                <span className={`h-2 w-2 rounded-full ${PRIORITY_COLOR[p]}`} />
              </div>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{kpis[p] ?? 0}</p>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="py-4">
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Needs validation
            </span>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{awaitingCount}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="tickets">
        <TabsList>
          <TabsTrigger value="tickets">
            <LifeBuoy className="mr-1.5 h-4 w-4" /> Tickets
          </TabsTrigger>
          <TabsTrigger value="validation">
            <ShieldCheck className="mr-1.5 h-4 w-4" /> Validation queue
            {awaitingCount > 0 && (
              <Badge variant="outline" className="ml-2">
                {awaitingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="assistant">
            <Bot className="mr-1.5 h-4 w-4" /> Assistant
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tickets" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {TICKET_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reference, subject, workspace…"
              className="w-[280px]"
            />
          </div>

          {(ticketsQuery.data?.tickets ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              {ticketsQuery.isLoading ? "Loading tickets…" : "No tickets match this filter."}
            </p>
          )}
          {(ticketsQuery.data?.tickets ?? []).map((t: any) => {
            const breached =
              t.sla_breached_at ||
              (t.sla_due_at &&
                new Date(t.sla_due_at) < new Date() &&
                !["resolved", "closed", "remediated"].includes(t.status));
            return (
              <Card
                key={t.id}
                className="cursor-pointer transition-colors hover:bg-muted/40"
                onClick={() => setSelectedTicketId(t.id)}
              >
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.subject}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.reference} · {t.workspace_id}
                      {t.clones?.name ? ` (${t.clones.name})` : ""} ·{" "}
                      {t.category.replace(/_/g, " ")} · opened {formatDistanceToNow(t.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {breached && <Badge variant="destructive">SLA breached</Badge>}
                    {t.auto_remediable && (
                      <Badge variant="outline" className="gap-1">
                        <Wrench className="h-3 w-3" /> auto
                      </Badge>
                    )}
                    <PriorityBadge priority={t.priority} />
                    <StatusBadge status={t.status} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="validation" className="space-y-3">
          {(validationQuery.data?.runs ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing awaiting validation — the pipeline is either healing on its own or quiet.
            </p>
          )}
          {(validationQuery.data?.runs ?? []).map((run: any) => (
            <ValidationRow key={run.id} run={run} onDone={refresh} />
          ))}
        </TabsContent>

        <TabsContent value="assistant" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {activityQuery.data
              ? `${activityQuery.data.askedLast7d} questions in the last 7 days · ${activityQuery.data.escalatedLast7d} escalated to a ticket`
              : "Loading assistant activity…"}
          </p>
          {(activityQuery.data?.activity ?? []).length === 0 && !activityQuery.isLoading && (
            <p className="text-sm text-muted-foreground">
              No assistant activity yet — rows appear here as the Support Portal's screening
              assistant answers questions.
            </p>
          )}
          {(activityQuery.data?.activity ?? []).map((a: any) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{a.question}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.workspace_id ?? "unknown workspace"}
                    {a.clones?.name ? ` (${a.clones.name})` : ""}
                    {a.user_external_id ? ` · user ${a.user_external_id}` : ""}
                    {a.source ? ` · via ${a.source}` : ""} ·{" "}
                    {formatDistanceToNow(a.asked_at ?? a.created_at)}
                    {a.latency_ms != null ? ` · ${a.latency_ms} ms` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {a.escalated && <Badge variant="destructive">escalated</Badge>}
                  <Badge variant="secondary">{a.mode}</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <TicketDetailSheet
        ticketId={selectedTicketId}
        onClose={() => setSelectedTicketId(null)}
        onChanged={refresh}
      />
    </div>
  );
}

function ValidationRow({ run, onDone }: { run: any; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const reasons: string[] = run.policy?.reasons ?? [];

  const act = async (kind: "approve" | "reject") => {
    setBusy(true);
    try {
      if (kind === "approve") {
        const res = await approveRemediationRun({ data: { runId: run.id } });
        toast.success(
          res.executed ? `Approved — executed (${res.outcome})` : "Approved — drain will execute",
        );
      } else {
        await rejectRemediationRun({ data: { runId: run.id } });
        toast.success("Rejected");
      }
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="font-medium">
            {run.action_type.replace(/_/g, " ")}
            {run.support_tickets?.reference
              ? ` · ${run.support_tickets.reference}`
              : " · scan pipeline"}
            {run.clones?.name ? ` · ${run.clones.name}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {run.support_tickets?.subject ?? run.plan?.repo_full_name ?? ""}
          </p>
          {reasons.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
              {reasons.slice(0, 4).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2">
          <PriorityBadge priority={run.priority} />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act("reject")}>
            Reject
          </Button>
          <Button size="sm" disabled={busy} onClick={() => act("approve")}>
            Approve & run
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TicketDetailSheet({
  ticketId,
  onClose,
  onChanged,
}: {
  ticketId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useQuery({
    queryKey: ["support", "ticket", ticketId],
    queryFn: () => getSupportTicketDetail({ data: { ticketId: ticketId! } }),
    enabled: !!ticketId,
  });
  const [overridePriority, setOverridePriority] = useState<string>("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);

  const ticket = detail.data?.ticket;

  const doOverride = async () => {
    if (!ticket || !overridePriority || overrideReason.trim().length < 4) {
      toast.error("Pick a priority and give a reason (a few words at least).");
      return;
    }
    setBusy(true);
    try {
      await overrideTicketPriority({
        data: { ticketId: ticket.id, priority: overridePriority, reason: overrideReason.trim() },
      });
      toast.success(`Priority set to ${overridePriority}`);
      setOverridePriority("");
      setOverrideReason("");
      detail.refetch();
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doResolve = async (action: "resolve" | "close") => {
    if (!ticket) return;
    setBusy(true);
    try {
      await resolveSupportTicket({ data: { ticketId: ticket.id, action } });
      toast.success(action === "resolve" ? "Ticket resolved" : "Ticket closed");
      detail.refetch();
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (runId: string, kind: "approve" | "reject") => {
    setBusy(true);
    try {
      if (kind === "approve") {
        const res = await approveRemediationRun({ data: { runId } });
        toast.success(
          res.executed ? `Approved — executed (${res.outcome})` : "Approved — drain will execute",
        );
      } else {
        await rejectRemediationRun({ data: { runId } });
        toast.success("Rejected");
      }
      detail.refetch();
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!ticketId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {ticket ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                {ticket.reference}
                <PriorityBadge priority={ticket.priority} />
                <StatusBadge status={ticket.status} />
              </SheetTitle>
              <SheetDescription>{ticket.subject}</SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-6 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Meta label="Workspace" value={ticket.workspace_id} />
                <Meta label="Clone" value={ticket.clones?.name ?? "— (prime scope)"} />
                <Meta label="Category" value={ticket.category.replace(/_/g, " ")} />
                <Meta label="Breakage" value={ticket.breakage_vector.replace(/_/g, " ")} />
                <Meta label="Reporter" value={ticket.reporter_email ?? "—"} />
                <Meta label="User" value={ticket.user_external_id ?? "—"} />
                <Meta
                  label="SLA due"
                  value={ticket.sla_due_at ? formatDistanceToNow(ticket.sla_due_at) : "—"}
                />
                <Meta label="Lane" value={ticket.remediation_lane ?? "none"} />
              </div>

              <section>
                <h3 className="mb-1 font-medium">Description</h3>
                <p className="whitespace-pre-wrap text-muted-foreground">{ticket.description}</p>
                {ticket.impact && (
                  <>
                    <h3 className="mb-1 mt-3 font-medium">Impact</h3>
                    <p className="whitespace-pre-wrap text-muted-foreground">{ticket.impact}</p>
                  </>
                )}
              </section>

              <section>
                <h3 className="mb-1 font-medium">Classification</h3>
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {(ticket.classification?.reasons ?? []).map((r: string, i: number) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">
                  score {ticket.priority_score}
                  {ticket.priority_overridden_at ? " · priority manually overridden" : ""}
                </p>
              </section>

              <section>
                <h3 className="mb-2 font-medium">Remediation runs</h3>
                {(detail.data?.runs ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground">No runs planned.</p>
                )}
                <div className="space-y-2">
                  {(detail.data?.runs ?? []).map((run: any) => (
                    <div key={run.id} className="rounded-md border p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{run.action_type.replace(/_/g, " ")}</span>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={run.status} />
                          {run.status === "awaiting_validation" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => runAction(run.id, "reject")}
                              >
                                Reject
                              </Button>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => runAction(run.id, "approve")}
                              >
                                Approve & run
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {(run.policy?.reasons ?? []).length > 0 && (
                        <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                          {run.policy.reasons.slice(0, 4).map((r: string, i: number) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                      {run.last_error && (
                        <p className="mt-1 text-xs text-destructive">{run.last_error}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="mb-2 font-medium">Timeline</h3>
                <div className="space-y-1.5">
                  {(detail.data?.events ?? []).map((ev: any) => (
                    <div key={ev.id} className="flex items-baseline gap-2 text-xs">
                      <span className="whitespace-nowrap font-mono text-muted-foreground">
                        {formatDistanceToNow(ev.created_at)}
                      </span>
                      <span>{ev.event_type.replace(/[._]/g, " ")}</span>
                    </div>
                  ))}
                </div>
              </section>

              {!["resolved", "closed"].includes(ticket.status) && (
                <section className="space-y-3 rounded-md border p-3">
                  <h3 className="font-medium">Operator actions</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={overridePriority} onValueChange={setOverridePriority}>
                      <SelectTrigger className="w-[130px]">
                        <SelectValue placeholder="Priority…" />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.filter((p) => p !== ticket.priority).map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Why the override?"
                      className="w-[240px]"
                    />
                    <Button size="sm" variant="outline" disabled={busy} onClick={doOverride}>
                      Override priority
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => doResolve("resolve")}>
                      Mark resolved
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => doResolve("close")}
                    >
                      Close without fix
                    </Button>
                  </div>
                </section>
              )}
            </div>
          </>
        ) : (
          <p className="mt-8 text-sm text-muted-foreground">
            {detail.isLoading ? "Loading ticket…" : "Ticket not found."}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="truncate">{value}</p>
    </div>
  );
}
