import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Globe2, Lock, RefreshCw, RotateCcw } from "lucide-react";
import { listReportCostIndex, publishReportCostIndex } from "@/lib/report-cost-index.functions";

type ReportRow = {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  credit_cost: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any> | null;
};

type CascadeTarget = { name: string; delivered: boolean; detail?: string };

function defaultCostOf(row: ReportRow): number | null {
  const d = row.metadata?.default_credit_cost;
  return typeof d === "number" ? d : null;
}

/**
 * The platform's per-report price list.
 *
 * Every clone resolves its token reservation from these numbers, so a change
 * here reprices that report across every workspace. Publishing is therefore
 * gated to super_admin / High King (enforced server-side and by RLS; the form
 * is simply read-only for anyone else rather than failing at save time).
 */
export function ReportCostIndexCard() {
  const load = useServerFn(listReportCostIndex);
  const publish = useServerFn(publishReportCostIndex);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["report-cost-index"],
    queryFn: () => load(),
  });

  // slug → edited value, holding the raw string so a half-typed field doesn't
  // snap back to a number while the operator is still typing.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const reports: ReportRow[] = useMemo(() => data?.reports ?? [], [data]);
  const canPublish = !!data?.canPublish;

  const changes = useMemo(() => {
    return reports
      .map((r) => {
        const raw = drafts[r.slug];
        if (raw === undefined || raw.trim() === "") return null;
        const next = Number(raw);
        if (!Number.isInteger(next) || next < 0) return null;
        if (next === r.credit_cost) return null;
        return { slug: r.slug, name: r.name, from: r.credit_cost, to: next };
      })
      .filter(Boolean) as Array<{ slug: string; name: string; from: number; to: number }>;
  }, [reports, drafts]);

  const invalidDrafts = useMemo(
    () =>
      Object.entries(drafts).filter(([, raw]) => {
        if (raw.trim() === "") return false;
        const n = Number(raw);
        return !Number.isInteger(n) || n < 0;
      }),
    [drafts],
  );

  async function doPublish() {
    setPublishing(true);
    try {
      const result = await publish({
        data: {
          edits: changes.map((c) => ({ slug: c.slug, credit_cost: c.to })),
          note: note.trim() || undefined,
        },
      });
      if (!result?.ok) {
        toast.error("Publish failed", { description: result?.error ?? "Unknown error" });
        return;
      }
      const targets: CascadeTarget[] = result.cascade ?? [];
      const failed = targets.filter((t) => !t.delivered);
      toast.success(`Repriced ${result.changes.length} report type(s)`, {
        description: failed.length
          ? `Cascaded to ${targets.length - failed.length}/${targets.length} targets. ${failed
              .map((f) => f.name)
              .join(", ")} will pick it up on their next catalog refresh.`
          : `Cascaded to all ${targets.length} targets.`,
      });
      setDrafts({});
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["report-cost-index"] });
    } catch (e) {
      toast.error("Publish failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setPublishing(false);
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Report token cost index
            </CardTitle>
            <CardDescription className="max-w-2xl">
              Credits charged per generated report, keyed by the metering kind each clone sends.
              Publishing cascades to every clone and the prime repository.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {!canPublish && (
              <Badge variant="outline" className="gap-1">
                <Lock className="h-3 w-3" />
                Read only
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="Refresh the report cost index"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        {data?.version && (
          <p className="text-xs text-muted-foreground">
            Index version <span className="font-mono">{data.version}</span>
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load the cost index."}
          </p>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Metering kind</TableHead>
                  <TableHead className="text-right">Default</TableHead>
                  <TableHead className="text-right w-[140px]">Credits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((r) => {
                  const draft = drafts[r.slug];
                  const value = draft === undefined ? String(r.credit_cost) : draft;
                  const def = defaultCostOf(r);
                  const dirty = changes.some((c) => c.slug === r.slug);
                  const invalid =
                    draft !== undefined && draft.trim() !== "" && !/^\d+$/.test(draft.trim());
                  return (
                    <TableRow key={r.id} className={dirty ? "bg-primary/5" : undefined}>
                      <TableCell>
                        <div className="font-medium">{r.name}</div>
                        {r.description && (
                          <div className="text-xs text-muted-foreground">{r.description}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs text-muted-foreground">{r.slug}</code>
                        <Badge variant="outline" className="ml-2 capitalize">
                          {r.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                        {def ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            inputMode="numeric"
                            className={`h-9 w-24 text-right tabular-nums ${
                              invalid ? "border-destructive" : ""
                            }`}
                            value={value}
                            disabled={!canPublish || publishing}
                            aria-label={`Credits for ${r.name}`}
                            aria-invalid={invalid || undefined}
                            onChange={(e) => setDrafts((d) => ({ ...d, [r.slug]: e.target.value }))}
                          />
                          {dirty && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9"
                              aria-label={`Reset ${r.name} to ${r.credit_cost}`}
                              onClick={() =>
                                setDrafts((d) => {
                                  const next = { ...d };
                                  delete next[r.slug];
                                  return next;
                                })
                              }
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {canPublish && (
          <div className="space-y-3 border bg-muted/30 p-4">
            <Textarea
              placeholder="Why is this changing? (recorded on the publish history)"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              disabled={publishing}
              aria-label="Reason for this reprice"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {invalidDrafts.length > 0
                  ? "Fix the highlighted values before publishing."
                  : changes.length === 0
                    ? "No changes yet."
                    : `${changes.length} report type(s) will be repriced.`}
              </p>
              <Button
                onClick={() => setConfirming(true)}
                disabled={publishing || changes.length === 0 || invalidDrafts.length > 0}
              >
                <Globe2 className="mr-2 h-4 w-4" />
                Publish &amp; cascade
              </Button>
            </div>
          </div>
        )}

        {(data?.revisions?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Recent publishes</h4>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {(data!.revisions as any[]).map((rev) => {
                const changed = Object.keys(rev.changes ?? {});
                const targets = (rev.cascade_result?.targets ?? []) as CascadeTarget[];
                const failed = targets.filter((t) => !t.delivered).length;
                return (
                  <li key={rev.id} className="flex flex-wrap gap-x-2">
                    <span className="font-mono">{new Date(rev.created_at).toLocaleString()}</span>
                    <span>
                      {changed.length} change{changed.length === 1 ? "" : "s"}
                      {changed.length > 0 && ` (${changed.join(", ")})`}
                    </span>
                    {targets.length > 0 && (
                      <span>
                        · cascaded to {targets.length - failed}/{targets.length}
                      </span>
                    )}
                    {rev.note && <span className="italic">· {rev.note}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reprice {changes.length} report type(s)?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This changes what <strong>every clone and the prime repository</strong> charges
                  for these reports. Reports already generated are unaffected; the new price applies
                  to the next reservation.
                </p>
                <ul className="space-y-1 text-sm">
                  {changes.map((c) => (
                    <li key={c.slug} className="flex justify-between gap-4">
                      <span className="truncate">{c.name}</span>
                      <span className="shrink-0 tabular-nums">
                        {c.from} → <strong>{c.to}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doPublish()} disabled={publishing}>
              {publishing ? "Publishing…" : "Publish & cascade"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
