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
import { enqueueScan, listScanJobs, getScanDetail } from "@/lib/codex-security.functions";
import { draftRemediationPR, listRemediations } from "@/lib/codex-remediation.functions";

export const Route = createFileRoute("/security/scans")({
  component: () => <CodexScansPage />,
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
