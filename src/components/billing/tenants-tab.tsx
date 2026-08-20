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
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import {
  listPlans,
  listPacks,
  listTenants,
  getTenant,
  assignTenantPlan,
  grantTenantTokens,
  applyTenantTopup,
  refundReportJob,
} from "@/lib/tokens.functions";
import { getTenantUsageSummaryFn } from "@/lib/tenant-usage.functions";
import { fmt } from "./utils";

export function TenantsTab() {
  const listFn = useServerFn(listTenants);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["tenants", search],
    queryFn: () => listFn({ data: { search: search || undefined } }),
  });
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder="Search by name or external_ref…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button variant="outline" size="icon" onClick={() => refetch()}>
          <RotateCw className="h-4 w-4" />
        </Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {data?.tenants.map((t: any) => {
              const bal = Array.isArray(t.token_balances) ? t.token_balances[0] : t.token_balances;
              const plan = Array.isArray(t.billing_plans) ? t.billing_plans[0] : t.billing_plans;
              return (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => setSelected(t.id)}>
                  <TableCell>
                    <div className="font-medium">{t.display_name || t.external_ref}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {t.external_ref}
                    </div>
                  </TableCell>
                  <TableCell>{plan?.name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(bal?.available)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt(bal?.lifetime_spent)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.status === "active" ? "default" : "secondary"}>
                      {t.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
            {data && data.tenants.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No tenants yet. They auto-provision on first meter call from a clone.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      <Sheet open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <SheetContent className="w-full max-w-xl overflow-y-auto sm:max-w-xl">
          {selected && <TenantDetail id={selected} onClose={() => setSelected(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function TenantDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const fn = useServerFn(getTenant);
  const assignFn = useServerFn(assignTenantPlan);
  const grantFn = useServerFn(grantTenantTokens);
  const topupFn = useServerFn(applyTenantTopup);
  const refundFn = useServerFn(refundReportJob);
  const plansFn = useServerFn(listPlans);
  const packsFn = useServerFn(listPacks);
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: ["tenant", id],
    queryFn: () => fn({ data: { id } }),
  });
  const { data: plansData } = useQuery({ queryKey: ["plans"], queryFn: () => plansFn() });
  const { data: packsData } = useQuery({ queryKey: ["packs"], queryFn: () => packsFn() });

  const [planId, setPlanId] = useState("");
  const [packId, setPackId] = useState("");
  const [grantAmt, setGrantAmt] = useState("");
  const [grantReason, setGrantReason] = useState("Manual operator grant");

  const refresh = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ["tenants"] });
  };

  if (!data?.tenant) return <p className="p-4 text-sm">Not found.</p>;
  const t = data.tenant as any;
  const plan = t.billing_plans;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{t.display_name || t.external_ref}</SheetTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          {t.external_ref} · clone {t.clones?.name ?? "—"}
        </p>
      </SheetHeader>
      <div className="mt-4 space-y-4">
        <Card>
          <CardContent className="grid grid-cols-2 gap-3 pt-4 text-sm">
            <div>
              <p className="text-[10px] uppercase text-muted-foreground">Available</p>
              <p className="text-lg font-semibold">{fmt(data.balance?.available)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-muted-foreground">Spent</p>
              <p className="text-lg font-semibold">{fmt(data.balance?.lifetime_spent)}</p>
            </div>
          </CardContent>
        </Card>

        <TenantUsageCard tenantId={id} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              Current: <span className="font-mono">{plan?.name ?? "none"}</span>
            </p>
            <div className="flex gap-2">
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Assign plan…" />
                </SelectTrigger>
                <SelectContent>
                  {plansData?.plans.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {fmt(p.monthly_allowance)}/mo
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!planId}
                onClick={async () => {
                  const r = await assignFn({ data: { tenantId: id, planId } });
                  if (r.ok) {
                    toast.success("Plan assigned");
                    refresh();
                  } else toast.error(r.error);
                }}
              >
                Assign
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Grant tokens</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input
              type="number"
              placeholder="Tokens"
              value={grantAmt}
              onChange={(e) => setGrantAmt(e.target.value)}
            />
            <Input
              placeholder="Reason"
              value={grantReason}
              onChange={(e) => setGrantReason(e.target.value)}
            />
            <Button
              onClick={async () => {
                const n = parseInt(grantAmt, 10);
                if (!n || n <= 0) return toast.error("Invalid amount");
                const r = await grantFn({ data: { tenantId: id, tokens: n, reason: grantReason } });
                if (r.ok) {
                  toast.success(`Granted ${fmt(n)} tokens`);
                  setGrantAmt("");
                  refresh();
                } else toast.error(r.error ?? "Failed");
              }}
            >
              Grant
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Apply top-up pack</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select value={packId} onValueChange={setPackId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick pack…" />
              </SelectTrigger>
              <SelectContent>
                {packsData?.packs.map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · +{fmt(p.tokens)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={!packId}
              onClick={async () => {
                const r = await topupFn({ data: { tenantId: id, packId } });
                if (r.ok) {
                  toast.success(`Top-up applied (+${fmt(r.tokens ?? 0)})`);
                  refresh();
                } else toast.error(r.error ?? "Failed");
              }}
            >
              Apply
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {data.jobs.length === 0 && <p className="text-muted-foreground">No jobs yet.</p>}
            {data.jobs.slice(0, 15).map((j: any) => (
              <div
                key={j.id}
                className="flex items-center justify-between gap-2 border-b border-border/40 py-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{j.kind}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(j.started_at).toLocaleString()} · {j.status}
                  </div>
                </div>
                <div className="text-right tabular-nums">
                  {j.charged_tokens != null ? fmt(j.charged_tokens) : "—"}
                </div>
                {j.status === "completed" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const r = await refundFn({
                        data: { jobId: j.id, reason: "Operator refund" },
                      });
                      if (r.ok) {
                        toast.success(`Refunded ${fmt(r.refunded_tokens ?? 0)}`);
                        refresh();
                      } else toast.error(r.error ?? "Failed");
                    }}
                  >
                    Refund
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Button variant="ghost" onClick={onClose} className="w-full">
          Close
        </Button>
      </div>
    </>
  );
}

// ─── Plans & Packs ───────────────────────────────────────────────────────────

function TenantUsageCard({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(getTenantUsageSummaryFn);
  const { data, isLoading } = useQuery({
    queryKey: ["tenant-usage", tenantId],
    queryFn: () => fn({ data: { tenantId } }),
  });
  if (isLoading)
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">Loading usage…</CardContent>
      </Card>
    );
  const s = data?.summary as any;
  if (!s) return null;
  const pct = s.allowance_used_pct == null ? null : Math.round(Number(s.allowance_used_pct));
  const burn = s.avg_per_day_7d ? Math.round(Number(s.avg_per_day_7d)).toLocaleString() : "—";
  const daysLeft = s.days_until_empty == null ? null : Math.round(Number(s.days_until_empty));
  const cancelRate = Math.round(Number(s.cancel_rate_24h ?? 0) * 100);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Usage &amp; burn rate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {pct != null && (
          <div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Monthly allowance</span>
              <span className="tabular-nums">
                {pct}% used · {fmt(s.period_spent)} / {fmt(s.monthly_allowance)}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden bg-muted">
              <div
                className={`h-full ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground">Burn (7d avg/day)</p>
            <p className="text-base font-semibold tabular-nums">{burn}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Last 24h</p>
            <p className="text-base font-semibold tabular-nums">{fmt(s.last_24h_spent)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Days until empty</p>
            <p className="text-base font-semibold tabular-nums">
              {daysLeft == null ? "∞" : daysLeft}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground">Cancel rate 24h</p>
            <p
              className={`text-base font-semibold tabular-nums ${cancelRate >= 25 ? "text-amber-500" : ""}`}
            >
              {cancelRate}%
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Projected exhaustion</p>
            <p className="text-base font-semibold">
              {s.projected_exhaustion ? new Date(s.projected_exhaustion).toLocaleDateString() : "—"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Webhooks ────────────────────────────────────────────────────────────────
