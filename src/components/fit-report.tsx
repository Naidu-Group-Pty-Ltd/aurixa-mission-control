// @ts-nocheck
// Fit analysis report card — score dial, dimension bars, correlation map,
// risks, validation table. Shared by /crm/fit and the account hub Fit tab.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FIT_GRADE_LABELS, FIT_VERDICT_LABELS } from "@/lib/fit-analysis.functions";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, HelpCircle, Link2, ShieldQuestion } from "lucide-react";

export function gradeTone(grade?: string | null) {
  switch (grade) {
    case "A":
      return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
    case "B":
      return "bg-sky-500/15 text-sky-500 border-sky-500/30";
    case "C":
      return "bg-amber-500/15 text-amber-500 border-amber-500/30";
    case "D":
      return "bg-orange-500/15 text-orange-500 border-orange-500/30";
    case "F":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function ScoreDial({ score, grade }: { score: number | null; grade?: string | null }) {
  const value = Math.max(0, Math.min(100, Number(score ?? 0)));
  const circumference = 2 * Math.PI * 52;
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r="52" className="stroke-muted" strokeWidth="10" fill="none" />
        <circle
          cx="60"
          cy="60"
          r="52"
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
          className="stroke-primary transition-all duration-700"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (value / 100) * circumference}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums">{value.toFixed(0)}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          out of 100
        </span>
        {grade ? (
          <Badge variant="outline" className={cn("mt-1 border", gradeTone(grade))}>
            {grade}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function DimensionBar({ dim }: { dim: any }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{dim.label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {Number(dim.raw_score).toFixed(0)}/100 · weight {Number(dim.weight).toFixed(0)}
          {dim.verified ? "" : " · unverified"}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            Number(dim.raw_score) >= 70
              ? "bg-emerald-500"
              : Number(dim.raw_score) >= 45
                ? "bg-amber-500"
                : "bg-destructive",
          )}
          style={{ width: `${Math.max(0, Math.min(100, Number(dim.raw_score)))}%` }}
        />
      </div>
      {dim.rationale ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{dim.rationale}</p>
      ) : null}
      {Array.isArray(dim.evidence) && dim.evidence.length ? (
        <ul className="mt-1 space-y-1">
          {dim.evidence.slice(0, 4).map((e: any, i: number) => (
            <li key={i} className="flex gap-2 text-xs text-muted-foreground">
              <Link2 className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                <span className="font-mono uppercase text-[10px]">{e.source ?? "source"}</span>{" "}
                {e.quote ? `“${e.quote}”` : ""} {e.note ?? ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FitReport({ analysis, dimensions }: { analysis: any; dimensions: any[] }) {
  if (!analysis) return null;
  const effectiveVerdict = analysis.override_verdict ?? analysis.verdict;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-6 pt-6 sm:flex-row sm:items-center">
          <ScoreDial score={analysis.score} grade={analysis.grade} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn("border", gradeTone(analysis.grade))}>
                {FIT_GRADE_LABELS[analysis.grade] ?? "Unscored"}
              </Badge>
              <Badge variant="secondary">
                {FIT_VERDICT_LABELS[effectiveVerdict] ?? effectiveVerdict ?? "pending"}
              </Badge>
              {analysis.override_verdict ? <Badge variant="outline">Manually overridden</Badge> : null}
              <span className="font-mono text-xs text-muted-foreground">
                v{analysis.version} · confidence {Number(analysis.confidence ?? 0).toFixed(0)}%
              </span>
            </div>
            <p className="text-lg font-medium leading-snug">
              {analysis.headline ?? "No headline returned."}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {analysis.subject_website ?? "no website researched"} · {analysis.model ?? "—"}
            </p>
            {analysis.override_reason ? (
              <p className="text-xs text-muted-foreground">
                Override reason: {analysis.override_reason}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {analysis.research_summary ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Company research</CardTitle>
            <CardDescription>What this business actually does, verified where possible.</CardDescription>
          </CardHeader>
          <CardContent className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {analysis.research_summary}
          </CardContent>
        </Card>
      ) : null}

      {dimensions.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Dimension scores</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {dimensions.map((d) => (
              <DimensionBar key={d.id ?? d.dimension} dim={d} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {Array.isArray(analysis.correlation_map) && analysis.correlation_map.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">How we solve their problems</CardTitle>
            <CardDescription>Their stated pain points mapped to live Aurixa modules.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {analysis.correlation_map.map((c: any, i: number) => (
              <div key={i} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.pain_point}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {c.module_slug}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{c.how_it_solves}</p>
                {c.expected_outcome ? (
                  <p className="mt-1 text-xs text-muted-foreground">Outcome: {c.expected_outcome}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {analysis.recommended_plan && Object.keys(analysis.recommended_plan).length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recommended package</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              {analysis.recommended_plan.plan_name || analysis.recommended_plan.plan_slug ? (
                <Badge>{analysis.recommended_plan.plan_name ?? analysis.recommended_plan.plan_slug}</Badge>
              ) : null}
              {analysis.recommended_plan.setup_package_slug ? (
                <Badge variant="secondary">{analysis.recommended_plan.setup_package_slug}</Badge>
              ) : null}
              {analysis.recommended_plan.seat_estimate ? (
                <Badge variant="outline">{analysis.recommended_plan.seat_estimate} seats</Badge>
              ) : null}
            </div>
            {Array.isArray(analysis.recommended_plan.addon_module_slugs) &&
            analysis.recommended_plan.addon_module_slugs.length ? (
              <div className="flex flex-wrap gap-1.5">
                {analysis.recommended_plan.addon_module_slugs.map((s: string) => (
                  <Badge key={s} variant="outline" className="font-mono text-[10px]">
                    {s}
                  </Badge>
                ))}
              </div>
            ) : null}
            {analysis.recommended_plan.rationale ? (
              <p className="text-muted-foreground">{analysis.recommended_plan.rationale}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.isArray(analysis.risks) && analysis.risks.length ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4" /> Risks
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {analysis.risks.map((r: any, i: number) => (
                <div key={i} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        r.severity === "high"
                          ? "border-destructive/30 text-destructive"
                          : r.severity === "medium"
                            ? "border-amber-500/30 text-amber-500"
                            : "",
                      )}
                    >
                      {r.severity ?? "low"}
                    </Badge>
                    <span className="font-medium">{r.risk}</span>
                  </div>
                  {r.mitigation ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">Mitigation: {r.mitigation}</p>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {Array.isArray(analysis.validation) && analysis.validation.length ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldQuestion className="h-4 w-4" /> Data validation
              </CardTitle>
              <CardDescription>What they claimed versus what we could verify.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {analysis.validation.map((v: any, i: number) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  {v.status === "confirmed" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  ) : v.status === "contradicted" ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  ) : (
                    <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{v.field}</span>{" "}
                    <span className="text-muted-foreground">{v.claimed}</span>
                    {v.note ? <p className="text-xs text-muted-foreground">{v.note}</p> : null}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {Array.isArray(analysis.open_questions) && analysis.open_questions.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Take these to the discovery call</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {analysis.open_questions.map((q: string, i: number) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {analysis.status === "failed" ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            Analysis failed: {analysis.error}
          </CardContent>
        </Card>
      ) : null}
      <Separator className="opacity-0" />
    </div>
  );
}
