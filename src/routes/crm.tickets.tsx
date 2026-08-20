// Ticket queue + dispute register.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  listTickets,
  listDisputes,
  updateTicket,
  TICKET_STATUSES,
  TICKET_SEVERITIES,
} from "@/lib/crm-support.functions";
import { formatDistanceToNow } from "@/lib/format";
import { LifeBuoy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/crm/tickets")({
  component: () => (
    <ProtectedRoute>
      <TicketsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Tickets & Disputes — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Client issue queue with response SLAs, plus the dispute and chargeback register.",
      },
      { property: "og:title", content: "Tickets & Disputes — Aurixa Mission Control" },
      { property: "og:description", content: "Resolve client issues before they become churn." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (cents: number, currency = "AUD") =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency }).format((cents ?? 0) / 100);

function TicketsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");

  const tickets = useQuery({
    queryKey: ["crm", "tickets", status, severity],
    queryFn: () => listTickets({ data: { status, severity } }),
  });
  const disputes = useQuery({ queryKey: ["crm", "disputes"], queryFn: () => listDisputes() });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="client support"
        icon={<LifeBuoy className="h-6 w-6" />}
        title="Tickets & disputes"
        description="Issue resolution with response SLAs, and the formal dispute register."
      />

      <Tabs defaultValue="tickets">
        <TabsList>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="disputes">Disputes</TabsTrigger>
        </TabsList>

        <TabsContent value="tickets" className="space-y-3">
          <div className="flex gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[180px]">
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
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All severities</SelectItem>
                {TICKET_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(tickets.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No tickets match this filter.</p>
          )}
          {(tickets.data ?? []).map((t: any) => {
            const breached =
              t.sla_due_at && new Date(t.sla_due_at) < new Date() && !["resolved", "closed"].includes(t.status);
            return (
              <Card key={t.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.subject}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <Link
                        to="/crm/accounts/$accountId"
                        params={{ accountId: t.account_id }}
                        className="hover:underline"
                      >
                        {t.crm_accounts?.name ?? "—"}
                      </Link>{" "}
                      · {t.reference} · opened {formatDistanceToNow(t.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {breached && <Badge variant="destructive">SLA breached</Badge>}
                    <Badge variant={t.severity === "critical" ? "destructive" : "secondary"}>{t.severity}</Badge>
                    <Select
                      value={t.status}
                      onValueChange={async (v) => {
                        await updateTicket({ data: { id: t.id, status: v } });
                        toast.success("Ticket updated");
                        qc.invalidateQueries({ queryKey: ["crm"] });
                      }}
                    >
                      <SelectTrigger className="w-[170px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TICKET_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="disputes" className="space-y-3">
          {(disputes.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No disputes on record.</p>
          )}
          {(disputes.data ?? []).map((x: any) => (
            <Card key={x.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium capitalize">{x.kind.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted-foreground">
                    <Link
                      to="/crm/accounts/$accountId"
                      params={{ accountId: x.account_id }}
                      className="hover:underline"
                    >
                      {x.crm_accounts?.name ?? "—"}
                    </Link>{" "}
                    · {money(x.amount_cents, x.currency)} · opened {formatDistanceToNow(x.opened_at)}
                  </p>
                </div>
                <Badge variant={["open", "under_review"].includes(x.status) ? "destructive" : "secondary"}>
                  {x.status.replace(/_/g, " ")}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
