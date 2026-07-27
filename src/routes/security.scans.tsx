// @ts-nocheck
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { ShieldAlert, PlayCircle, RefreshCw, GitPullRequest, ExternalLink } from "lucide-react";
import { enqueueScan, listScanJobs, getScanDetail, getSchedulingConfig, updateSchedulingConfig, runNightlyNow, listCloneCodexOverview, runCloneScanNow, setCloneNightly } from "@/lib/codex-security.functions";
import { Link } from "@tanstack/react-router";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { draftRemediationPR, listRemediations } from "@/lib/codex-remediation.functions";
import {
  reviewRemediation,
  listRemediationReviews,
  mergeRemediationPR,
} from "@/lib/codex-remediation-reviews.functions";
import { useAuth } from "@/lib/auth";
import { Textarea } from "@/components/ui/textarea";
import { ThumbsUp, ThumbsDown, GitMerge, MessageSquareWarning } from "lucide-react";

import { ProtectedRoute } from "@/components/protected-route";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/security/scans")({
  component: () => (
    <ProtectedRoute>
      <AppShell>
        <CodexScansPage />
      </AppShell>
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Codex Security Scans — Aurixa Systems" }] }),
});

const sevColor: Record<string, string> = {
  critical: "bg-red-600",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-blue-500",
  info: "bg-slate-500",
};

function CodexScansPage() {
  const qc = useQueryClient();
  const [openJob, setOpenJob] = useState<string | null>(null);
  const jobsQ = useQuery({
    queryKey: ["codex-scan-jobs"],
    queryFn: () => listScanJobs(),
    refetchInterval: 15000,
  });
  const enqueue = useServerFn(enqueueScan);
  const runScan = useMutation({
    mutationFn: () => enqueue({ data: { kind: "manual", targetKind: "prime" } }),
    onSuccess: () => {
      toast.success("Scan queued");
      qc.invalidateQueries({ queryKey: ["codex-scan-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" /> Codex Security Scans
          </h1>
          <p className="text-sm text-muted-foreground">
            Autonomous repository scans powered by OpenAI Codex Security.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => jobsQ.refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
          <Button onClick={() => runScan.mutate()} disabled={runScan.isPending}>
            <PlayCircle className="h-4 w-4 mr-1" />
            {runScan.isPending ? "Queuing…" : "Scan Prime Now"}
          </Button>
        </div>
      </div>

      <SchedulingPanel />

      <FleetOverviewPanel />

      <Card>

        <CardHeader>
          <CardTitle>Recent scans</CardTitle>
          <CardDescription>Last 100 jobs across Prime and clone fleet.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobsQ.data?.jobs ?? []).map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell className="font-mono text-xs">{j.repo_full_name}</TableCell>
                  <TableCell>{j.kind}</TableCell>
                  <TableCell>
                    <Badge variant={j.status === "failed" ? "destructive" : "outline"}>
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{j.started_at?.slice(0, 19).replace("T", " ") || "—"}</TableCell>
                  <TableCell className="text-xs">{j.completed_at?.slice(0, 19).replace("T", " ") || "—"}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setOpenJob(j.id)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!jobsQ.isLoading && (jobsQ.data?.jobs ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No scans yet. Trigger one to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Sheet open={!!openJob} onOpenChange={(v) => !v && setOpenJob(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {openJob && <ScanDetail jobId={openJob} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ScanDetail({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["codex-scan-detail", jobId],
    queryFn: () => getScanDetail({ data: { jobId } }),
    refetchInterval: 10000,
  });
  const remQ = useQuery({
    queryKey: ["codex-remediations", jobId],
    queryFn: () => listRemediations({ data: { jobId } }),
    refetchInterval: 10000,
  });
  const draftFn = useServerFn(draftRemediationPR);
  const draft = useMutation({
    mutationFn: (findingId: string) => draftFn({ data: { findingId } }),
    onSuccess: (r: any) => {
      toast.success(r?.reused ? "Existing remediation reused" : "Draft fix PR dispatched");
      qc.invalidateQueries({ queryKey: ["codex-remediations", jobId] });
      qc.invalidateQueries({ queryKey: ["codex-scan-detail", jobId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const d = q.data;
  const remByFinding: Record<string, any> = {};
  for (const r of remQ.data?.remediations ?? []) {
    if (!remByFinding[r.finding_id]) remByFinding[r.finding_id] = r;
  }
  return (
    <div className="space-y-4">
      <SheetHeader>
        <SheetTitle>Scan Detail</SheetTitle>
      </SheetHeader>
      {!d ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="text-sm space-y-1">
            <div><span className="text-muted-foreground">Repo:</span> {d.job.repo_full_name}</div>
            <div><span className="text-muted-foreground">Status:</span> {d.job.status}</div>
            {d.job.last_error && (
              <div className="text-red-500 text-xs whitespace-pre-wrap">{d.job.last_error}</div>
            )}
          </div>
          <div>
            <h3 className="font-semibold mb-2">Findings ({d.findings.length})</h3>
            <div className="space-y-2">
              {d.findings.map((f: any) => {
                const rem = remByFinding[f.id];
                const canDraft = !rem || ["failed", "closed"].includes(rem.status);
                return (
                  <div key={f.id} className="border rounded p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${sevColor[f.severity]}`} />
                      <span className="font-medium">{f.title}</span>
                      <Badge variant="outline" className="ml-auto">{f.state}</Badge>
                    </div>
                    {f.affected_file && (
                      <div className="text-xs font-mono text-muted-foreground">
                        {f.affected_file}{f.affected_line ? `:${f.affected_line}` : ""}
                      </div>
                    )}
                    {f.description && <p className="text-xs">{f.description}</p>}
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <Button
                        size="sm"
                        variant={canDraft ? "default" : "outline"}
                        onClick={() => draft.mutate(f.id)}
                        disabled={draft.isPending || !canDraft}
                      >
                        <GitPullRequest className="h-3 w-3 mr-1" />
                        {rem ? (canDraft ? "Retry Fix PR" : "Fix in flight") : "Draft Fix PR"}
                      </Button>
                      {rem && (
                        <Badge variant="outline" className="text-[10px]">rem: {rem.status}</Badge>
                      )}
                      {rem?.pr_url && (
                        <a
                          href={rem.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs inline-flex items-center gap-1 text-blue-500 hover:underline"
                        >
                          PR #{rem.pr_number} <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {rem?.workflow_run_url && (
                        <a
                          href={rem.workflow_run_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs inline-flex items-center gap-1 text-muted-foreground hover:underline"
                        >
                          run <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {rem?.last_error && (
                        <span className="text-[10px] text-red-500">{rem.last_error}</span>
                      )}
                    </div>
                    {rem && !["failed", "closed"].includes(rem.status) && (
                      <RemediationReviewPanel remediation={rem} />
                    )}
                  </div>
                );
              })}
              {d.findings.length === 0 && (
                <p className="text-xs text-muted-foreground">No findings recorded yet.</p>
              )}
            </div>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Event log</h3>
            <div className="text-xs font-mono space-y-1 max-h-64 overflow-y-auto">
              {d.events.map((e: any) => (
                <div key={e.id}>
                  <span className="text-muted-foreground">{e.created_at.slice(11, 19)}</span>{" "}
                  {e.event_type}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RemediationReviewPanel({ remediation }: { remediation: any }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const uid = user?.id;
  const [comment, setComment] = useState("");
  const reviewsQ = useQuery({
    queryKey: ["codex-rem-reviews", remediation.id],
    queryFn: () => listRemediationReviews({ data: { remediationId: remediation.id } }),
    refetchInterval: 10000,
  });
  const reviewFn = useServerFn(reviewRemediation);
  const mergeFn = useServerFn(mergeRemediationPR);
  const review = useMutation({
    mutationFn: (decision: "approve" | "reject" | "changes_requested") =>
      reviewFn({ data: { remediationId: remediation.id, decision, comment: comment || undefined } }),
    onSuccess: () => {
      toast.success("Review recorded");
      setComment("");
      qc.invalidateQueries({ queryKey: ["codex-rem-reviews", remediation.id] });
      qc.invalidateQueries({ queryKey: ["codex-remediations"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const merge = useMutation({
    mutationFn: () => mergeFn({ data: { remediationId: remediation.id } }),
    onSuccess: (r: any) => {
      const sha = r?.sha ? ` ${r.sha.slice(0, 7)}` : "";
      if (r?.cascadeEventId) {
        toast.success(`Merged${sha} — cascade queued`);
      } else if (r?.cascadeError) {
        toast.warning(`Merged${sha}, cascade skipped: ${r.cascadeError}`);
      } else {
        toast.success(`Merged${sha}`);
      }
      qc.invalidateQueries({ queryKey: ["codex-remediations"] });
      qc.invalidateQueries({ queryKey: ["codex-rem-reviews", remediation.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviews = reviewsQ.data?.reviews ?? [];
  const approvers = new Set(
    reviews
      .filter((r: any) => r.decision === "approve" && r.reviewer_id !== remediation.requested_by)
      .map((r: any) => r.reviewer_id),
  );
  const rejected = reviews.some((r: any) => r.decision === "reject");
  const required = remediation.approvals_required ?? 2;
  const isRequester = uid && uid === remediation.requested_by;
  const alreadyReviewed = reviews.some((r: any) => r.reviewer_id === uid);
  const canMerge =
    !!remediation.pr_number &&
    approvers.size >= required &&
    !rejected &&
    !["merged", "rejected"].includes(remediation.status);

  return (
    <div className="mt-2 border-t pt-2 space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          Approvals: <b className={approvers.size >= required ? "text-emerald-500" : ""}>{approvers.size}</b>/{required}
        </span>
        {rejected && <Badge variant="destructive" className="text-[10px]">rejected</Badge>}
        {remediation.status === "approved" && (
          <Badge className="text-[10px] bg-emerald-600">approved</Badge>
        )}
        {remediation.status === "merged" && (
          <Badge className="text-[10px] bg-blue-600">merged</Badge>
        )}
        {remediation.cascade_event_id && (
          <a
            href={`/cascades/${remediation.cascade_event_id}`}
            className="underline underline-offset-2 hover:text-foreground"
            title="Fleet cascade of this patch"
          >
            cascade →
          </a>
        )}
      </div>
      {reviews.length > 0 && (
        <div className="text-[10px] space-y-0.5">
          {reviews.map((r: any) => (
            <div key={r.id} className="flex gap-2">
              <span className="font-mono">{r.reviewer_id.slice(0, 8)}</span>
              <Badge
                variant="outline"
                className={
                  r.decision === "approve"
                    ? "text-emerald-500 border-emerald-500/40"
                    : r.decision === "reject"
                      ? "text-red-500 border-red-500/40"
                      : "text-amber-500 border-amber-500/40"
                }
              >
                {r.decision}
              </Badge>
              {r.comment && <span className="italic text-muted-foreground truncate">{r.comment}</span>}
            </div>
          ))}
        </div>
      )}
      {!isRequester && !["merged", "rejected"].includes(remediation.status) && (
        <div className="space-y-1">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={alreadyReviewed ? "Update comment (optional)" : "Review comment (optional)"}
            className="text-xs min-h-[48px]"
          />
          <div className="flex gap-1 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => review.mutate("approve")}
              disabled={review.isPending}
            >
              <ThumbsUp className="h-3 w-3 mr-1" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => review.mutate("changes_requested")}
              disabled={review.isPending}
            >
              <MessageSquareWarning className="h-3 w-3 mr-1" /> Request changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs text-red-500 border-red-500/40 hover:bg-red-500/10"
              onClick={() => review.mutate("reject")}
              disabled={review.isPending}
            >
              <ThumbsDown className="h-3 w-3 mr-1" /> Reject
            </Button>
          </div>
        </div>
      )}
      {isRequester && (
        <p className="text-[10px] text-muted-foreground">
          You requested this remediation — you can't approve your own.
        </p>
      )}
      <div>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => merge.mutate()}
          disabled={!canMerge || merge.isPending}
        >
          <GitMerge className="h-3 w-3 mr-1" />
          {merge.isPending
            ? "Merging…"
            : canMerge
              ? "Merge PR"
              : `Needs ${Math.max(0, required - approvers.size)} more approval${required - approvers.size === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

function SchedulingPanel() {
  const qc = useQueryClient();
  const cfgQ = useQuery({
    queryKey: ["codex-scheduling-config"],
    queryFn: () => getSchedulingConfig(),
  });
  const updateFn = useServerFn(updateSchedulingConfig);
  const runNowFn = useServerFn(runNightlyNow);
  const [dedup, setDedup] = useState<number | null>(null);
  const [cron, setCron] = useState<string | null>(null);

  const cfg = cfgQ.data?.config;

  const save = useMutation({
    mutationFn: (patch: any) => updateFn({ data: patch }),
    onSuccess: () => {
      toast.success("Scheduling updated");
      qc.invalidateQueries({ queryKey: ["codex-scheduling-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runNow = useMutation({
    mutationFn: () => runNowFn({}),
    onSuccess: (r: any) => {
      toast.success(`Nightly triggered — ${r.enqueued?.length ?? 0} queued, ${r.skipped?.length ?? 0} skipped`);
      qc.invalidateQueries({ queryKey: ["codex-scan-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!cfg) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle>Perpetual scheduling</CardTitle>
          <CardDescription>
            Nightly full scans, PR-driven scans, and post-merge revalidation.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
          <PlayCircle className="h-4 w-4 mr-1" />
          {runNow.isPending ? "Running…" : "Run nightly now"}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="font-medium">Nightly full scans</Label>
            <p className="text-xs text-muted-foreground">Prime + every clone with nightly enabled.</p>
          </div>
          <Switch
            checked={!!cfg.codex_nightly_enabled}
            onCheckedChange={(v) => save.mutate({ codex_nightly_enabled: v })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="font-medium">PR-open scans</Label>
            <p className="text-xs text-muted-foreground">Scan every opened / updated PR head SHA.</p>
          </div>
          <Switch
            checked={!!cfg.codex_pr_scan_enabled}
            onCheckedChange={(v) => save.mutate({ codex_pr_scan_enabled: v })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="font-medium">Post-merge revalidate</Label>
            <p className="text-xs text-muted-foreground">Re-scan Prime after each merge to catch fix regressions.</p>
          </div>
          <Switch
            checked={cfg.codex_post_merge_revalidate !== false}
            onCheckedChange={(v) => save.mutate({ codex_post_merge_revalidate: v })}
          />
        </div>
        <div className="rounded-md border p-3 space-y-2">
          <Label className="font-medium">Dedup window (hours)</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              max={168}
              defaultValue={cfg.codex_scan_dedup_hours ?? 6}
              onChange={(e) => setDedup(Number(e.target.value))}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={dedup === null || dedup === cfg.codex_scan_dedup_hours}
              onClick={() => save.mutate({ codex_scan_dedup_hours: dedup })}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Suppress duplicate scans for the same target+kind within this window.
          </p>
        </div>
        <div className="rounded-md border p-3 space-y-2 md:col-span-2">
          <Label className="font-medium">Nightly cron schedule (UTC)</Label>
          <div className="flex gap-2">
            <Input
              defaultValue={cfg.codex_nightly_cron ?? "0 7 * * *"}
              placeholder="0 7 * * *"
              onChange={(e) => setCron(e.target.value)}
              className="font-mono"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={cron === null || cron === cfg.codex_nightly_cron}
              onClick={() => save.mutate({ codex_nightly_cron: cron })}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Recorded for reference — the active schedule is set in pg_cron. Update the cron job SQL to change fire time.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const sevBadge: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  info: "bg-slate-500 text-white",
};

function FleetOverviewPanel() {
  const qc = useQueryClient();
  const fleetQ = useQuery({
    queryKey: ["codex-fleet-overview"],
    queryFn: () => listCloneCodexOverview(),
    refetchInterval: 30000,
  });
  const runFn = useServerFn(runCloneScanNow);
  const nightlyFn = useServerFn(setCloneNightly);

  const runOne = useMutation({
    mutationFn: (cloneId: string) => runFn({ data: { cloneId } }),
    onSuccess: (r: any) => {
      if (r?.skipped) toast.info(`Skipped: ${r.reason}`);
      else toast.success("Scan queued");
      qc.invalidateQueries({ queryKey: ["codex-fleet-overview"] });
      qc.invalidateQueries({ queryKey: ["codex-scan-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scanAll = useMutation({
    mutationFn: async () => {
      const rows = fleetQ.data?.clones ?? [];
      let queued = 0;
      let skipped = 0;
      for (const c of rows) {
        try {
          const r: any = await runFn({ data: { cloneId: c.id } });
          if (r?.skipped) skipped++;
          else queued++;
        } catch { skipped++; }
      }
      return { queued, skipped };
    },
    onSuccess: (r) => {
      toast.success(`Fleet scan: ${r.queued} queued, ${r.skipped} skipped`);
      qc.invalidateQueries({ queryKey: ["codex-fleet-overview"] });
      qc.invalidateQueries({ queryKey: ["codex-scan-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleNightly = useMutation({
    mutationFn: ({ cloneId, enabled }: { cloneId: string; enabled: boolean }) =>
      nightlyFn({ data: { cloneId, enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["codex-fleet-overview"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = fleetQ.data?.clones ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle>Clone fleet</CardTitle>
          <CardDescription>
            Per-clone Codex status, open findings, and nightly enrollment.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => scanAll.mutate()}
          disabled={scanAll.isPending || rows.length === 0}
        >
          <PlayCircle className="h-4 w-4 mr-1" />
          {scanAll.isPending ? "Queuing…" : "Scan every clone"}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Clone</TableHead>
              <TableHead>Last scan</TableHead>
              <TableHead>Open findings</TableHead>
              <TableHead>Nightly</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c: any) => {
              const last = c.lastScan;
              const of = c.openFindings ?? {};
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link
                      to="/clones/$cloneId"
                      params={{ cloneId: c.id }}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-muted-foreground font-mono">
                      {c.repo_full_name || `${c.github_owner ?? ""}/${c.github_repo ?? ""}`}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {last ? (
                      <div className="space-y-1">
                        <Badge variant={last.status === "failed" ? "destructive" : "outline"}>
                          {last.status}
                        </Badge>
                        <div className="text-muted-foreground">
                          {(last.completed_at ?? last.started_at ?? last.created_at)?.slice(0, 19).replace("T", " ")}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {["critical", "high", "medium", "low"].map((s) =>
                        (of[s] ?? 0) > 0 ? (
                          <Badge key={s} className={sevBadge[s]}>
                            {s[0].toUpperCase()}:{of[s]}
                          </Badge>
                        ) : null,
                      )}
                      {["critical", "high", "medium", "low"].every((s) => !(of[s] > 0)) && (
                        <span className="text-xs text-muted-foreground">Clean</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={c.codex_nightly_enabled !== false}
                      onCheckedChange={(v) => toggleNightly.mutate({ cloneId: c.id, enabled: v })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => runOne.mutate(c.id)}
                      disabled={runOne.isPending}
                    >
                      Scan
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {!fleetQ.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No clones yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
