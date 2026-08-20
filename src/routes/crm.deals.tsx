// Deal pipeline board.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listDeals, setDealStage, DEAL_STAGES } from "@/lib/crm-deals.functions";
import { Target, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/crm/deals")({
  component: () => (
    <ProtectedRoute>
      <DealsBoard />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Deal Pipeline — Aurixa Mission Control" },
      {
        name: "description",
        content: "Opportunity board from discovery to contract, with weighted forecast by stage.",
      },
      { property: "og:title", content: "Deal Pipeline — Aurixa Mission Control" },
      { property: "og:description", content: "Track every Aurixa opportunity through to won." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(
    (cents ?? 0) / 100,
  );

function DealsBoard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["crm", "deals"], queryFn: () => listDeals() });
  const deals = q.data ?? [];

  const FIT_GATE_MESSAGES: Record<string, string> = {
    fit_gate_no_analysis:
      "Blocked: run a client fit analysis on this account before moving to contract.",
    fit_gate_stale_analysis: "Blocked: the client fit analysis is over 90 days old — re-run it.",
    fit_gate_failed_verdict:
      "Blocked: the client fit analysis verdict does not clear this deal for contract.",
  };

  async function move(deal: any, dir: -1 | 1) {
    const idx = DEAL_STAGES.indexOf(deal.stage);
    const next = DEAL_STAGES[Math.min(DEAL_STAGES.length - 1, Math.max(0, idx + dir))];
    if (next === deal.stage) return;
    try {
      await setDealStage({ data: { id: deal.id, stage: next } });
    } catch (err) {
      const key = err instanceof Error ? err.message : "";
      toast.error(FIT_GATE_MESSAGES[key] ?? key ?? "Could not move deal");
      return;
    }
    toast.success(`${deal.name} → ${next}`);
    qc.invalidateQueries({ queryKey: ["crm"] });
  }


  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="pipeline"
        icon={<Target className="h-6 w-6" />}
        title="Deals"
        description="Every open opportunity, its value, and how long it has sat in stage."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {DEAL_STAGES.map((stage) => {
          const inStage = deals.filter((d: any) => d.stage === stage);
          const value = inStage.reduce((s: number, d: any) => s + (d.expected_mrr_cents ?? 0), 0);
          return (
            <div key={stage} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  {stage}
                </p>
                <span className="text-xs text-muted-foreground">
                  {inStage.length} · {money(value)}
                </span>
              </div>
              <div className="space-y-2">
                {inStage.map((d: any) => (
                  <Card key={d.id}>
                    <CardContent className="space-y-2 py-3">
                      <Link
                        to="/crm/accounts/$accountId"
                        params={{ accountId: d.account_id }}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {d.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {d.crm_accounts?.name} · {d.seats} seats · {d.probability}%
                      </p>
                      <div className="flex items-center justify-between">
                        <Badge variant="secondary">{money(d.expected_mrr_cents)}/mo</Badge>
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" onClick={() => move(d, -1)}>
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => move(d, 1)}>
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {inStage.length === 0 && (
                  <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                    Empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
