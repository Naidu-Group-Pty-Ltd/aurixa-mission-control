import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/empty-state";
import {
  ChevronLeft,
  ChevronRight,
  Receipt,
  RotateCw,
  X,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCcw,
  Coins,
} from "lucide-react";
import { getReportJob, listReportJobs, listTenants } from "@/lib/tokens.functions";
import { formatDistanceToNow } from "@/lib/format";

export const Route = createFileRoute("/report-jobs")({
  component: () => (
    <ProtectedRoute>
      <ReportJobsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Report Jobs — Mission Control" }] }),
});

type Status = "reserved" | "completed" | "canceled" | "refunded" | "failed" | "pending";

const STATUS_VARIANTS: Record<Status, "default" | "secondary" | "outline" | "destructive"> = {
  reserved: "outline",
  completed: "default",
  canceled: "secondary",
  refunded: "secondary",
  failed: "destructive",
  pending: "outline",
};

function fmt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString();
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function ReportJobsPage() {
  const listJobs = useServerFn(listReportJobs);
  const listTenantsFn = useServerFn(listTenants);

  const [tenantId, setTenantId] = useState<string | "all">("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(1);
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1);
  }, [tenantId, status, search, from, to, limit]);

  const tenantsQ = useQuery({
    queryKey: ["tenants", "all"],
    queryFn: () => listTenantsFn({ data: { limit: 500 } }),
  });

  const filters = useMemo(
    () => ({
      tenantId: tenantId === "all" ? undefined : tenantId,
      status: status === "all" ? undefined : status,
      search: search.trim() || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to + "T23:59:59").toISOString() : undefined,
      limit,
      page,
    }),
    [tenantId, status, search, from, to, limit, page],
  );

  const jobsQ = useQuery({
    queryKey: ["report-jobs", filters],
    queryFn: () => listJobs({ data: filters }),
  });

  const totals = jobsQ.data?.totals;
  const totalPages = jobsQ.data?.totalPages ?? 1;
  const count = jobsQ.data?.count ?? 0;

  const reset = () => {
    setTenantId("all");
    setStatus("all");
    setSearch("");
    setFrom("");
    setTo("");
    setLimit(50);
    setPage(1);
  };

  const startRow = count === 0 ? 0 : (page - 1) * limit + 1;
  const endRow = Math.min(page * limit, count);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
          <Receipt className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
            metering · admin
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Report Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Every token reservation, commit, cancel, and refund across the fleet.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => jobsQ.refetch()}>
          <RotateCw className="mr-2 h-3.5 w-3.5" /> Refresh
        </Button>
        <Link
          to="/settings/billing"
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          billing →
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Jobs" value={fmt(totals?.jobs)} />
        <StatCard label="Used" value={fmt(totals?.committed)} hint="tokens charged" />
        <StatCard label="Canceled" value={fmt(totals?.canceled)} hint="released" />
        <StatCard label="Refunded" value={fmt(totals?.refunded)} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Select value={tenantId} onValueChange={(v) => setTenantId(v as string)}>
            <SelectTrigger>
              <SelectValue placeholder="Tenant" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tenants</SelectItem>
              {(tenantsQ.data?.tenants ?? []).map((t: any) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.display_name ?? t.external_ref ?? t.id.slice(0, 8)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as Status | "all")}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="reserved">Reserved</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="canceled">Canceled</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search kind / idempotency"
          />
          <div className="flex gap-2">
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100, 250].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" onClick={reset} title="Clear filters">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {jobsQ.isLoading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (jobsQ.data?.jobs.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Receipt />}
              title="No report jobs match these filters"
              description="Adjust the date range or clear filters to see all activity."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Clone</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="font-mono text-[10px]">Idempotency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(jobsQ.data?.jobs ?? []).map((j: any) => (
                  <TableRow
                    key={j.id}
                    onClick={() => setOpenJobId(j.id)}
                    className="cursor-pointer"
                  >
                    <TableCell className="text-sm">
                      {j.tenants?.display_name ?? j.tenants?.external_ref ?? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {j.tenant_id ? j.tenant_id.slice(0, 8) : "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {j.clones?.name ?? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {j.clone_id ? j.clone_id.slice(0, 8) : "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{j.kind}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[j.status as Status] ?? "outline"}>
                        {j.status}
                      </Badge>
                      {j.error && (
                        <p className="mt-1 line-clamp-1 text-[10px] text-destructive">{j.error}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {j.charged_tokens != null ? fmt(j.charged_tokens) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDistanceToNow(j.started_at)}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {j.idempotency_key}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {count > 0 && (
            <div className="flex items-center justify-between border-t border-border p-3 text-xs text-muted-foreground">
              <span>
                Showing <strong className="text-foreground">{startRow.toLocaleString()}</strong>–
                <strong className="text-foreground">{endRow.toLocaleString()}</strong> of{" "}
                <strong className="text-foreground">{count.toLocaleString()}</strong>
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || jobsQ.isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Prev
                </Button>
                <span className="font-mono">
                  Page <strong className="text-foreground">{page}</strong> /{" "}
                  {totalPages.toLocaleString()}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || jobsQ.isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <JobDetailDrawer jobId={openJobId} onOpenChange={(open) => !open && setOpenJobId(null)} />
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Job detail drawer ─────────────────────────────────────────────────────

const LEDGER_ICON: Record<string, typeof Clock> = {
  reserve: Clock,
  release: XCircle,
  debit: CheckCircle2,
  refund: RefreshCcw,
  grant: Coins,
  topup: Coins,
  adjustment: Coins,
  expiry: XCircle,
};

const LEDGER_LABEL: Record<string, string> = {
  reserve: "Reserved",
  release: "Released",
  debit: "Committed (debit)",
  refund: "Refunded",
  grant: "Granted",
  topup: "Top-up",
  adjustment: "Adjustment",
  expiry: "Expired",
};

function JobDetailDrawer({
  jobId,
  onOpenChange,
}: {
  jobId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const getJob = useServerFn(getReportJob);
  const q = useQuery({
    queryKey: ["report-job", jobId],
    queryFn: () => getJob({ data: { id: jobId! } }),
    enabled: !!jobId,
  });

  const job: any = q.data?.job;
  const ledger: any[] = q.data?.ledger ?? [];

  return (
    <Sheet open={!!jobId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{job ? job.kind : "Report job"}</SheetTitle>
          <SheetDescription>
            {jobId && <span className="font-mono text-[10px]">{jobId}</span>}
          </SheetDescription>
        </SheetHeader>

        {q.isLoading || !job ? (
          <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* Summary */}
            <section className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Status">
                <Badge variant={STATUS_VARIANTS[job.status as Status] ?? "outline"}>
                  {job.status}
                </Badge>
              </Field>
              <Field label="Tenant">
                {job.tenants?.display_name ?? job.tenants?.external_ref ?? job.tenant_id}
              </Field>
              <Field label="Clone">{job.clones?.name ?? job.clone_id}</Field>
              <Field label="Idempotency key">
                <span className="font-mono text-[11px]">{job.idempotency_key}</span>
              </Field>
              <Field label="Charged tokens">
                {job.charged_tokens != null ? fmt(job.charged_tokens) : "—"}
              </Field>
              <Field label="Started">{fmtDateTime(job.started_at)}</Field>
              <Field label="Completed">{fmtDateTime(job.completed_at)}</Field>
              <Field label="Reservation expires">{fmtDateTime(job.reservation_expires_at)}</Field>
            </section>

            {/* Timeline */}
            <section>
              <h3 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Timeline
              </h3>
              {ledger.length === 0 ? (
                <p className="text-xs text-muted-foreground">No ledger entries.</p>
              ) : (
                <ol className="space-y-3 border-l border-border pl-4">
                  {ledger.map((e) => {
                    const Icon = LEDGER_ICON[e.kind] ?? Clock;
                    const positive =
                      e.kind === "grant" ||
                      e.kind === "topup" ||
                      e.kind === "refund" ||
                      e.kind === "release";
                    return (
                      <li key={e.id} className="relative">
                        <span className="absolute -left-[22px] flex h-4 w-4 items-center justify-center rounded-full bg-background ring-1 ring-border">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                        </span>
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="text-sm font-medium">{LEDGER_LABEL[e.kind] ?? e.kind}</p>
                          <span
                            className={
                              "font-mono text-xs tabular-nums " +
                              (positive ? "text-emerald-500" : "text-foreground")
                            }
                          >
                            {positive ? "+" : "−"}
                            {fmt(Math.abs(e.tokens))}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {fmtDateTime(e.created_at)}
                          {e.reason && <> · {e.reason}</>}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {/* Error */}
            {job.error && (
              <section>
                <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-destructive">
                  Error
                </h3>
                <pre className="overflow-x-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  {job.error}
                </pre>
              </section>
            )}

            {/* Request payload */}
            <section>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Request payload
              </h3>
              <JsonBlock value={job.request_payload} />
            </section>

            {/* Result meta */}
            {job.result_meta && Object.keys(job.result_meta).length > 0 && (
              <section>
                <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  Result metadata
                </h3>
                <JsonBlock value={job.result_meta} />
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    if (value == null) return "—";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px]">
      {text}
    </pre>
  );
}
