// Client fit analysis queue — leads awaiting a fit check, plus every report
// the AI engine has produced.
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { FitReport, gradeTone } from "@/components/fit-report";
import { FitKnowledgePanel } from "@/components/fit-knowledge-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listFitAnalyses,
  getFitAnalysis,
  runFitAnalysis,
  overrideFitVerdict,
  getFitRubric,
  updateFitRubric,
  FIT_VERDICT_LABELS,
} from "@/lib/fit-analysis.functions";
import { useServerAction } from "@/lib/use-server-action";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Gauge, Sparkles, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/crm/fit")({
  component: () => (
    <ProtectedRoute>
      <FitPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Client Fit Analysis · Aurixa Mission Control" },
      {
        name: "description",
        content:
          "AI compatibility scoring that cross-examines every inbound lead against what Aurixa Systems actually delivers.",
      },
      { property: "og:title", content: "Client Fit Analysis · Aurixa Mission Control" },
      {
        property: "og:description",
        content: "Score, grade and validate prospective clients before the SLA is signed.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function VerdictBadge({ row }: { row: any }) {
  const v = row.override_verdict ?? row.verdict;
  if (row.status !== "complete")
    return <Badge variant="outline">{row.status === "failed" ? "Failed" : row.status}</Badge>;
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className={cn("border", gradeTone(row.grade))}>
        {row.grade} · {Number(row.score ?? 0).toFixed(0)}
      </Badge>
      <Badge variant="secondary">{FIT_VERDICT_LABELS[v] ?? v}</Badge>
    </div>
  );
}

/**
 * The caveats that belong next to a score rather than buried in the report.
 *
 * A 92 computed over half the rubric is not the same claim as a 92 over all of
 * it, and neither is a 92 the samples disagreed wildly about. Showing these in
 * the list means an operator never acts on a number without its qualifiers.
 */
function QualityHints({ row }: { row: any }) {
  if (row.status !== "complete") return null;
  const hints: { label: string; tone: string; title: string }[] = [];

  const coverage = Number(row.coverage ?? 100);
  if (coverage < 100) {
    hints.push({
      label: `${coverage.toFixed(0)}% covered`,
      tone:
        coverage < 70
          ? "border-destructive/40 text-destructive"
          : "border-amber-500/40 text-amber-500",
      title:
        "Share of the rubric the model actually assessed. The score is computed over this much of it.",
    });
  }

  const agreement = Number(row.agreement ?? 100);
  if (row.samples > 1 && agreement < 75) {
    hints.push({
      label: `${agreement.toFixed(0)}% agreement`,
      tone:
        agreement < 50
          ? "border-destructive/40 text-destructive"
          : "border-amber-500/40 text-amber-500",
      title: `Independent samples disagreed. ${row.samples} passes were run and their scores spread widely.`,
    });
  }

  const invented = (row.integrity?.hallucinated_slugs ?? []).length;
  if (invented > 0) {
    hints.push({
      label: `${invented} stripped`,
      tone: "border-amber-500/40 text-amber-500",
      title:
        "Capabilities the model recommended that Aurixa does not sell. They were removed from the report.",
    });
  }

  if (!hints.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {hints.map((h) => (
        <Badge
          key={h.label}
          variant="outline"
          className={cn("text-[10px]", h.tone)}
          title={h.title}
        >
          {h.label}
        </Badge>
      ))}
    </div>
  );
}

function FitPage() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [runFor, setRunFor] = useState<any | null>(null);
  const [website, setWebsite] = useState("");
  const [notes, setNotes] = useState("");
  const [samples, setSamples] = useState(3);
  const [overrideVerdict, setOverrideVerdict] = useState("conditional");
  const [overrideReason, setOverrideReason] = useState("");

  const analyses = useQuery({
    queryKey: ["fit-analyses"],
    queryFn: () => listFitAnalyses({ data: {} }),
  });

  const leads = useQuery({
    queryKey: ["fit-lead-queue"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("waitlist_leads")
        .select(
          "id, first_name, last_name, email, entity_name, entity_classification, status, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  const rubric = useQuery({ queryKey: ["fit-rubric"], queryFn: () => getFitRubric() });

  const detail = useQuery({
    queryKey: ["fit-analysis", openId],
    queryFn: () => getFitAnalysis({ data: { id: openId! } }),
    enabled: Boolean(openId),
  });

  const analysedLeadIds = new Set((analyses.data ?? []).map((a: any) => a.lead_id).filter(Boolean));

  const run = useServerAction(runFitAnalysis, {
    successMessage: (r: any) =>
      r?.ok
        ? `Fit analysis complete — ${r.grade} (${Number(r.score).toFixed(0)}/100)`
        : "Analysis finished",
    onSuccess: () => {
      setRunFor(null);
      setWebsite("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["fit-analyses"] });
    },
  });

  const override = useServerAction(overrideFitVerdict, {
    successMessage: "Verdict overridden",
    onSuccess: () => {
      setOverrideReason("");
      qc.invalidateQueries({ queryKey: ["fit-analyses"] });
      qc.invalidateQueries({ queryKey: ["fit-analysis", openId] });
    },
  });

  const saveRubric = useServerAction(updateFitRubric, {
    successMessage: "Rubric weights saved",
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fit-rubric"] }),
  });

  const [weights, setWeights] = useState<Record<string, number>>({});
  const weightFor = (r: any) => weights[r.id] ?? Number(r.weight);
  const totalWeight = (rubric.data ?? []).reduce((s: number, r: any) => s + weightFor(r), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="pre-contract gate"
        icon={<Gauge className="h-5 w-5" />}
        title="Client fit analysis"
        description="Cross-examine every prospect against what Aurixa actually delivers, before an SLA is signed."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              analyses.refetch();
              leads.refetch();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="rubric">Rubric</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Leads awaiting analysis</CardTitle>
              <CardDescription>
                Every inbound lead should be scored before it is converted to an account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(leads.data ?? []).length === 0 ? (
                <EmptyState
                  icon={<Inbox className="h-6 w-6" />}
                  title="No leads"
                  description="Inbound leads will appear here."
                />
              ) : (
                (leads.data ?? []).map((lead: any) => (
                  <div
                    key={lead.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {lead.entity_name || `${lead.first_name} ${lead.last_name}`}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {lead.email} · {lead.entity_classification ?? "unclassified"} ·{" "}
                        {formatDistanceToNow(lead.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {analysedLeadIds.has(lead.id) ? (
                        <Badge variant="secondary">Analysed</Badge>
                      ) : (
                        <Badge variant="outline">Not analysed</Badge>
                      )}
                      <Button size="sm" onClick={() => setRunFor({ kind: "lead", ...lead })}>
                        <Sparkles className="mr-2 h-4 w-4" />
                        {analysedLeadIds.has(lead.id) ? "Re-run" : "Analyse"}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reports" className="mt-4">
          <Card>
            <CardContent className="space-y-2 pt-6">
              {(analyses.data ?? []).length === 0 ? (
                <EmptyState
                  icon={<Inbox className="h-6 w-6" />}
                  title="No analyses yet"
                  description="Run your first fit analysis from the queue."
                />
              ) : (
                (analyses.data ?? []).map((row: any) => (
                  <button
                    key={row.id}
                    onClick={() => setOpenId(row.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {row.subject_name}{" "}
                        <span className="text-muted-foreground">v{row.version}</span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {row.headline ?? row.subject_email ?? "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <QualityHints row={row} />
                      <VerdictBadge row={row} />
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatDistanceToNow(row.created_at)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rubric" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Scoring weights</CardTitle>
              <CardDescription>
                Weights are normalised, so they need not sum to 100. Current total: {totalWeight}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(rubric.data ?? []).map((r: any) => (
                <div key={r.id} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-muted-foreground">{r.description}</p>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    className="w-24"
                    value={weightFor(r)}
                    onChange={(e) => setWeights((w) => ({ ...w, [r.id]: Number(e.target.value) }))}
                  />
                </div>
              ))}
              <Button
                disabled={saveRubric.isPending}
                onClick={() =>
                  saveRubric.execute({
                    data: {
                      rows: (rubric.data ?? []).map((r: any) => ({
                        id: r.id,
                        weight: weightFor(r),
                      })),
                    },
                  })
                }
              >
                Save weights
              </Button>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Vetoes and evidence ceilings</CardTitle>
              <CardDescription>
                A veto dimension can decline a prospect on its own, whatever the weighted score. The
                ceiling is the highest a dimension may score when the model cited no evidence for
                it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(rubric.data ?? []).map((r: any) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
                >
                  <span className="font-medium">{r.label}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.is_veto ? (
                      <Badge variant="outline" className="border-destructive/40 text-destructive">
                        Vetoes at or below {Number(r.veto_below ?? 0)}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Scored only
                      </Badge>
                    )}
                    <Badge variant="secondary">
                      {r.evidence_required === false
                        ? "Evidence optional"
                        : `Unevidenced ceiling ${Number(r.unevidenced_ceiling ?? 55)}`}
                    </Badge>
                  </div>
                </div>
              ))}
              {!(rubric.data ?? []).some((r: any) => r.is_veto) && (
                <p className="text-xs text-destructive">
                  No dimension is marked as a veto, so nothing can decline a prospect on risk alone
                  — only the weighted score applies.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <FitKnowledgePanel />
        </TabsContent>
      </Tabs>

      {/* Run dialog */}
      <Dialog open={Boolean(runFor)} onOpenChange={(o) => !o && setRunFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run fit analysis</DialogTitle>
            <DialogDescription>
              The engine researches the business, validates their submitted details against public
              sources, then scores them against the live Aurixa capability catalog.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Subject</Label>
              <p className="text-sm text-muted-foreground">
                {runFor?.entity_name || `${runFor?.first_name ?? ""} ${runFor?.last_name ?? ""}`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fit-website">Website (optional override)</Label>
              <Input
                id="fit-website"
                placeholder="acme.com.au — inferred from their email domain if blank"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fit-notes">Analyst notes (optional)</Label>
              <Textarea
                id="fit-notes"
                placeholder="Anything from the discovery call the engine should weigh."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fit-samples">Scoring passes</Label>
              <Select value={String(samples)} onValueChange={(v) => setSamples(Number(v))}>
                <SelectTrigger id="fit-samples">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 — single pass, cheapest</SelectItem>
                  <SelectItem value="3">3 — recommended</SelectItem>
                  <SelectItem value="5">5 — for a decision worth the spend</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Each pass is a separate model call, scored independently and reconciled by median.
                More passes cost proportionally more and buy a steadier number — and how far they
                disagreed is reported with the result.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRunFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={run.isPending}
              onClick={() =>
                run.execute({
                  data: {
                    leadId: runFor.id,
                    websiteOverride: website || undefined,
                    notes: notes || undefined,
                    samples,
                  },
                })
              }
            >
              {run.isPending ? "Analysing…" : "Run analysis"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report dialog */}
      <Dialog open={Boolean(openId)} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail.data?.analysis?.subject_name ?? "Fit report"}</DialogTitle>
            <DialogDescription>
              Immutable report · version {detail.data?.analysis?.version ?? "—"}
            </DialogDescription>
          </DialogHeader>
          {detail.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading report…</p>
          ) : (
            <>
              <FitReport
                analysis={detail.data?.analysis}
                dimensions={detail.data?.dimensions ?? []}
              />
              <div className="space-y-2 rounded-lg border p-3">
                <Label>Override verdict</Label>
                <div className="flex gap-2">
                  <Select value={overrideVerdict} onValueChange={setOverrideVerdict}>
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(FIT_VERDICT_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Reason (required)"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={override.isPending || overrideReason.trim().length < 5}
                    onClick={() =>
                      override.execute({
                        data: {
                          id: openId!,
                          verdict: overrideVerdict,
                          reason: overrideReason.trim(),
                        },
                      })
                    }
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
