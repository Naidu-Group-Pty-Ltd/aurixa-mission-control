import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { listRates, upsertRate } from "@/lib/tokens.functions";
import { fmt } from "./utils";

export function RatesTab() {
  const listFn = useServerFn(listRates);
  const upsertFn = useServerFn(upsertRate);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["rates"], queryFn: () => listFn() });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(null);

  const startNew = () => {
    setDraft({ kind: "", base_cost: 0, per_unit: {}, notes: "" });
    setOpen(true);
  };
  const edit = (r: any) => {
    setDraft({ ...r, per_unit_json: JSON.stringify(r.per_unit ?? {}, null, 2) });
    setOpen(true);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Token rate cards</CardTitle>
        <Button size="sm" onClick={startNew}>
          <Plus className="mr-1 h-3 w-3" />
          New rate
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Base</TableHead>
              <TableHead>Per-unit</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.rates.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">{r.kind}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.base_cost)}</TableCell>
                <TableCell className="font-mono text-xs">{JSON.stringify(r.per_unit)}</TableCell>
                <TableCell className="text-xs">
                  {new Date(r.effective_from).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => edit(r)}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!data?.rates.length && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  No rates configured.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit rate" : "New rate"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-2 text-sm">
              <Input
                placeholder="Kind (e.g. report.financial)"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              />
              <Input
                type="number"
                placeholder="Base cost"
                value={draft.base_cost}
                onChange={(e) =>
                  setDraft({ ...draft, base_cost: parseInt(e.target.value || "0", 10) })
                }
              />
              <textarea
                className="min-h-[100px] border border-border bg-background p-2 font-mono text-xs"
                placeholder='Per-unit JSON, e.g. {"page": 5, "ai_token": 0.01}'
                value={draft.per_unit_json ?? JSON.stringify(draft.per_unit ?? {})}
                onChange={(e) => setDraft({ ...draft, per_unit_json: e.target.value })}
              />
              <Input
                placeholder="Notes"
                value={draft.notes ?? ""}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={async () => {
                let per_unit: Record<string, number> = {};
                try {
                  per_unit = JSON.parse(draft.per_unit_json ?? "{}");
                } catch {
                  toast.error("Invalid per-unit JSON");
                  return;
                }
                const r = await upsertFn({
                  data: {
                    id: draft.id,
                    kind: draft.kind,
                    base_cost: draft.base_cost,
                    per_unit,
                    notes: draft.notes || null,
                  },
                });
                if (r.ok) {
                  toast.success("Saved");
                  setOpen(false);
                  qc.invalidateQueries({ queryKey: ["rates"] });
                } else toast.error(r.error);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── API Keys ────────────────────────────────────────────────────────────────
