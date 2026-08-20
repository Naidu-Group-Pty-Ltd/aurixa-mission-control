// The account hub — one screen holding an entire client relationship:
// timeline, contacts, deals, contract, live billing, tickets, disputes,
// feedback and the exit/offboarding record.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  getAccount,
  setAccountStage,
  logActivity,
  upsertContact,
  recomputeHealth,
  LIFECYCLE_STAGES,
} from "@/lib/crm.functions";
import { upsertDeal, setDealStage, DEAL_STAGES } from "@/lib/crm-deals.functions";
import { createTicket, upsertDispute } from "@/lib/crm-support.functions";
import {
  upsertContract,
  seedOnboarding,
  setOnboardingStep,
  recordChurn,
  updateOffboarding,
  buildExportManifest,
  markExportDelivered,
  requestFeedback,
  CHURN_REASONS,
} from "@/lib/crm-lifecycle.functions";
import { formatDistanceToNow } from "@/lib/format";
import { toast } from "sonner";
import {
  Building2,
  HeartPulse,
  Plus,
  RefreshCw,
  DoorOpen,
  FileDown,
  CheckCircle2,
} from "lucide-react";
import { FitReport } from "@/components/fit-report";
import { RecordRow } from "@/components/record-row";
import { getFitHistory, runFitAnalysis } from "@/lib/fit-analysis.functions";
import { useServerAction } from "@/lib/use-server-action";

/** Fit tab — latest AI compatibility report plus the version history. */
function AccountFitTab({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const fit = useQuery({
    queryKey: ["account-fit", accountId],
    queryFn: () => getFitHistory({ data: { accountId } }),
  });
  const run = useServerAction(runFitAnalysis, {
    successMessage: (r: any) =>
      r?.ok
        ? `Fit analysis complete — ${r.grade} (${Number(r.score).toFixed(0)}/100)`
        : "Analysis finished",
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-fit", accountId] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Client fit analysis</h3>
          <p className="text-xs text-muted-foreground">
            Cross-examines this client against the live Aurixa capability catalog.
          </p>
        </div>
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() => run.execute({ data: { accountId } })}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {run.isPending ? "Analysing…" : fit.data?.latest ? "Re-run analysis" : "Run analysis"}
        </Button>
      </div>

      {fit.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : fit.data?.latest ? (
        <>
          <FitReport analysis={fit.data.latest} dimensions={fit.data.dimensions} />
          {fit.data.history.length > 1 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Previous versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {fit.data.history.slice(1).map((h: any) => (
                  <div key={h.id} className="flex items-center justify-between text-sm">
                    <span>
                      v{h.version} · {h.grade ?? "—"} · {Number(h.score ?? 0).toFixed(0)}/100
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatDistanceToNow(h.created_at)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No fit analysis has been run for this client yet. Run one before advancing the deal to
            contract or SLA.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export const Route = createFileRoute("/crm/accounts/$accountId")({
  component: () => (
    <ProtectedRoute>
      <AccountHub />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Client Account — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Full client record: timeline, contacts, deals, contract, payments, tickets, disputes, feedback and offboarding.",
      },
      { property: "og:title", content: "Client Account — Aurixa Mission Control" },
      { property: "og:description", content: "One screen for an entire client relationship." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (cents: number, currency = "AUD") =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: 2 }).format(
    (cents ?? 0) / 100,
  );

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function AccountHub() {
  const { accountId } = Route.useParams();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["crm", "account", accountId] });

  const q = useQuery({
    queryKey: ["crm", "account", accountId],
    queryFn: () => getAccount({ data: { id: accountId } }),
  });

  const d: any = q.data;
  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading account…</div>;
  if (q.error || !d) return <div className="p-6 text-sm text-destructive">Account not found.</div>;

  const a = d.account;
  const contract = d.contracts?.[0];
  const offboarding = d.offboarding?.[0];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="client account"
        icon={<Building2 className="h-6 w-6" />}
        title={a.name}
        description={[
          a.classification?.replace(/_/g, " "),
          a.clones?.name ? `clone: ${a.clones.name}` : null,
          a.last_contacted_at
            ? `last contact ${formatDistanceToNow(a.last_contacted_at)}`
            : "never contacted",
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Select
              value={a.lifecycle_stage}
              onValueChange={async (v) => {
                await setAccountStage({ data: { id: a.id, stage: v } });
                toast.success(`Stage → ${v.replace(/_/g, " ")}`);
                refresh();
              }}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIFECYCLE_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={async () => {
                const r: any = await recomputeHealth({ data: { account_id: a.id } });
                toast.success(`Health score: ${r.score}`);
                refresh();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Recompute health
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Health
            </p>
            <p className="mt-1 flex items-center gap-2 text-3xl font-semibold">
              <HeartPulse className="h-5 w-5 text-muted-foreground" />
              {a.health_score ?? "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              MRR
            </p>
            <p className="mt-1 text-3xl font-semibold">{money(a.mrr_cents)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Open tickets
            </p>
            <p className="mt-1 text-3xl font-semibold">
              {d.tickets.filter((t: any) => !["resolved", "closed"].includes(t.status)).length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Credits
            </p>
            <p className="mt-1 text-3xl font-semibold">{d.billing.balance?.available ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="timeline">
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="deals">Deals</TabsTrigger>
          <TabsTrigger value="fit">Fit</TabsTrigger>
          <TabsTrigger value="contract">Contract</TabsTrigger>
          <TabsTrigger value="onboarding">Onboarding</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="disputes">Disputes</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="exit">Exit</TabsTrigger>
        </TabsList>

        {/* ------------------------------- FIT ------------------------------ */}
        <TabsContent value="fit" className="space-y-4">
          <AccountFitTab accountId={a.id} />
        </TabsContent>

        {/* ---------------------------- TIMELINE ---------------------------- */}

        <TabsContent value="timeline" className="space-y-4">
          <LogActivityCard accountId={a.id} onDone={refresh} />
          <Card>
            <CardContent className="space-y-3 pt-6">
              {d.activities.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
              )}
              {d.activities.map((ev: any) => (
                <div key={ev.id} className="border-l-2 pl-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize">
                      {ev.kind.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-sm font-medium">{ev.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatDistanceToNow(ev.occurred_at)}
                    </span>
                  </div>
                  {ev.body && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {ev.body}
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- CONTACTS ---------------------------- */}
        <TabsContent value="contacts" className="space-y-4">
          <ContactForm accountId={a.id} onDone={refresh} />
          <div className="grid gap-3 md:grid-cols-2">
            {d.contacts.map((c: any) => (
              <RecordRow key={c.id}>
                <CardContent className="py-4">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">
                      {c.first_name} {c.last_name}
                    </p>
                    {c.is_primary && <Badge>Primary</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{c.job_title}</p>
                  <p className="mt-1 text-sm">{c.email}</p>
                  <p className="text-sm text-muted-foreground">{c.phone}</p>
                </CardContent>
              </RecordRow>
            ))}
          </div>
        </TabsContent>

        {/* ------------------------------ DEALS ----------------------------- */}
        <TabsContent value="deals" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Opportunities</CardTitle>
              <CardDescription>
                Winning a deal creates the contract and onboarding checklist.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {d.deals.map((deal: any) => (
                <div
                  key={deal.id}
                  className="flex flex-wrap items-center justify-between gap-3 border p-3"
                >
                  <div>
                    <p className="font-medium">{deal.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {money(deal.expected_mrr_cents)}/mo · {deal.seats} seats · {deal.probability}%
                      · {deal.tier_slug ?? "no tier"}
                    </p>
                  </div>
                  <Select
                    value={deal.stage}
                    onValueChange={async (v) => {
                      await setDealStage({ data: { id: deal.id, stage: v } });
                      toast.success(`Deal → ${v}`);
                      refresh();
                    }}
                  >
                    <SelectTrigger className="w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEAL_STAGES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <NewDealForm accountId={a.id} onDone={refresh} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- CONTRACT ---------------------------- */}
        <TabsContent value="contract">
          <ContractCard accountId={a.id} contract={contract} onDone={refresh} />
        </TabsContent>

        {/* --------------------------- ONBOARDING --------------------------- */}
        <TabsContent value="onboarding">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Onboarding checklist</CardTitle>
                  <CardDescription>Everything that must happen before go-live.</CardDescription>
                </div>
                {d.onboarding.length === 0 && (
                  <Button
                    onClick={async () => {
                      await seedOnboarding({ data: { account_id: a.id } });
                      toast.success("Checklist created");
                      refresh();
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" /> Create checklist
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {d.onboarding.map((step: any) => (
                <label key={step.id} className="flex items-center gap-3 border px-3 py-2 text-sm">
                  <Checkbox
                    checked={step.status === "done"}
                    onCheckedChange={async (v) => {
                      await setOnboardingStep({
                        data: { id: step.id, status: v ? "done" : "pending" },
                      });
                      refresh();
                    }}
                  />
                  <span
                    className={step.status === "done" ? "text-muted-foreground line-through" : ""}
                  >
                    {step.label}
                  </span>
                </label>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- PAYMENTS ---------------------------- */}
        <TabsContent value="payments" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Live billing</CardTitle>
              <CardDescription>
                Read straight from Stripe purchases, invoices, credits and seats.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Row label="Credit balance" value={d.billing.balance?.available ?? "—"} />
              <Row label="Reserved credits" value={d.billing.balance?.reserved ?? "—"} />
              <Row
                label="Seats used"
                value={d.billing.seats ? `${d.billing.seats.seats_used ?? 0}` : "no entitlement"}
              />
              <Row label="Purchases recorded" value={d.billing.purchases.length} />
              <Row label="Invoices" value={d.billing.invoices.length} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent purchases</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {d.billing.purchases.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No purchases linked to this account's clone.
                </p>
              )}
              {d.billing.purchases.map((p: any) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between border px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">{p.item_name ?? p.item_slug ?? p.mode}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.status} · {formatDistanceToNow(p.created_at)}
                    </p>
                  </div>
                  <span className="font-mono">
                    {money(p.amount_cents ?? 0, p.currency ?? "AUD")}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ----------------------------- TICKETS ---------------------------- */}
        <TabsContent value="tickets" className="space-y-4">
          <NewTicketForm accountId={a.id} onDone={refresh} />
          <div className="space-y-2">
            {d.tickets.map((t: any) => (
              <RecordRow key={t.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium">{t.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.reference} · {t.type} · opened {formatDistanceToNow(t.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={t.severity === "critical" ? "destructive" : "secondary"}>
                      {t.severity}
                    </Badge>
                    <Badge variant="outline">{t.status.replace(/_/g, " ")}</Badge>
                  </div>
                </CardContent>
              </RecordRow>
            ))}
            {d.tickets.length === 0 && <p className="text-sm text-muted-foreground">No tickets.</p>}
          </div>
        </TabsContent>

        {/* ---------------------------- DISPUTES ---------------------------- */}
        <TabsContent value="disputes" className="space-y-4">
          <NewDisputeForm accountId={a.id} onDone={refresh} />
          <div className="space-y-2">
            {d.disputes.map((x: any) => (
              <RecordRow key={x.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium capitalize">{x.kind.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {money(x.amount_cents, x.currency)} · opened{" "}
                      {formatDistanceToNow(x.opened_at)}
                    </p>
                  </div>
                  <Select
                    value={x.status}
                    onValueChange={async (v) => {
                      await upsertDispute({
                        data: {
                          id: x.id,
                          account_id: a.id,
                          kind: x.kind,
                          status: v,
                          amount_cents: x.amount_cents,
                        },
                      });
                      refresh();
                    }}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "open",
                        "under_review",
                        "evidence_submitted",
                        "won",
                        "lost",
                        "withdrawn",
                        "settled",
                      ].map((s) => (
                        <SelectItem key={s} value={s}>
                          {s.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </RecordRow>
            ))}
            {d.disputes.length === 0 && (
              <p className="text-sm text-muted-foreground">No disputes. Good.</p>
            )}
          </div>
        </TabsContent>

        {/* ---------------------------- FEEDBACK ---------------------------- */}
        <TabsContent value="feedback" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Feedback requests</CardTitle>
                  <CardDescription>Survey sends and their responses.</CardDescription>
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    await requestFeedback({ data: { account_id: a.id, channel: "email" } });
                    toast.success("Feedback request logged");
                    refresh();
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" /> Request feedback
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {d.feedback.length === 0 && (
                <p className="text-sm text-muted-foreground">No requests yet.</p>
              )}
              {d.feedback.map((f: any) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between border px-3 py-2 text-sm"
                >
                  <span>
                    {f.channel} · requested {formatDistanceToNow(f.requested_at)}
                  </span>
                  <Badge variant={f.responded_at ? "default" : "secondary"}>
                    {f.responded_at ? `NPS ${f.nps_score ?? "—"}` : "awaiting response"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------ EXIT ------------------------------ */}
        <TabsContent value="exit" className="space-y-4">
          {d.churn.length === 0 ? (
            <ChurnForm accountId={a.id} contractId={contract?.id ?? null} onDone={refresh} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cancellation record</CardTitle>
              </CardHeader>
              <CardContent>
                <Row label="Reason" value={d.churn[0].reason.replace(/_/g, " ")} />
                <Row label="Competitor" value={d.churn[0].competitor ?? "—"} />
                <Row
                  label="Requested"
                  value={new Date(d.churn[0].requested_at).toLocaleDateString()}
                />
                <Row
                  label="Data retention until"
                  value={
                    d.churn[0].data_retention_until
                      ? new Date(d.churn[0].data_retention_until).toLocaleDateString()
                      : "—"
                  }
                />
                {d.churn[0].reason_detail && (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {d.churn[0].reason_detail}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {offboarding && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">
                      Offboarding · {offboarding.path.replace(/_/g, " ")}
                    </CardTitle>
                    <CardDescription>
                      Wind-down checklist and data portability. Status: {offboarding.status}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await buildExportManifest({ data: { id: offboarding.id } });
                        toast.success("Export manifest built");
                        refresh();
                      }}
                    >
                      <FileDown className="mr-2 h-4 w-4" /> Build export manifest
                    </Button>
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await markExportDelivered({ data: { id: offboarding.id } });
                        toast.success("Export marked delivered");
                        refresh();
                      }}
                    >
                      <CheckCircle2 className="mr-2 h-4 w-4" /> Mark delivered
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {(offboarding.checklist ?? []).map((step: any, i: number) => (
                  <label
                    key={step.key}
                    className="flex items-center gap-3 border px-3 py-2 text-sm"
                  >
                    <Checkbox
                      checked={step.done}
                      onCheckedChange={async (v) => {
                        const next = (offboarding.checklist ?? []).map((s: any, j: number) =>
                          j === i ? { ...s, done: Boolean(v) } : s,
                        );
                        await updateOffboarding({ data: { id: offboarding.id, checklist: next } });
                        refresh();
                      }}
                    />
                    <span className={step.done ? "text-muted-foreground line-through" : ""}>
                      {step.label}
                    </span>
                  </label>
                ))}
                {offboarding.path === "ownership_transfer" && (
                  <>
                    <Separator className="my-3" />
                    <p className="text-sm text-muted-foreground">
                      Ownership transfer runs through the existing backend handoff pipeline.
                    </p>
                    <Button asChild variant="outline" size="sm">
                      <Link to="/handoffs">Open handoffs</Link>
                    </Button>
                  </>
                )}
                {offboarding.export_manifest?.datasets && (
                  <div className="mt-3 border p-3">
                    <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                      Export manifest
                    </p>
                    {offboarding.export_manifest.datasets.map((ds: any) => (
                      <Row key={ds.key} label={ds.label} value={`${ds.rows} rows`} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------ sub-forms -------------------------------- */

function LogActivityCard({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [kind, setKind] = useState("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Log an interaction</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["note", "call", "email", "meeting"].map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input placeholder="Summary" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <Textarea placeholder="Details…" value={body} onChange={(e) => setBody(e.target.value)} />
        <Button
          disabled={!title.trim()}
          onClick={async () => {
            await logActivity({
              data: { account_id: accountId, kind, title: title.trim(), body: body || null },
            });
            setTitle("");
            setBody("");
            toast.success("Logged");
            onDone();
          }}
        >
          Log
        </Button>
      </CardContent>
    </Card>
  );
}

function ContactForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [f, setF] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    job_title: "",
  });
  const set = (k: string) => (e: any) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add contact</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-5">
        <Input placeholder="First name" value={f.first_name} onChange={set("first_name")} />
        <Input placeholder="Last name" value={f.last_name} onChange={set("last_name")} />
        <Input placeholder="Email" value={f.email} onChange={set("email")} />
        <Input placeholder="Phone" value={f.phone} onChange={set("phone")} />
        <Button
          disabled={!f.first_name.trim()}
          onClick={async () => {
            await upsertContact({
              data: {
                account_id: accountId,
                first_name: f.first_name.trim(),
                last_name: f.last_name || null,
                email: f.email || null,
                phone: f.phone || null,
                job_title: f.job_title || null,
              },
            });
            setF({ first_name: "", last_name: "", email: "", phone: "", job_title: "" });
            toast.success("Contact added");
            onDone();
          }}
        >
          Add
        </Button>
      </CardContent>
    </Card>
  );
}

function NewDealForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [mrr, setMrr] = useState("");
  return (
    <div className="flex flex-wrap gap-2 border-t pt-3">
      <Input
        className="min-w-[200px] flex-1"
        placeholder="Deal name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        className="w-40"
        placeholder="MRR (AUD)"
        value={mrr}
        onChange={(e) => setMrr(e.target.value)}
      />
      <Button
        disabled={!name.trim()}
        onClick={async () => {
          await upsertDeal({
            data: {
              account_id: accountId,
              name: name.trim(),
              expected_mrr_cents: Math.round(Number(mrr || 0) * 100),
            },
          });
          setName("");
          setMrr("");
          toast.success("Deal created");
          onDone();
        }}
      >
        <Plus className="mr-2 h-4 w-4" /> Add deal
      </Button>
    </div>
  );
}

function ContractCard({ accountId, contract, onDone }: any) {
  const [f, setF] = useState({
    tier_slug: contract?.tier_slug ?? "",
    committed_seats: String(contract?.committed_seats ?? 1),
    mrr: String((contract?.mrr_cents ?? 0) / 100),
    term_end: contract?.term_end ?? "",
    notice: String(contract?.notice_period_days ?? 30),
    auto_renew: contract?.auto_renew ?? true,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contract</CardTitle>
        <CardDescription>Term, commitment and the notice period that governs exit.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Tier</Label>
          <Input value={f.tier_slug} onChange={(e) => setF({ ...f, tier_slug: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label>Committed seats</Label>
          <Input
            value={f.committed_seats}
            onChange={(e) => setF({ ...f, committed_seats: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>MRR (AUD)</Label>
          <Input value={f.mrr} onChange={(e) => setF({ ...f, mrr: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label>Term end</Label>
          <Input
            type="date"
            value={f.term_end ?? ""}
            onChange={(e) => setF({ ...f, term_end: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Notice period (days)</Label>
          <Input value={f.notice} onChange={(e) => setF({ ...f, notice: e.target.value })} />
        </div>
        <div className="flex items-end gap-2">
          <Checkbox
            id="auto-renew"
            checked={f.auto_renew}
            onCheckedChange={(v) => setF({ ...f, auto_renew: Boolean(v) })}
          />
          <Label htmlFor="auto-renew">Auto-renew</Label>
        </div>
        <div className="md:col-span-2">
          <Button
            onClick={async () => {
              await upsertContract({
                data: {
                  id: contract?.id,
                  account_id: accountId,
                  tier_slug: f.tier_slug || null,
                  committed_seats: Number(f.committed_seats) || 1,
                  mrr_cents: Math.round(Number(f.mrr || 0) * 100),
                  term_end: f.term_end || null,
                  notice_period_days: Number(f.notice) || 30,
                  auto_renew: f.auto_renew,
                  status: "active",
                },
              });
              toast.success("Contract saved");
              onDone();
            }}
          >
            Save contract
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NewTicketForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [subject, setSubject] = useState("");
  const [type, setType] = useState("support");
  const [severity, setSeverity] = useState("normal");
  const [description, setDescription] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Raise a ticket</CardTitle>
        <CardDescription>Response SLA is set automatically from severity.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-[220px] flex-1"
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["support", "bug", "billing", "feature", "incident"].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["low", "normal", "high", "critical"].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Textarea
          placeholder="What happened?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Button
          disabled={!subject.trim()}
          onClick={async () => {
            await createTicket({
              data: {
                account_id: accountId,
                subject: subject.trim(),
                type,
                severity,
                description: description || null,
              },
            });
            setSubject("");
            setDescription("");
            toast.success("Ticket raised");
            onDone();
          }}
        >
          Raise ticket
        </Button>
      </CardContent>
    </Card>
  );
}

function NewDisputeForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [kind, setKind] = useState("billing_disagreement");
  const [amount, setAmount] = useState("");
  const [summary, setSummary] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Open a dispute</CardTitle>
        <CardDescription>Chargebacks from Stripe are recorded here automatically.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["chargeback", "billing_disagreement", "service_credit", "contractual", "other"].map(
                (k) => (
                  <SelectItem key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <Input
            className="w-40"
            placeholder="Amount (AUD)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <Textarea
          placeholder="Summary of the disagreement"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <Button
          onClick={async () => {
            await upsertDispute({
              data: {
                account_id: accountId,
                kind,
                amount_cents: Math.round(Number(amount || 0) * 100),
                summary: summary || null,
              },
            });
            setAmount("");
            setSummary("");
            toast.success("Dispute opened");
            onDone();
          }}
        >
          Open dispute
        </Button>
      </CardContent>
    </Card>
  );
}

function ChurnForm({ accountId, contractId, onDone }: any) {
  const [reason, setReason] = useState("other");
  const [detail, setDetail] = useState("");
  const [competitor, setCompetitor] = useState("");
  const [path, setPath] = useState("export_and_terminate");
  const [saveAttempted, setSaveAttempted] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DoorOpen className="h-4 w-4" /> Record cancellation
        </CardTitle>
        <CardDescription>
          Creates the churn record and a governed offboarding checklist, including the
          data-portability path and the 90-day retention clock.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHURN_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={path} onValueChange={setPath}>
            <SelectTrigger className="w-[240px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="export_and_terminate">Export data, then terminate</SelectItem>
              <SelectItem value="ownership_transfer">Transfer backend ownership</SelectItem>
              <SelectItem value="terminate_only">Terminate only</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-56"
            placeholder="Switching to (competitor)"
            value={competitor}
            onChange={(e) => setCompetitor(e.target.value)}
          />
        </div>
        <Textarea
          placeholder="What they told us"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={saveAttempted} onCheckedChange={(v) => setSaveAttempted(Boolean(v))} />
          A save attempt was made
        </label>
        <Button
          variant="destructive"
          onClick={async () => {
            await recordChurn({
              data: {
                account_id: accountId,
                contract_id: contractId,
                reason,
                reason_detail: detail || null,
                competitor: competitor || null,
                save_attempted: saveAttempted,
                offboarding_path: path,
              },
            });
            toast.success("Cancellation recorded — offboarding started");
            onDone();
          }}
        >
          Record cancellation
        </Button>
      </CardContent>
    </Card>
  );
}
