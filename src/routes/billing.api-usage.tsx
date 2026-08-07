// @ts-nocheck
// Piggybacked API-key usage: what the fleet spends on the prime's vendor keys,
// who is spending it, and what has been billed back.
//
// The number that matters on this page is not the total — it is the split
// between "inherited" (running on our key, recharged) and "BYOK" (their key,
// free). A tenant looking at their own line should be able to see exactly what
// swapping in their own key would save them.
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Coins,
  KeyRound,
  Receipt,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getApiUsageOverview,
  listApiProviderRates,
  upsertApiProviderRate,
  invoiceApiUsageChargeFn,
  waiveApiUsageChargeFn,
} from "@/lib/api-usage.functions";
import { formatMicros, MICROS_PER_CENT } from "@/lib/api-usage-rating";
import { toCSV, downloadCSV } from "@/lib/csv";

export const Route = createFileRoute("/billing/api-usage")({
  component: () => (
    <ProtectedRoute>
      <ApiUsagePage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "API Usage — Mission Control" }] }),
});

function money(cents: number | null, currency = "AUD") {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function qty(n: number | null | undefined, unit: string) {
  if (n == null) return "—";
  const rounded = Number(n);
  const formatted =
    rounded >= 1000 ? new Intl.NumberFormat("en-AU").format(Math.round(rounded)) : String(rounded);
  return `${formatted} ${unit}${rounded === 1 ? "" : "s"}`;
}

const CHARGE_STATUS_STYLE: Record<string, string> = {
  open: "bg-muted text-muted-foreground",
  closed: "bg-warning/15 text-warning",
  invoiced: "bg-success/15 text-success",
  waived: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
};

function ApiUsagePage() {
  const overviewFn = useServerFn(getApiUsageOverview);
  const ratesFn = useServerFn(listApiProviderRates);
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: ["api-usage-overview"],
    queryFn: () => overviewFn({ data: {} }),
  });
  const rates = useQuery({ queryKey: ["api-provider-rates"], queryFn: () => ratesFn({}) });

  const summary = overview.data?.ok ? overview.data.summary : null;
  const tenants = (summary?.tenants ?? []) as Array<Record<string, unknown>>;
  const providers = (summary?.providers ?? []) as Array<Record<string, unknown>>;
  const charges = overview.data?.ok ? overview.data.charges : [];
  const gaps = overview.data?.ok ? overview.data.gaps : [];
  const canManage = overview.data?.ok ? overview.data.canManage : false;

  const totals = useMemo(() => {
    let charge = 0;
    let cost = 0;
    let events = 0;
    let errors = 0;
    for (const t of tenants) {
      charge += Number(t.charge_micros ?? 0);
      cost += Number(t.cost_micros ?? 0);
      events += Number(t.event_count ?? 0);
      errors += Number(t.error_count ?? 0);
    }
    return { charge, cost, events, errors, margin: charge - cost };
  }, [tenants]);

  const byokTotal = useMemo(
    () => providers.reduce((sum, p) => sum + Number(p.byok_quantity ?? 0), 0),
    [providers],
  );

  function exportTenants() {
    downloadCSV(
      `api-usage-${overview.data?.period ?? "period"}.csv`,
      toCSV(
        tenants.map((t) => ({
          tenant: t.tenant_name,
          clone: t.clone_name ?? "",
          events: t.event_count,
          errors: t.error_count,
          charge: Number(t.charge_micros ?? 0) / (MICROS_PER_CENT * 100),
          cost: Number(t.cost_micros ?? 0) / (MICROS_PER_CENT * 100),
          providers: t.providers,
        })),
      ),
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="API Usage"
        description="Third-party API spend made on the prime's forwarded keys, metered per tenant and recharged. A workspace running its own key is metered but never billed for it."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportTenants} disabled={!tenants.length}>
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                overview.refetch();
                rates.refetch();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {overview.data?.ok === false && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">{overview.data.error}</CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          icon={Coins}
          label="Billable this period"
          value={formatMicros(totals.charge)}
          hint={`${totals.events.toLocaleString()} call${totals.events === 1 ? "" : "s"} metered`}
        />
        <StatCard
          icon={TrendingUp}
          label="Our vendor cost"
          value={formatMicros(totals.cost)}
          hint={`Margin ${formatMicros(totals.margin)}`}
        />
        <StatCard
          icon={ShieldCheck}
          label="Covered by tenant keys"
          value={byokTotal.toLocaleString()}
          hint="Units run on a workspace's own key — never charged"
        />
        <StatCard
          icon={AlertTriangle}
          label="Unbillable calls"
          value={gaps.reduce((s, g) => s + g.count, 0).toLocaleString()}
          hint="Uncatalogued or unattributable — spend we cannot recover"
          tone={gaps.length ? "warning" : "default"}
        />
      </div>

      {gaps.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning" />
              Metered but not billable
            </CardTitle>
            <CardDescription>
              These calls ran and cost us money, but could not be charged. A{" "}
              <code className="text-xs">rate_missing</code> secret needs a row in the rate catalog;{" "}
              <code className="text-xs">unknown_secret</code> means the clone reported a key
              provisioning never recorded lending it — usually a reporter sending the wrong name.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Secret</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gaps.map((g) => (
                  <TableRow key={`${g.secret_name}:${g.reason}`}>
                    <TableCell className="font-mono text-xs">{g.secret_name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{g.reason}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{g.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="tenants">
        <TabsList>
          <TabsTrigger value="tenants">By tenant</TabsTrigger>
          <TabsTrigger value="providers">By provider</TabsTrigger>
          <TabsTrigger value="charges">Charges</TabsTrigger>
          <TabsTrigger value="rates">Rate catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="tenants" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {tenants.length === 0 ? (
                <EmptyState
                  icon={Coins}
                  title="No metered usage this period"
                  description="Clones report API consumption on the usage:report scope. If a clone is live and this is empty, check that its Mission Control key carries that scope."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant</TableHead>
                      <TableHead>Clone</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Errors</TableHead>
                      <TableHead className="text-right">Our cost</TableHead>
                      <TableHead className="text-right">Billable</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tenants.map((t) => (
                      <TableRow key={String(t.tenant_id)}>
                        <TableCell className="font-medium">
                          {String(t.tenant_name ?? "—")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {t.clone_id ? (
                            <Link
                              to="/clones/$cloneId"
                              params={{ cloneId: String(t.clone_id) }}
                              className="hover:underline"
                            >
                              {String(t.clone_name ?? t.clone_id)}
                            </Link>
                          ) : (
                            "Prime"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Number(t.event_count ?? 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Number(t.error_count ?? 0) > 0 ? (
                            <span className="text-warning">{Number(t.error_count)}</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatMicros(Number(t.cost_micros ?? 0))}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatMicros(Number(t.charge_micros ?? 0))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="providers" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Secret</TableHead>
                    <TableHead className="text-right">On our key</TableHead>
                    <TableHead className="text-right">On their key</TableHead>
                    <TableHead className="text-right">Tenants</TableHead>
                    <TableHead className="text-right">Billable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providers.map((p) => (
                    <TableRow key={String(p.secret_name)}>
                      <TableCell className="font-medium">{String(p.provider)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {String(p.secret_name)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {qty(Number(p.billable_quantity ?? 0), String(p.unit))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {Number(p.byok_quantity ?? 0) > 0
                          ? qty(Number(p.byok_quantity), String(p.unit))
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(p.tenant_count ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatMicros(Number(p.charge_micros ?? 0))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="charges" className="mt-4">
          <ChargesTable
            charges={charges}
            canManage={canManage}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ["api-usage-overview"] })}
          />
        </TabsContent>

        <TabsContent value="rates" className="mt-4">
          <RatesTable
            data={rates.data}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ["api-provider-rates"] })}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, hint, tone = "default" }) {
  return (
    <Card className={tone === "warning" ? "border-warning/50" : undefined}>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="h-4 w-4" />
          {label}
        </div>
        <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function ChargesTable({ charges, canManage, onChanged }) {
  const invoiceFn = useServerFn(invoiceApiUsageChargeFn);
  const waiveFn = useServerFn(waiveApiUsageChargeFn);
  const [busy, setBusy] = useState<string | null>(null);

  async function invoice(id: string) {
    setBusy(id);
    try {
      const res = await invoiceFn({ data: { charge_id: id } });
      if (!res.ok) toast.error(res.error);
      else if (res.skipped) toast.info(`Skipped: ${res.reason}`);
      else toast.success(`Added to the tenant's next invoice (${money(res.amountCents)})`);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function waive(id: string) {
    const reason = window.prompt("Why is this charge being written off?");
    if (!reason || reason.trim().length < 3) return;
    setBusy(id);
    try {
      const res = await waiveFn({ data: { charge_id: id, reason: reason.trim() } });
      if (!res.ok) toast.error(res.error);
      else toast.success("Charge waived — the meter is unchanged");
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  if (!charges?.length) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            icon={Receipt}
            title="Nothing settled yet"
            description="Periods close once they end. The nightly sweep closes them and adds what is owed to the tenant's next Stripe invoice."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Charged</TableHead>
              <TableHead>Stripe</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {charges.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="tabular-nums">
                  {c.period_start} → {c.period_end}
                </TableCell>
                <TableCell>
                  <Badge className={CHARGE_STATUS_STYLE[c.status] ?? ""} variant="secondary">
                    {c.status}
                  </Badge>
                  {c.last_error && (
                    <div className="mt-1 text-xs text-destructive">{c.last_error}</div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatMicros(Number(c.cost_micros ?? 0), c.currency)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {money(c.amount_cents, c.currency)}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {c.stripe_invoice_item_id ?? "—"}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    {c.status === "closed" && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" disabled={busy === c.id} onClick={() => invoice(c.id)}>
                          Invoice
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === c.id}
                          onClick={() => waive(c.id)}
                        >
                          Waive
                        </Button>
                      </div>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RatesTable({ data, onChanged }) {
  const upsertFn = useServerFn(upsertApiProviderRate);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const canManage = data?.ok ? data.canManage : false;

  async function save(secret: string, patch: Record<string, unknown>) {
    setBusy(secret);
    try {
      const res = await upsertFn({ data: { secret_name: secret, ...patch } });
      if (!res.ok) toast.error(res.error);
      else toast.success(`${secret} updated`);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  if (!data?.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {data?.error ?? "Loading…"}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          Rate catalog
        </CardTitle>
        <CardDescription>
          One row per secret name — the only identifier shared by the prime's edge functions, the
          forwarding whitelist and the per-clone secret record. Rates are in micros per unit (10,000
          micros = 1 cent) because per-token prices sit far below a cent. Repricing is never
          retroactive: an event is rated at ingest and stays rated.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Cost/unit</TableHead>
              <TableHead className="text-right">Charge/unit</TableHead>
              <TableHead className="text-right">Free/period</TableHead>
              <TableHead className="text-right">On our key</TableHead>
              <TableHead className="text-right">BYOK</TableHead>
              <TableHead>Billable</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rates.map((r) => (
              <TableRow key={r.secret_name} className={r.is_active ? undefined : "opacity-50"}>
                <TableCell>
                  <div className="font-medium">{r.display_name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{r.secret_name}</div>
                  {r.notes && (
                    <div className="mt-1 max-w-md text-xs text-muted-foreground">{r.notes}</div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.unit}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {Number(r.cost_micros_per_unit)}
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Input
                      className="ml-auto w-28 text-right tabular-nums"
                      defaultValue={String(r.resale_micros_per_unit)}
                      disabled={busy === r.secret_name}
                      onChange={(e) => setDraft((d) => ({ ...d, [r.secret_name]: e.target.value }))}
                      onBlur={() => {
                        const raw = draft[r.secret_name];
                        if (raw === undefined) return;
                        const next = Number(raw);
                        if (!Number.isFinite(next) || next < 0) {
                          toast.error("Rate must be a non-negative number");
                          return;
                        }
                        if (next === Number(r.resale_micros_per_unit)) return;
                        save(r.secret_name, { resale_micros_per_unit: next });
                      }}
                    />
                  ) : (
                    <span className="tabular-nums">{Number(r.resale_micros_per_unit)}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(r.included_free_units).toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.clones_inherited > 0 ? (
                    <Badge variant="secondary">{r.clones_inherited}</Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.clones_byok > 0 ? r.clones_byok : "—"}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={r.is_billable}
                    disabled={!canManage || busy === r.secret_name}
                    onCheckedChange={(v) => save(r.secret_name, { is_billable: v })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
