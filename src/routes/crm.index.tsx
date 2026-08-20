// @ts-nocheck — 1 unresolved type error (assignability ×1).
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// CRM overview — the client-lifecycle control tower.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pipelineSummary, listOpenTasks } from "@/lib/crm.functions";
import { Users, Target, LifeBuoy, Scale, HeartPulse, UserPlus, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/crm/")({
  component: () => (
    <ProtectedRoute>
      <CrmOverview />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "CRM Overview — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Client lifecycle control tower: pipeline forecast, at-risk accounts, open tickets, disputes and overdue follow-ups.",
      },
      { property: "og:title", content: "CRM Overview — Aurixa Mission Control" },
      {
        property: "og:description",
        content: "Track every client from waitlist lead through contract, support and exit.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(
    (cents ?? 0) / 100,
  );

const STAGE_LABELS: Record<string, string> = {
  lead: "Leads",
  opportunity: "Opportunities",
  onboarding: "Onboarding",
  active: "Active",
  at_risk: "At risk",
  churned: "Churned",
};

function Stat({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: any;
  tone?: "danger" | "warn";
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              {label}
            </p>
            <p
              className={
                "mt-2 text-3xl font-semibold tracking-tight " +
                (tone === "danger" ? "text-destructive" : "")
              }
            >
              {value}
            </p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );
}

function CrmOverview() {
  const summary = useQuery({ queryKey: ["crm", "summary"], queryFn: () => pipelineSummary() });
  const tasks = useQuery({ queryKey: ["crm", "tasks"], queryFn: () => listOpenTasks() });
  const s: any = summary.data ?? {};
  const byStage: Record<string, number> = s.accounts_by_stage ?? {};
  const dealStages: Record<string, { count: number; value: number }> = s.deals_by_stage ?? {};

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        eyebrow="client lifecycle"
        title="CRM"
        description="Every client from first waitlist touch through contract, support, renewal and exit."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/leads">
                <UserPlus className="mr-2 h-4 w-4" /> Leads
              </Link>
            </Button>
            <Button asChild>
              <Link to="/crm/accounts">
                <Users className="mr-2 h-4 w-4" /> Accounts
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Recurring revenue"
          value={money(Number(s.mrr_cents ?? 0))}
          hint={`${money(Number(s.mrr_cents ?? 0) * 12)} annualised`}
          icon={Target}
        />
        <Stat
          label="Weighted forecast"
          value={money(Number(s.weighted_forecast_cents ?? 0))}
          hint="Open pipeline × probability"
          icon={Target}
        />
        <Stat
          label="Open tickets"
          value={Number(s.open_tickets ?? 0)}
          hint={`${Number(s.sla_breached ?? 0)} past SLA`}
          icon={LifeBuoy}
          tone={Number(s.sla_breached ?? 0) > 0 ? "danger" : undefined}
        />
        <Stat
          label="At risk"
          value={Number(s.at_risk ?? 0)}
          hint={`${Number(s.open_disputes ?? 0)} open disputes`}
          icon={HeartPulse}
          tone={Number(s.at_risk ?? 0) > 0 ? "danger" : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accounts by lifecycle stage</CardTitle>
            <CardDescription>Where the whole book of business sits right now.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.keys(STAGE_LABELS).map((stage) => (
              <Link
                key={stage}
                to="/crm/accounts"
                search={{ stage }}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span>{STAGE_LABELS[stage]}</span>
                <Badge variant={stage === "at_risk" ? "destructive" : "secondary"}>
                  {byStage[stage] ?? 0}
                </Badge>
              </Link>
            ))}
            <div className="flex items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm">
              <span className="text-muted-foreground">Unconverted waitlist leads</span>
              <Link to="/leads" className="font-mono text-sm underline-offset-4 hover:underline">
                {Number(s.unconverted_leads ?? 0)} <ArrowRight className="inline h-3 w-3" />
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Deal pipeline</CardTitle>
            <CardDescription>Open opportunities by stage and monthly value.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {["discovery", "demo", "proposal", "contract", "won", "lost"].map((stage) => (
              <div key={stage} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span className="capitalize">{stage}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {dealStages[stage]?.count ?? 0} · {money(dealStages[stage]?.value ?? 0)}
                </span>
              </div>
            ))}
            <Button asChild variant="outline" className="w-full">
              <Link to="/crm/deals">Open pipeline board</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Follow-ups</CardTitle>
              <CardDescription>
                {Number(s.overdue_tasks ?? 0)} overdue · {Number(s.churned_90d ?? 0)} churn events in
                the last 90 days
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/crm/tickets">
                <Scale className="mr-2 h-4 w-4" /> Tickets & disputes
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {(tasks.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No open tasks. Everything is handled.</p>
          )}
          {(tasks.data ?? []).slice(0, 12).map((t: any) => {
            const overdue = t.due_at && new Date(t.due_at) < new Date();
            return (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.crm_accounts?.name ?? "—"}
                  </p>
                </div>
                <Badge variant={overdue ? "destructive" : "secondary"}>
                  {t.due_at ? new Date(t.due_at).toLocaleDateString() : "no due date"}
                </Badge>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
