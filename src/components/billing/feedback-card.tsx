// Product feedback, and what it cost.
//
// The two numbers side by side are the point: submissions counts people,
// credits counts workspaces. Five colleagues answering earns 100 credits once,
// so those figures diverging is the rule working rather than a discrepancy.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, MessageSquareQuote, Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listFeedback, type FeedbackRow } from "@/lib/feedback.functions";

type Result = {
  ok: boolean;
  error?: string;
  submissions?: FeedbackRow[];
  awarded?: Array<{ workspace: string | null; campaignKey: string; tokens: number }>;
  stats?: {
    submissions: number;
    workspaces: number;
    creditsAwarded: number;
    averageOverall: number | null;
    undelivered: number;
  };
};

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";

/** The first thing worth reading in a row, whatever they chose to fill in. */
function headline(r: FeedbackRow): string {
  return (
    r.biggest_frustration || r.most_valuable || r.feature_request || r.additional_comments || "—"
  );
}

export function FeedbackCard() {
  const load = useServerFn(listFeedback);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setResult((await load({ data: { limit: 50 } })) as Result);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stats = result?.stats;
  const rows = result?.submissions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareQuote className="h-4 w-4" /> Product feedback
        </CardTitle>
        <CardDescription>
          Responses from the feedback form, the questions scaled to each workspace&rsquo;s own
          modules. Every submission counts; the 100-credit reward is paid{" "}
          <strong className="mx-1">once per workspace per campaign</strong>, so a team of five
          answering earns it once. A workspace is asked in its first 30 days and once a quarter
          after that.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Submissions", value: stats.submissions.toLocaleString(), hint: "people" },
              { label: "Workspaces", value: stats.workspaces.toLocaleString(), hint: "answered" },
              {
                label: "Credits paid",
                value: stats.creditsAwarded.toLocaleString(),
                hint: "one award each",
              },
              {
                label: "Average score",
                value: stats.averageOverall ? `${stats.averageOverall.toFixed(1)}/5` : "—",
                hint: "overall",
              },
            ].map((s) => (
              <div key={s.label} className="rounded-md border p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{s.value}</p>
                <p className="text-[10px] text-muted-foreground">{s.hint}</p>
              </div>
            ))}
          </div>
        )}

        {result && !result.ok && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {result.error ?? "Could not load feedback."}
          </p>
        )}

        {/* Delivery to Airtable is the one thing here that can silently fail,
            so it gets said rather than left to be noticed. */}
        {!!stats?.undelivered && (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {stats.undelivered} response{stats.undelivered === 1 ? "" : "s"} did not reach the
            Make.com webhook. They are recorded here in full and can be replayed — nothing is lost.
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Refresh
          </Button>
        </div>

        {rows.length > 0 ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="text-right">Overall</TableHead>
                  <TableHead className="text-right">Would recommend</TableHead>
                  <TableHead>In their words</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    <TableCell className="text-xs">
                      {r.workspace ?? "—"}
                      <span className="block text-[10px] text-muted-foreground">
                        {r.plan_name ?? "no plan"} · {shortDate(r.created_at)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.origin_username ?? r.origin_user_id ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">
                        {r.campaign_key}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.overall_rating != null ? (
                        <span className="inline-flex items-center gap-1">
                          {r.overall_rating}
                          <Star className="h-3 w-3" />
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.recommend_score != null ? `${r.recommend_score}/10` : "—"}
                    </TableCell>
                    <TableCell className="max-w-[22rem] text-xs">
                      <span className={open === r.id ? "" : "line-clamp-2"}>{headline(r)}</span>
                      {open === r.id && Object.keys(r.module_ratings).length > 0 && (
                        <span className="mt-2 block font-mono text-[10px] text-muted-foreground">
                          {Object.entries(r.module_ratings)
                            .map(([k, v]) => `${k}: ${v}/5`)
                            .join(" · ")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.forwarded_at ? (
                        <Badge variant="outline" className="text-[10px] text-emerald-500">
                          sent
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-amber-600 dark:text-amber-400"
                          title={r.forward_error ?? undefined}
                        >
                          pending
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          result?.ok && (
            <p className="text-sm text-muted-foreground">
              No responses yet. Workspaces are prompted inside their first 30 days, and once a
              quarter after that.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}
