import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { listPlans, upsertPlan, listPacks, upsertPack } from "@/lib/tokens.functions";
import { fmt, money } from "./utils";

export function PlansPacksTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlansCard />
      <PacksCard />
    </div>
  );
}

function PlansCard() {
  const listFn = useServerFn(listPlans);
  const upsertFn = useServerFn(upsertPlan);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["plans"], queryFn: () => listFn() });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(null);

  const startNew = () => {
    setDraft({
      slug: "",
      name: "",
      monthly_allowance: 0,
      rollover_cap: 0,
      overage_policy: "block",
      price_cents: 0,
      currency: "USD",
      is_active: true,
    });
    setOpen(true);
  };
  const edit = (p: any) => {
    setDraft({ ...p });
    setOpen(true);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Billing plans</CardTitle>
        <Button size="sm" onClick={startNew}>
          <Plus className="mr-1 h-3 w-3" />
          New
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {data?.plans.map((p: any) => (
          <button
            key={p.id}
            onClick={() => edit(p)}
            className="flex w-full items-center justify-between border border-border p-2 text-left hover:bg-muted/30"
          >
            <div>
              <div className="font-medium">
                {p.name}{" "}
                <span className="font-mono text-[10px] text-muted-foreground">/{p.slug}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {fmt(p.monthly_allowance)} tokens/mo · {p.overage_policy}
              </div>
            </div>
            <div className="text-right tabular-nums">
              {money(p.price_cents, p.currency)}
              <div className="text-[10px] text-muted-foreground">
                {p.is_active ? "active" : "inactive"}
              </div>
            </div>
          </button>
        ))}
        {!data?.plans.length && <p className="text-muted-foreground">No plans.</p>}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit plan" : "New plan"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-2 text-sm">
              <Input
                placeholder="Slug"
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              />
              <Input
                placeholder="Name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Input
                type="number"
                placeholder="Monthly allowance"
                value={draft.monthly_allowance}
                onChange={(e) =>
                  setDraft({ ...draft, monthly_allowance: parseInt(e.target.value || "0", 10) })
                }
              />
              <Input
                type="number"
                placeholder="Rollover cap"
                value={draft.rollover_cap}
                onChange={(e) =>
                  setDraft({ ...draft, rollover_cap: parseInt(e.target.value || "0", 10) })
                }
              />
              <Select
                value={draft.overage_policy}
                onValueChange={(v) => setDraft({ ...draft, overage_policy: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">block</SelectItem>
                  <SelectItem value="topup_only">topup_only</SelectItem>
                  <SelectItem value="pay_as_you_go">pay_as_you_go</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                placeholder="Price (cents)"
                value={draft.price_cents}
                onChange={(e) =>
                  setDraft({ ...draft, price_cents: parseInt(e.target.value || "0", 10) })
                }
              />
              <Input
                placeholder="Currency"
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
                maxLength={3}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={async () => {
                const r = await upsertFn({ data: draft });
                if (r.ok) {
                  toast.success("Saved");
                  setOpen(false);
                  qc.invalidateQueries({ queryKey: ["plans"] });
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

function PacksCard() {
  const listFn = useServerFn(listPacks);
  const upsertFn = useServerFn(upsertPack);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["packs"], queryFn: () => listFn() });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(null);

  const startNew = () => {
    setDraft({
      slug: "",
      name: "",
      tokens: 1000,
      price_cents: 0,
      currency: "USD",
      is_active: true,
    });
    setOpen(true);
  };
  const edit = (p: any) => {
    setDraft({ ...p });
    setOpen(true);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Top-up packs</CardTitle>
        <Button size="sm" onClick={startNew}>
          <Plus className="mr-1 h-3 w-3" />
          New
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {data?.packs.map((p: any) => (
          <button
            key={p.id}
            onClick={() => edit(p)}
            className="flex w-full items-center justify-between border border-border p-2 text-left hover:bg-muted/30"
          >
            <div>
              <div className="font-medium">
                {p.name}{" "}
                <span className="font-mono text-[10px] text-muted-foreground">/{p.slug}</span>
              </div>
              <div className="text-xs text-muted-foreground">+{fmt(p.tokens)} tokens</div>
            </div>
            <div className="text-right tabular-nums">{money(p.price_cents, p.currency)}</div>
          </button>
        ))}
        {!data?.packs.length && <p className="text-muted-foreground">No packs.</p>}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit pack" : "New pack"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-2 text-sm">
              <Input
                placeholder="Slug"
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              />
              <Input
                placeholder="Name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Input
                type="number"
                placeholder="Tokens"
                value={draft.tokens}
                onChange={(e) =>
                  setDraft({ ...draft, tokens: parseInt(e.target.value || "0", 10) })
                }
              />
              <Input
                type="number"
                placeholder="Price (cents)"
                value={draft.price_cents}
                onChange={(e) =>
                  setDraft({ ...draft, price_cents: parseInt(e.target.value || "0", 10) })
                }
              />
              <Input
                placeholder="Currency"
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
                maxLength={3}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={async () => {
                const r = await upsertFn({ data: draft });
                if (r.ok) {
                  toast.success("Saved");
                  setOpen(false);
                  qc.invalidateQueries({ queryKey: ["packs"] });
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

// ─── Rates ───────────────────────────────────────────────────────────────────
