import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Download, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloneSecurityAssessments, getSecurityReportDownloadUrl } from "@/server/security-partner-dashboard.functions";
import { formatDistanceToNow } from "@/lib/format";

type Finding = { id: string; severity: string; status: string; retest_status: string; title: string };
type Report = {
  id: string;
  label: string;
  report_type: string;
  status: string;
  submitted_at: string;
  file_path?: string | null;
  file_url?: string | null;
};
type Assessment = {
  id: string;
  title: string;
  cycle: string;
  status: string;
  aurixa_review_status: string;
  due_at?: string | null;
  retest_required?: boolean;
  client_release_approved?: boolean;
  security_partners?: { name: string; slug: string } | null;
  security_findings?: Finding[];
  security_reports?: Report[];
};

function tone(status: string) {
  if (status === "closed") return "border-success/40 text-success";
  if (status === "blocked" || status === "canceled") return "border-destructive/40 text-destructive";
  if (["in_progress", "reporting", "retesting"].includes(status)) return "border-info/40 text-info";
  return "border-warning/40 text-warning";
}

function countOpen(findings: Finding[] = []) {
  return findings.filter((f) => f.status === "open" || f.status === "remediation_review").length;
}

export function CloneSecurityAssessmentsCard({ cloneId }: { cloneId: string }) {
  const loadAssessments = useServerFn(getCloneSecurityAssessments);
  const getDownloadUrl = useServerFn(getSecurityReportDownloadUrl);
  const [loading, setLoading] = useState(true);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [busyReportId, setBusyReportId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await loadAssessments({ data: { cloneId } });
      setAssessments((result.assessments ?? []) as Assessment[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load security assessments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneId]);

  const stats = useMemo(() => {
    const active = assessments.filter((a) => !["closed", "canceled"].includes(a.status)).length;
    const findings = assessments.flatMap((a) => a.security_findings ?? []);
    const reports = assessments.flatMap((a) => a.security_reports ?? []);
    return {
      active,
      openFindings: countOpen(findings),
      criticalFindings: findings.filter((f) => f.severity === "critical").length,
      reports: reports.length,
    };
  }, [assessments]);

  const openReport = async (report: Report) => {
    if (!report.file_url && !report.file_path) {
      toast.error("This report has no file attached yet");
      return;
    }
    setBusyReportId(report.id);
    try {
      const result = await getDownloadUrl({ data: { reportId: report.id, expiresIn: 600 } });
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open report");
    } finally {
      setBusyReportId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> Security assessments
          </CardTitle>
          <CardDescription>
            Partner penetration-testing cycles, reports, findings, retesting and Aurixa release control.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/security-partners" className="hidden md:inline-flex">
            <Button size="sm" variant="outline">Manage</Button>
          </Link>
          <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="font-mono text-xs text-muted-foreground">loading security cycles…</div>
        ) : assessments.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No security partner assessment is active for this clone yet. Activate the Cybersecurity Module from Security Partners.
          </div>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-4">
              <Metric label="Active cycles" value={stats.active} />
              <Metric label="Open findings" value={stats.openFindings} tone={stats.openFindings ? "text-warning" : "text-muted-foreground"} />
              <Metric label="Critical" value={stats.criticalFindings} tone={stats.criticalFindings ? "text-destructive" : "text-muted-foreground"} />
              <Metric label="Reports" value={stats.reports} tone="text-success" />
            </div>

            <div className="space-y-3">
              {assessments.map((assessment) => {
                const findings = assessment.security_findings ?? [];
                const reports = assessment.security_reports ?? [];
                return (
                  <div key={assessment.id} className="rounded-md border border-border bg-surface p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{assessment.title}</span>
                          <Badge variant="outline" className={tone(assessment.status)}>
                            {assessment.status.replaceAll("_", " ")}
                          </Badge>
                          <Badge variant="outline">{assessment.cycle.replace("_", "-")}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {assessment.security_partners?.name ?? "Security partner"} · review {assessment.aurixa_review_status.replaceAll("_", " ")}
                          {assessment.due_at ? ` · due ${formatDistanceToNow(assessment.due_at)}` : ""}
                        </div>
                      </div>
                      {assessment.retest_required && (
                        <Badge variant="outline" className="text-info">retest required</Badge>
                      )}
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          findings
                        </div>
                        {findings.length === 0 ? (
                          <div className="text-xs text-muted-foreground">No findings submitted yet.</div>
                        ) : (
                          <div className="space-y-1">
                            {findings.slice(0, 4).map((finding) => (
                              <div key={finding.id} className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1 text-xs">
                                <div className="flex items-center gap-2">
                                  <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="line-clamp-1">{finding.title}</span>
                                </div>
                                <Badge variant="outline" className={finding.severity === "critical" ? "text-destructive" : ""}>
                                  {finding.severity}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          reports
                        </div>
                        {reports.length === 0 ? (
                          <div className="text-xs text-muted-foreground">No reports submitted yet.</div>
                        ) : (
                          <div className="space-y-1">
                            {reports.slice(0, 4).map((report) => (
                              <button
                                key={report.id}
                                type="button"
                                onClick={() => openReport(report)}
                                disabled={busyReportId === report.id}
                                className="flex w-full items-center justify-between gap-2 rounded border border-border/60 px-2 py-1 text-left text-xs hover:border-primary/40 disabled:opacity-60"
                              >
                                <span className="inline-flex min-w-0 items-center gap-2">
                                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{report.label}</span>
                                </span>
                                <span className="inline-flex items-center gap-1 text-primary">
                                  <Download className="h-3 w-3" /> {report.report_type}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone = "text-primary" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
