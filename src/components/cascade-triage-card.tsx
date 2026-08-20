import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Sparkles, Loader2, Wrench, ArrowUpCircle, ChevronDown } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { triageCascade, type TriageProposal } from "@/server/cascade-triage.functions";

export function CascadeTriageCard({
  cascadeEventId,
  failureCount,
}: {
  cascadeEventId: string;
  failureCount: number;
}) {
  const triageFn = useServerFn(triageCascade);
  const [running, setRunning] = useState(false);
  const [proposals, setProposals] = useState<TriageProposal[] | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const res = await triageFn({ data: { cascadeEventId } });
      if (!res.ok) {
        toast.error(res.error);
      } else {
        setProposals(res.proposals);
        toast.success(
          res.proposals.length === 0
            ? "AI found nothing to triage"
            : `${res.proposals.length} proposal${res.proposals.length === 1 ? "" : "s"} from AI`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Triage failed");
    } finally {
      setRunning(false);
    }
  };

  if (failureCount === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-accent" /> AI conflict triage
          </CardTitle>
          <CardDescription className="mt-1">
            Lovable AI inspects each failed clone and proposes a fix-up or escalation path.
          </CardDescription>
        </div>
        <Button size="sm" onClick={run} disabled={running}>
          {running ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {running
            ? "Analyzing…"
            : proposals
              ? "Re-triage"
              : `Triage ${failureCount} failure${failureCount === 1 ? "" : "s"}`}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {!proposals && (
          <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
            Click <span className="font-mono">Triage</span> to ask AI for fix proposals.
          </div>
        )}
        {proposals?.length === 0 && (
          <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
            AI returned no actionable proposals.
          </div>
        )}
        {proposals?.map((p) => (
          <ProposalRow key={p.resultId} proposal={p} />
        ))}
      </CardContent>
    </Card>
  );
}

function ProposalRow({ proposal }: { proposal: TriageProposal }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-md border bg-surface p-3",
          proposal.category === "escalate" && "border-warning/30",
          proposal.category === "fixup" && "border-info/30",
        )}
      >
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-start gap-3 text-left">
            <CategoryIcon category={proposal.category} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{proposal.title}</span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] uppercase", riskTone(proposal.risk))}
                >
                  {proposal.risk}
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px] uppercase">
                  {proposal.category}
                </Badge>
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                {proposal.cloneName}
              </div>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-2 border-t pt-3">
          <p className="text-sm text-muted-foreground">{proposal.rationale}</p>
          {proposal.steps.length > 0 && (
            <div className="font-mono text-xs">
              <div className="mb-1 uppercase tracking-wider text-muted-foreground">Steps</div>
              <ol className="space-y-0.5 pl-4">
                {proposal.steps.map((s, i) => (
                  <li key={i} className="list-decimal">
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function CategoryIcon({ category }: { category: TriageProposal["category"] }) {
  const cls = "h-4 w-4 shrink-0 mt-0.5";
  return category === "escalate" ? (
    <ArrowUpCircle className={cn(cls, "text-warning")} />
  ) : (
    <Wrench className={cn(cls, "text-info")} />
  );
}

function riskTone(r: TriageProposal["risk"]) {
  switch (r) {
    case "high":
      return "border-destructive/40 text-destructive";
    case "medium":
      return "border-warning/40 text-warning";
    case "low":
      return "border-success/40 text-success";
  }
}
