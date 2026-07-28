// Operator control for rebuilding `purchases` rows from Stripe.
//
// The reconciler shipped without one, which meant the repair existed but could
// not be run — the ledger stayed empty for the affected window even after the
// schema was fixed. A repair nobody can trigger is not a repair.
//
// Preview first, always: the dry run is a separate click from the write, and
// the write button does not appear until a preview has come back, so the rows
// are on screen before anything is inserted.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { backfillPurchases } from "@/lib/purchases.functions";

type Row = {
  sessionId: string;
  createdAt: string;
  mode: string;
  itemName: string | null;
  amountCents: number | null;
  currency: string | null;
  status: string;
  originUsername: string | null;
};

type Report = {
  ok: boolean;
  error?: string;
  dryRun?: boolean;
  scanned?: number;
  skippedNotPurchase?: number;
  alreadyRecorded?: number;
  inserted?: number;
  rows?: Row[];
  failed?: Array<{ sessionId: string; error: string }>;
  droppedColumns?: string[];
};

const money = (cents: number | null, currency: string | null) =>
  cents == null ? "—" : `${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${currency ?? ""}`;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function RestorePurchasesDialog() {
  const run = useServerFn(backfillPurchases);
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  // Stripe is the source, so the only input that matters is how far back to
  // look. Defaults to the start of the outage rather than "today".
  const [since, setSince] = useState("2026-07-25");
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const execute = async (apply: boolean) => {
    setBusy(apply ? "apply" : "preview");
    try {
      const result = (await run({
        data: { since: new Date(`${since}T00:00:00Z`).toISOString(), apply },
      })) as Report;
      setReport(result);
      if (apply && result.ok) {
        // The ledger the operator is looking at is now stale.
        await queryClient.invalidateQueries({ queryKey: ["purchases"] });
        await queryClient.invalidateQueries({ queryKey: ["purchase-rollups", 30] });
      }
    } catch (err) {
      setReport({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const rows = report?.rows ?? [];
  const previewed = !!report?.ok && report.dryRun === true;
  const applied = !!report?.ok && report.dryRun === false;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReport(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="mr-1.5 h-3.5 w-3.5" /> Restore from Stripe
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Rebuild purchases from Stripe</DialogTitle>
          <DialogDescription>
            Finds checkout sessions with no row in the ledger and recreates them from Stripe, which
            holds the authoritative record. Reporting only — this grants no credits, no seats, and
            moves no money. Sessions that already have a row are left untouched, so it is safe to
            run more than once.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="backfill-since" className="text-xs text-muted-foreground">
              Look back to
            </label>
            <Input
              id="backfill-since"
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="w-44"
            />
          </div>
          <Button variant="outline" onClick={() => void execute(false)} disabled={busy !== null}>
            {busy === "preview" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Checking…
              </>
            ) : (
              "Preview"
            )}
          </Button>
        </div>

        {report && !report.ok && (
          <p className="text-sm text-destructive">{report.error ?? "Backfill failed."}</p>
        )}

        {report?.ok && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Scanned {report.scanned} session{report.scanned === 1 ? "" : "s"} ·{" "}
              {report.alreadyRecorded} already in the ledger · {report.skippedNotPurchase} card-save
              session{report.skippedNotPurchase === 1 ? "" : "s"} skipped
              {applied ? ` · ${report.inserted} restored` : ""}
            </p>

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing missing in this window — every checkout session already has a row.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Initiated by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.sessionId}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {when(r.createdAt)}
                        </TableCell>
                        <TableCell className="text-xs">{r.mode}</TableCell>
                        <TableCell className="text-xs">{r.itemName ?? "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {money(r.amountCents, r.currency)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{r.originUsername ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {!!report.failed?.length && (
              <p className="text-sm text-destructive">
                {report.failed.length} row{report.failed.length === 1 ? "" : "s"} could not be
                written: {report.failed[0].error}
              </p>
            )}
            {!!report.droppedColumns?.length && (
              <p className="text-xs text-muted-foreground">
                Written without {report.droppedColumns.join(", ")} — the database is missing
                {report.droppedColumns.length === 1 ? " that column" : " those columns"}. Apply
                pending migrations.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {applied ? (
            <Button onClick={() => setOpen(false)}>Done</Button>
          ) : (
            <Button
              onClick={() => void execute(true)}
              disabled={busy !== null || !previewed || rows.length === 0}
            >
              {busy === "apply" ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Restoring…
                </>
              ) : (
                `Restore ${rows.length || ""} purchase${rows.length === 1 ? "" : "s"}`.trim()
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
