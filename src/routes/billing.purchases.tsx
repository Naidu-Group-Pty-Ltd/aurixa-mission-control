// @ts-nocheck
// Operator purchases explorer (user-attributed pricing workflow, Phase 4):
// every checkout across the fleet with who initiated it, from where.
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ShoppingCart,
  Users,
  Zap,
} from "lucide-react";

import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listPurchases, listPurchaseSources, purchaseRollups } from "@/lib/purchases.functions";
import { RestorePurchasesDialog } from "@/components/billing/restore-purchases-dialog";
import { formatMoneyByCurrency } from "@/lib/purchase-rollups";
import { useClones } from "@/lib/queries";
import { toCSV, downloadCSV } from "@/lib/csv";

const ALL = "__all__";
const PAGE_SIZE = 50;

export const Route = createFileRoute("/billing/purchases")({
  component: () => (
    <ProtectedRoute>
      <PurchasesPage />
    </ProtectedRoute>
  ),
  validateSearch: (s) => z.object({ clone: z.string().uuid().optional() }).parse(s),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Purchases — Mission Control" }] }),
});

function money(cents: number | null, currency: string | null) {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: (currency ?? "AUD").toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ""}`;
  }
}

const STATUS_STYLE: Record<string, string> = {
  completed: "bg-success/15 text-success",
  initiated: "bg-muted text-muted-foreground",
  abandoned: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
  refunded: "bg-warning/15 text-warning",
};

function PurchasesPage() {
  const { clone: cloneParam } = Route.useSearch();

  const listFn = useServerFn(listPurchases);
  const sourcesFn = useServerFn(listPurchaseSources);
  const rollupsFn = useServerFn(purchaseRollups);
  const { data: clones } = useClones();

  const [cloneId, setCloneId] = useState<string>(cloneParam ?? ALL);
  const [mode, setMode] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [source, setSource] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);

  const filters = useMemo(
    () => ({
      cloneId: cloneId === ALL ? undefined : cloneId,
      mode: mode === ALL ? undefined : mode,
      status: status === ALL ? undefined : status,
      originSource: source === ALL ? undefined : source,
      search: search.trim() || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [cloneId, mode, status, source, search, from, to, page],
  );

  const listQ = useQuery({
    queryKey: ["purchases", filters],
    queryFn: () => listFn({ data: filters }),
  });
  const sourcesQ = useQuery({
    queryKey: ["purchase-sources"],
    queryFn: () => sourcesFn(),
    staleTime: 300_000,
  });
  const rollupsQ = useQuery({
    queryKey: ["purchase-rollups", 30],
    queryFn: () => rollupsFn({ data: { days: 30 } }),
    staleTime: 60_000,
  });

  const rows = listQ.data?.ok ? listQ.data.purchases : [];
  const total = listQ.data?.ok ? listQ.data.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rollups = rollupsQ.data?.ok ? rollupsQ.data : null;
  const topClone = rollups?.byClone?.[0] ?? null;

  const resetPage =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(0);
    };

  const exportCsv = () => {
    downloadCSV(
      `purchases-${new Date().toISOString().slice(0, 10)}`,
      toCSV(
        rows.map((r) => ({
          created_at: r.created_at,
          status: r.status,
          mode: r.mode,
          item: r.item_slug ?? "",
          quantity: r.quantity,
          amount: r.amount_cents != null ? (r.amount_cents / 100).toFixed(2) : "",
          currency: r.currency ?? "",
          clone: r.clone_name ?? (r.clone_id ? r.clone_id : "prime"),
          origin_user_id: r.origin_user_id ?? "",
          origin_username: r.origin_username ?? "",
          origin_source: r.origin_source,
          stripe_session: r.stripe_checkout_session_id ?? "",
        })),
      ),
    );
  };

  return (
    <div className="space-y-6">
      <Link
        to="/settings/billing"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> billing
      </Link>

      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
          <ShoppingCart className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
            billing
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Purchases</h1>
          <p className="text-sm text-muted-foreground">
            Every checkout across the fleet — attributed to the clone and user who initiated it.
          </p>
        </div>
      </header>

      {/* 30-day rollups */}
      <div className="grid gap-3 md:grid-cols-4">
        <StatTile
          label="Revenue 30d"
          value={rollups ? formatMoneyByCurrency(rollups.revenueByCurrency) : "—"}
          icon={Zap}
        />
        <StatTile
          label="Purchases 30d"
          value={rollups?.completedCount ?? "—"}
          icon={ShoppingCart}
          hint={
            rollups?.adminActionCount
              ? `+ ${rollups.adminActionCount} discretionary admin action${rollups.adminActionCount === 1 ? "" : "s"}`
              : undefined
          }
        />
        <StatTile
          label="Clone-initiated"
          value={rollups ? `${Math.round(rollups.attributedShare * 100)}%` : "—"}
          icon={Users}
          hint={rollups ? `${rollups.attributedCount} of ${rollups.completedCount}` : undefined}
        />
        <StatTile
          label="Top clone 30d"
          value={
            topClone ? (topClone.cloneName ?? (topClone.cloneId ? "unnamed clone" : "Prime")) : "—"
          }
          hint={topClone ? formatMoneyByCurrency(topClone.revenue) : undefined}
        />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 py-4 md:grid-cols-6">
          <Input
            placeholder="Search user id, username, item…"
            value={search}
            onChange={(e) => resetPage(setSearch)(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={cloneId} onValueChange={resetPage(setCloneId)}>
            <SelectTrigger>
              <SelectValue placeholder="Clone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All clones</SelectItem>
              {(clones ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={resetPage(setMode)}>
            <SelectTrigger>
              <SelectValue placeholder="Mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All modes</SelectItem>
              <SelectItem value="topup">Top-up</SelectItem>
              <SelectItem value="seat_plan">Seat plan</SelectItem>
              <SelectItem value="setup_package">Setup package</SelectItem>
              <SelectItem value="admin_grant">Admin · token grant</SelectItem>
              <SelectItem value="admin_topup">Admin · comp top-up</SelectItem>
              <SelectItem value="admin_plan_change">Admin · plan change</SelectItem>
              <SelectItem value="admin_seat_change">Admin · seat change</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={resetPage(setStatus)}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {["completed", "initiated", "failed", "refunded", "abandoned"].map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={resetPage(setSource)}>
            <SelectTrigger>
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {(sourcesQ.data?.sources ?? []).map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 md:col-span-3">
            <Input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} />
          </div>
          <div className="flex items-center justify-end gap-2 md:col-span-3">
            <span className="font-mono text-xs text-muted-foreground">
              {total.toLocaleString()} purchase{total === 1 ? "" : "s"}
            </span>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> CSV (page)
            </Button>
            <RestorePurchasesDialog />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Ledger</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="font-mono text-xs text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {listQ.isLoading && (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          )}
          {!listQ.isLoading && rows.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No purchases match these filters.
            </div>
          )}
          {rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Clone</TableHead>
                  <TableHead>Purchased by</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${STATUS_STYLE[r.status] ?? ""}`}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.mode}</TableCell>
                    <TableCell className="font-mono text-xs">{r.item_slug ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{r.quantity}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {money(r.amount_cents, r.currency)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.clone_id ? (
                        <Link
                          to="/clones/$cloneId"
                          params={{ cloneId: r.clone_id }}
                          className="hover:underline"
                        >
                          {r.clone_name ?? r.clone_id.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Prime</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.origin_user_id ? (
                        <span
                          className="inline-flex items-center gap-1"
                          title={`origin_user_id: ${r.origin_user_id}`}
                        >
                          {r.origin_username ?? `${r.origin_user_id.slice(0, 8)}…`}
                          <CopyButton value={r.origin_user_id} label="origin user id" />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">unknown</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {r.origin_source}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: string | number;
  icon?: any;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-2 flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
        </div>
        <div className="truncate text-xl font-semibold" title={String(value)}>
          {value}
        </div>
        {hint && <div className="mt-1 font-mono text-[10px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
