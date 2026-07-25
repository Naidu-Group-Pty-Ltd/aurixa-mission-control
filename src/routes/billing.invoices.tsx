// @ts-nocheck
// Operator invoices explorer + fleet wallet overview (billing & usage
// workflow): every Stripe invoice mirrored by the webhook — subscription
// cycles and one-time purchases alike — with hosted/PDF links, plus the
// saved cards on file across the fleet.
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  ExternalLink,
  FileText,
  ReceiptText,
} from "lucide-react";

import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
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
import { listInvoices, listPaymentMethodsAdmin } from "@/lib/invoices.functions";
import { useClones } from "@/lib/queries";

const ALL = "__all__";
const PAGE_SIZE = 50;

export const Route = createFileRoute("/billing/invoices")({
  component: () => (
    <ProtectedRoute>
      <InvoicesPage />
    </ProtectedRoute>
  ),
  validateSearch: (s) => z.object({ clone: z.string().uuid().optional() }).parse(s),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Invoices — Mission Control" }] }),
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
  paid: "bg-success/15 text-success",
  open: "bg-warning/15 text-warning",
  draft: "bg-muted text-muted-foreground",
  void: "bg-muted text-muted-foreground",
  uncollectible: "bg-destructive/15 text-destructive",
};

const ROLE_LABEL: Record<number, string> = { 1: "Primary", 2: "Secondary", 3: "Backup" };

function InvoicesPage() {
  const { clone: cloneParam } = Route.useSearch();

  const listFn = useServerFn(listInvoices);
  const walletFn = useServerFn(listPaymentMethodsAdmin);
  const { data: clones } = useClones();

  const [cloneId, setCloneId] = useState<string>(cloneParam ?? ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const filters = useMemo(
    () => ({
      cloneId: cloneId === ALL ? undefined : cloneId,
      status: status === ALL ? undefined : status,
      search: search.trim() || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [cloneId, status, search, page],
  );

  const listQ = useQuery({
    queryKey: ["invoices", filters],
    queryFn: () => listFn({ data: filters }),
  });
  const walletQ = useQuery({
    queryKey: ["fleet-wallets", cloneId],
    queryFn: () => walletFn({ data: { cloneId: cloneId === ALL ? undefined : cloneId } }),
    staleTime: 60_000,
  });

  const rows = listQ.data?.ok ? listQ.data.invoices : [];
  const total = listQ.data?.ok ? listQ.data.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cards = walletQ.data?.ok ? walletQ.data.paymentMethods : [];

  const resetPage =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(0);
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
          <ReceiptText className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
            billing
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Invoices &amp; Wallets</h1>
          <p className="text-sm text-muted-foreground">
            Every Stripe invoice across the fleet — subscription cycles and one-time purchases —
            plus the cards on file per workspace.
          </p>
        </div>
      </header>

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 py-4 md:grid-cols-5">
          <Input
            placeholder="Search number, user, item…"
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
          <Select value={status} onValueChange={resetPage(setStatus)}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {["paid", "open", "draft", "void", "uncollectible"].map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center justify-end">
            <span className="font-mono text-xs text-muted-foreground">
              {total.toLocaleString()} invoice{total === 1 ? "" : "s"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Invoice table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Invoice ledger</CardTitle>
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
              No invoices match these filters. Invoices appear here as the Stripe webhook mirrors
              them (subscription renewals, and one-time purchases made after invoice creation was
              enabled).
            </div>
          )}
          {rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Issued</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Clone</TableHead>
                  <TableHead>Purchased by</TableHead>
                  <TableHead className="text-right">Links</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {new Date(r.issued_at ?? r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.number ?? "—"}</TableCell>
                    <TableCell>
                      <Badge className={`text-[10px] ${STATUS_STYLE[r.status] ?? ""}`}>
                        {r.status ?? "unknown"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.item_name ?? r.description ?? r.item_slug ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {money(r.total_cents ?? r.amount_due_cents, r.currency)}
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
                      {r.origin_username ?? r.origin_user_id ?? (
                        <span className="text-muted-foreground">unknown</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1">
                        {r.hosted_invoice_url && (
                          <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                            <a
                              href={r.hosted_invoice_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Hosted invoice"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        )}
                        {r.invoice_pdf_url && (
                          <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                            <a
                              href={r.invoice_pdf_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Invoice PDF"
                            >
                              <FileText className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Fleet wallets */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Cards on file</CardTitle>
        </CardHeader>
        <CardContent>
          {walletQ.isLoading && (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
          )}
          {!walletQ.isLoading && cards.length === 0 && (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No saved cards yet. Cards are added by workspace users from their Billing &amp; Usage
              page (Stripe-hosted capture; only brand/last4/expiry are stored here).
            </div>
          )}
          {cards.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Card</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Added by</TableHead>
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cards.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-xs">
                      {c.clone_name ?? c.tenant_name ?? (
                        <span className="text-muted-foreground">Prime</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`text-[10px] ${c.priority === 1 ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
                      >
                        {ROLE_LABEL[c.priority] ?? `Slot ${c.priority}`}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs capitalize">
                      {c.brand ?? "card"} •••• {c.last4 ?? "????"}
                      {c.funding ? ` · ${c.funding}` : ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {c.exp_month && c.exp_year
                        ? `${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs">{c.origin_username ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {new Date(c.created_at).toLocaleDateString()}
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
