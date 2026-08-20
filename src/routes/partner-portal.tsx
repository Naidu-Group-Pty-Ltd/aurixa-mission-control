import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  LogOut,
  MessageSquare,
  RefreshCw,
  Shield,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MetricCell } from "@/components/metric-bar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addSecurityAssessmentComment,
  createSecurityFinding,
  createSecurityReport,
  getPartnerPortal,
  SECURITY_ASSESSMENT_STATUSES,
  updatePartnerAssessment,
  updateSecurityFinding,
} from "@/server/security-partner-portal.functions";
import { getSecurityReportDownloadUrl } from "@/server/security-partner-dashboard.functions";

export const Route = createFileRoute("/partner-portal")({
  component: PartnerPortalPage,
  head: () => ({ meta: [{ title: "Security Partner Portal — Aurixa" }] }),
});

type Assessment = {
  id: string;
  title: string;
  cycle: string;
  status: string;
  aurixa_review_status: string;
  scope_summary?: string | null;
  rules_of_engagement?: string | null;
  exclusions?: string | null;
  target_urls?: string[] | null;
  testing_window_start?: string | null;
  testing_window_end?: string | null;
  emergency_stop_contact?: string | null;
  escalation_contacts?: string[] | null;
  due_at?: string | null;
  clones?: { id: string; name: string; deploy_url?: string | null; tags?: string[] | null } | null;
  security_findings?: Finding[];
  security_reports?: ReportRecord[];
  security_assessment_comments?: CommentRecord[];
  security_assessment_events?: EventRecord[];
};

type Finding = {
  id: string;
  title: string;
  severity: string;
  status: string;
  retest_status: string;
  affected_asset?: string | null;
  description?: string | null;
  recommendation?: string | null;
};

type ReportRecord = {
  id: string;
  label: string;
  report_type: string;
  status: string;
  file_url?: string | null;
  file_path?: string | null;
  notes?: string | null;
  submitted_at: string;
};

type CommentRecord = { id: string; author_kind: string; body: string; created_at: string };
type EventRecord = {
  id: string;
  actor_kind: string;
  event_type: string;
  body?: string | null;
  created_at: string;
};

const PARTNER_STATUS_OPTIONS = SECURITY_ASSESSMENT_STATUSES.filter((status) =>
  [
    "pending",
    "scheduled",
    "in_progress",
    "reporting",
    "remediation_review",
    "retesting",
    "closed",
    "blocked",
  ].includes(status),
);

function splitList(input: string) {
  return input
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function toInputDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function statusTone(status: string) {
  if (status === "closed") return "border-success/40 text-success";
  if (status === "blocked" || status === "canceled")
    return "border-destructive/40 text-destructive";
  if (["in_progress", "reporting", "retesting"].includes(status)) return "border-info/40 text-info";
  return "border-warning/40 text-warning";
}

function safeFileName(name: string) {
  return (
    name
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "security-report"
  );
}

function PartnerPortalPage() {
  const { session, loading: authLoading, user, signOut } = useAuth();
  const nav = useNavigate();
  const portalFn = useServerFn(getPartnerPortal);
  const updateAssessmentFn = useServerFn(updatePartnerAssessment);
  const createFindingFn = useServerFn(createSecurityFinding);
  const updateFindingFn = useServerFn(updateSecurityFinding);
  const createReportFn = useServerFn(createSecurityReport);
  const commentFn = useServerFn(addSecurityAssessmentComment);
  const getDownloadUrl = useServerFn(getSecurityReportDownloadUrl);

  const [loading, setLoading] = useState(true);
  const [portal, setPortal] = useState<any | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [status, setStatus] = useState("pending");
  const [scopeSummary, setScopeSummary] = useState("");
  const [rulesOfEngagement, setRulesOfEngagement] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [targetUrls, setTargetUrls] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [emergencyStop, setEmergencyStop] = useState("");
  const [escalationContacts, setEscalationContacts] = useState("");
  const [statusNote, setStatusNote] = useState("");

  const [findingTitle, setFindingTitle] = useState("");
  const [findingSeverity, setFindingSeverity] = useState("medium");
  const [findingAsset, setFindingAsset] = useState("");
  const [findingDescription, setFindingDescription] = useState("");
  const [findingEvidence, setFindingEvidence] = useState("");
  const [findingRecommendation, setFindingRecommendation] = useState("");

  const [reportLabel, setReportLabel] = useState("");
  const [reportType, setReportType] = useState("draft");
  const [reportUrl, setReportUrl] = useState("");
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [reportNotes, setReportNotes] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (authLoading) return;
    if (!session)
      (nav as any)({ to: "/auth", search: { redirect: "/partner-portal", intent: "partner" } });
  }, [authLoading, session, nav]);

  const load = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const result = await portalFn();
      setPortal(result);
      const first = result.ok ? result.assessments?.[0]?.id : null;
      setSelectedId((current) => current || first || null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load partner portal");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const assessments = ((portal?.assessments ?? []) as Assessment[]).sort(
    (a, b) =>
      new Date(b.due_at ?? b.testing_window_start ?? 0).getTime() -
      new Date(a.due_at ?? a.testing_window_start ?? 0).getTime(),
  );
  const selected =
    assessments.find((assessment) => assessment.id === selectedId) ?? assessments[0] ?? null;

  useEffect(() => {
    if (!selected) return;
    setStatus(selected.status);
    setScopeSummary(selected.scope_summary ?? "");
    setRulesOfEngagement(selected.rules_of_engagement ?? "");
    setExclusions(selected.exclusions ?? "");
    setTargetUrls((selected.target_urls ?? []).join("\n"));
    setWindowStart(toInputDate(selected.testing_window_start));
    setWindowEnd(toInputDate(selected.testing_window_end));
    setEmergencyStop(selected.emergency_stop_contact ?? "");
    setEscalationContacts(((selected.escalation_contacts ?? []) as string[]).join("\n"));
    setStatusNote("");
  }, [selected?.id]);

  const stats = useMemo(() => {
    const openFindings = assessments.reduce(
      (sum, assessment) =>
        sum +
        (assessment.security_findings ?? []).filter((finding) => finding.status === "open").length,
      0,
    );
    const reports = assessments.reduce(
      (sum, assessment) => sum + (assessment.security_reports ?? []).length,
      0,
    );
    return {
      assigned: assessments.length,
      active: assessments.filter(
        (assessment) => !["closed", "canceled"].includes(assessment.status),
      ).length,
      openFindings,
      reports,
    };
  }, [assessments]);

  const updateAssessment = async () => {
    if (!selected) return;
    setBusy("assessment");
    try {
      await updateAssessmentFn({
        data: {
          assessmentId: selected.id,
          status: status as any,
          scopeSummary,
          rulesOfEngagement,
          exclusions,
          targetUrls: splitList(targetUrls),
          testingWindowStart: windowStart ? new Date(windowStart).toISOString() : null,
          testingWindowEnd: windowEnd ? new Date(windowEnd).toISOString() : null,
          emergencyStopContact: emergencyStop,
          escalationContacts: splitList(escalationContacts),
          note: statusNote,
        },
      });
      toast.success("Assessment workflow updated");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const createFinding = async () => {
    if (!selected) return;
    if (!findingTitle.trim()) return toast.error("Finding title is required");
    setBusy("finding");
    try {
      await createFindingFn({
        data: {
          assessmentId: selected.id,
          title: findingTitle,
          severity: findingSeverity as any,
          affectedAsset: findingAsset,
          description: findingDescription,
          evidence: findingEvidence,
          recommendation: findingRecommendation,
        },
      });
      toast.success("Finding uploaded");
      setFindingTitle("");
      setFindingSeverity("medium");
      setFindingAsset("");
      setFindingDescription("");
      setFindingEvidence("");
      setFindingRecommendation("");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add finding");
    } finally {
      setBusy(null);
    }
  };

  const updateFinding = async (
    findingId: string,
    patch: { status?: string; retestStatus?: string },
  ) => {
    setBusy(`finding:${findingId}`);
    try {
      await updateFindingFn({
        data: { findingId, status: patch.status as any, retestStatus: patch.retestStatus as any },
      });
      toast.success("Finding updated");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Finding update failed");
    } finally {
      setBusy(null);
    }
  };

  const createReport = async () => {
    if (!selected) return;
    if (!reportLabel.trim()) return toast.error("Report label is required");
    if (!reportFile && !reportUrl.trim())
      return toast.error("Attach a file or provide a secure file URL");
    setBusy("report");
    try {
      let filePath: string | undefined;
      if (reportFile) {
        filePath = `${selected.id}/${Date.now()}-${safeFileName(reportFile.name)}`;
        const { error } = await supabase.storage
          .from("security-reports")
          .upload(filePath, reportFile, {
            cacheControl: "3600",
            contentType: reportFile.type || "application/octet-stream",
            upsert: false,
          });
        if (error) throw new Error(error.message);
      }

      await createReportFn({
        data: {
          assessmentId: selected.id,
          label: reportLabel,
          reportType: reportType as any,
          fileUrl: reportUrl,
          filePath,
          notes: reportNotes,
        },
      });
      toast.success("Report submitted to Aurixa review");
      setReportLabel("");
      setReportType("draft");
      setReportUrl("");
      setReportFile(null);
      setReportNotes("");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit report");
    } finally {
      setBusy(null);
    }
  };

  const openReport = async (report: ReportRecord) => {
    if (!report.file_url && !report.file_path)
      return toast.error("This report has no file attached");
    setBusy(`report:${report.id}`);
    try {
      const result = await getDownloadUrl({ data: { reportId: report.id, expiresIn: 600 } });
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open report");
    } finally {
      setBusy(null);
    }
  };

  const addComment = async () => {
    if (!selected || !comment.trim()) return;
    setBusy("comment");
    try {
      await commentFn({
        data: { assessmentId: selected.id, body: comment, visibility: "partner_thread" },
      });
      toast.success("Message sent");
      setComment("");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Message failed");
    } finally {
      setBusy(null);
    }
  };

  if (authLoading || loading) {
    return (
      <PortalFrame userEmail={user?.email} onSignOut={signOut}>
        <div className="flex min-h-[60vh] items-center justify-center font-mono text-sm text-muted-foreground">
          loading partner portal…
        </div>
      </PortalFrame>
    );
  }

  if (!session) return null;

  if (!portal?.ok) {
    return (
      <PortalFrame userEmail={user?.email} onSignOut={signOut}>
        <Card className="mx-auto mt-12 max-w-xl border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" /> Access pending
            </CardTitle>
            <CardDescription>
              This account does not have an active cybersecurity partner membership yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Aurixa must approve each partner user individually before any assigned testing cycles
              are visible.
            </p>
            <div className="border border-border bg-surface p-3 font-mono text-xs">
              {user?.email}
            </div>
            <Button variant="outline" onClick={load}>
              <RefreshCw className="mr-2 h-4 w-4" /> Check access again
            </Button>
          </CardContent>
        </Card>
      </PortalFrame>
    );
  }

  return (
    <PortalFrame userEmail={user?.email} onSignOut={signOut}>
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-mono">restricted cybersecurity module</p>
            <h1 className="mt-1 flex items-center gap-2 font-display text-[2.125rem] leading-[1.05]">
              <Shield className="h-7 w-7 text-primary" />{" "}
              {portal.activePartner?.name ?? "Security Partner Portal"}
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Access is limited to approved clients and approved penetration-testing cycles. Aurixa
              retains Mission Control authority, client communication, remediation coordination and
              report release.
            </p>
          </div>
          <Button variant="outline" onClick={load} disabled={busy !== null}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        </header>

        <section className="glass grid overflow-hidden md:grid-cols-4">
          <StatTile label="Assigned cycles" value={stats.assigned} />
          <StatTile label="Active" value={stats.active} tone="text-info" />
          <StatTile label="Open findings" value={stats.openFindings} tone="text-warning" />
          <StatTile label="Reports" value={stats.reports} tone="text-success" />
        </section>

        {assessments.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              No approved penetration-testing cycles are assigned to this partner yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
            <Card className="h-fit">
              <CardHeader>
                <CardTitle className="text-base">Assigned clients</CardTitle>
                <CardDescription>
                  Visibility is limited to approved testing records only.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {assessments.map((assessment) => (
                  <button
                    key={assessment.id}
                    type="button"
                    onClick={() => setSelectedId(assessment.id)}
                    className={`w-full rounded-md border p-3 text-left transition-colors ${
                      selected?.id === assessment.id
                        ? "border-primary bg-primary/5"
                        : "border-border bg-surface hover:border-primary/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {assessment.clones?.name ?? assessment.title}
                      </span>
                      <Badge variant="outline" className={statusTone(assessment.status)}>
                        {assessment.status.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {assessment.cycle.replace("_", "-")} · due {formatDate(assessment.due_at)}
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {selected && (
              <div className="space-y-4">
                <AssessmentOverview assessment={selected} />

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <CheckCircle2 className="h-4 w-4 text-primary" /> Scope, schedule and status
                    </CardTitle>
                    <CardDescription>
                      Confirm rules of engagement before testing; status changes are logged.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 lg:grid-cols-2">
                    <Field label="Status">
                      <Select value={status} onValueChange={setStatus}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PARTNER_STATUS_OPTIONS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option.replaceAll("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Emergency stop point">
                      <Input
                        value={emergencyStop}
                        onChange={(event) => setEmergencyStop(event.target.value)}
                      />
                    </Field>
                    <Field label="Testing window start">
                      <Input
                        type="datetime-local"
                        value={windowStart}
                        onChange={(event) => setWindowStart(event.target.value)}
                      />
                    </Field>
                    <Field label="Testing window end">
                      <Input
                        type="datetime-local"
                        value={windowEnd}
                        onChange={(event) => setWindowEnd(event.target.value)}
                      />
                    </Field>
                    <div className="lg:col-span-2">
                      <Field label="Target URLs">
                        <Textarea
                          value={targetUrls}
                          onChange={(event) => setTargetUrls(event.target.value)}
                          rows={2}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-2">
                      <Field label="Scope summary">
                        <Textarea
                          value={scopeSummary}
                          onChange={(event) => setScopeSummary(event.target.value)}
                          rows={3}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-2">
                      <Field label="Rules of engagement">
                        <Textarea
                          value={rulesOfEngagement}
                          onChange={(event) => setRulesOfEngagement(event.target.value)}
                          rows={4}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-2">
                      <Field label="Exclusions">
                        <Textarea
                          value={exclusions}
                          onChange={(event) => setExclusions(event.target.value)}
                          rows={3}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-2">
                      <Field label="Escalation contacts">
                        <Textarea
                          value={escalationContacts}
                          onChange={(event) => setEscalationContacts(event.target.value)}
                          rows={2}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-2">
                      <Field label="Status note to Aurixa">
                        <Input
                          value={statusNote}
                          onChange={(event) => setStatusNote(event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="lg:col-span-2">
                      <Button onClick={updateAssessment} disabled={busy === "assessment"}>
                        Save scope / status update
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <AlertTriangle className="h-4 w-4 text-primary" /> Findings
                    </CardTitle>
                    <CardDescription>
                      Upload severity classifications, evidence and recommendations.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 lg:grid-cols-3">
                      <Field label="Title">
                        <Input
                          value={findingTitle}
                          onChange={(event) => setFindingTitle(event.target.value)}
                        />
                      </Field>
                      <Field label="Severity">
                        <Select value={findingSeverity} onValueChange={setFindingSeverity}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["critical", "high", "medium", "low", "info"].map((severity) => (
                              <SelectItem key={severity} value={severity}>
                                {severity}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Affected asset">
                        <Input
                          value={findingAsset}
                          onChange={(event) => setFindingAsset(event.target.value)}
                        />
                      </Field>
                      <div className="lg:col-span-3">
                        <Field label="Description">
                          <Textarea
                            value={findingDescription}
                            onChange={(event) => setFindingDescription(event.target.value)}
                            rows={3}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-3">
                        <Field label="Evidence">
                          <Textarea
                            value={findingEvidence}
                            onChange={(event) => setFindingEvidence(event.target.value)}
                            rows={3}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-3">
                        <Field label="Recommendation">
                          <Textarea
                            value={findingRecommendation}
                            onChange={(event) => setFindingRecommendation(event.target.value)}
                            rows={3}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-3">
                        <Button onClick={createFinding} disabled={busy === "finding"}>
                          Add finding
                        </Button>
                      </div>
                    </div>
                    <FindingsList
                      findings={selected.security_findings ?? []}
                      busy={busy}
                      updateFinding={updateFinding}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <UploadCloud className="h-4 w-4 text-primary" /> Reports
                    </CardTitle>
                    <CardDescription>
                      Upload reports directly or provide an approved secure link. Aurixa reviews
                      before client release.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 lg:grid-cols-3">
                      <Field label="Report label">
                        <Input
                          value={reportLabel}
                          onChange={(event) => setReportLabel(event.target.value)}
                        />
                      </Field>
                      <Field label="Type">
                        <Select value={reportType} onValueChange={setReportType}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["draft", "final", "retest", "evidence"].map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Secure file URL (optional)">
                        <Input
                          value={reportUrl}
                          onChange={(event) => setReportUrl(event.target.value)}
                          placeholder="https://…"
                        />
                      </Field>
                      <div className="lg:col-span-3">
                        <Field label="Upload report file">
                          <Input
                            type="file"
                            onChange={(event) => setReportFile(event.target.files?.[0] ?? null)}
                          />
                          {reportFile && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              Selected: {reportFile.name}
                            </div>
                          )}
                        </Field>
                      </div>
                      <div className="lg:col-span-3">
                        <Field label="Notes">
                          <Textarea
                            value={reportNotes}
                            onChange={(event) => setReportNotes(event.target.value)}
                            rows={2}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-3">
                        <Button onClick={createReport} disabled={busy === "report"}>
                          Submit report to Aurixa review
                        </Button>
                      </div>
                    </div>
                    <ReportsList
                      reports={selected.security_reports ?? []}
                      busy={busy}
                      openReport={openReport}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <MessageSquare className="h-4 w-4 text-primary" /> Partner thread and audit
                      trail
                    </CardTitle>
                    <CardDescription>
                      Aurixa manages client-facing communication; this thread is for partner
                      coordination.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                      <Input
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        placeholder="Message Aurixa…"
                      />
                      <Button onClick={addComment} disabled={busy === "comment"}>
                        Send message
                      </Button>
                    </div>
                    <Activity
                      comments={selected.security_assessment_comments ?? []}
                      events={selected.security_assessment_events ?? []}
                    />
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>
    </PortalFrame>
  );
}

function PortalFrame({
  children,
  userEmail,
  onSignOut,
}: {
  children: ReactNode;
  userEmail?: string | null;
  onSignOut: () => Promise<void>;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Aurixa Systems
              </div>
              <div className="font-mono text-sm font-semibold">Security Partner Portal</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-xs text-muted-foreground md:inline">
              {userEmail}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void onSignOut()}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 md:px-8">{children}</main>
    </div>
  );
}

function AssessmentOverview({ assessment }: { assessment: Assessment }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-xl">{assessment.title}</CardTitle>
            <CardDescription>
              {assessment.clones?.name ?? "Client"} · {assessment.cycle.replace("_", "-")} cycle
            </CardDescription>
          </div>
          <Badge variant="outline" className={statusTone(assessment.status)}>
            {assessment.status.replaceAll("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <Info
          label="Command Centre target"
          value={assessment.clones?.deploy_url ?? "Not provided"}
        />
        <Info
          label="Testing window"
          value={`${formatDate(assessment.testing_window_start)} → ${formatDate(assessment.testing_window_end)}`}
        />
        <Info label="Aurixa review" value={assessment.aurixa_review_status.replaceAll("_", " ")} />
        <div className="md:col-span-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Target URLs
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(assessment.target_urls ?? []).length === 0 ? (
              <span className="text-sm text-muted-foreground">No URLs recorded yet.</span>
            ) : (
              (assessment.target_urls ?? []).map((url) => (
                <Badge key={url} variant="outline" className="font-mono">
                  {url}
                </Badge>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FindingsList({
  findings,
  busy,
  updateFinding,
}: {
  findings: Finding[];
  busy: string | null;
  updateFinding: (findingId: string, patch: { status?: string; retestStatus?: string }) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-2">
      {findings.map((finding) => (
        <div key={finding.id} className="border border-border bg-surface p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={finding.severity === "critical" ? "text-destructive" : ""}
                >
                  {finding.severity}
                </Badge>
                <span className="font-medium">{finding.title}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{finding.affected_asset}</p>
              {finding.description && <p className="mt-2 text-sm">{finding.description}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                value={finding.status}
                onValueChange={(value) => updateFinding(finding.id, { status: value })}
                disabled={busy === `finding:${finding.id}`}
              >
                <SelectTrigger className="h-8 w-[150px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "open",
                    "remediation_review",
                    "resolved",
                    "accepted_risk",
                    "false_positive",
                  ].map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={finding.retest_status}
                onValueChange={(value) => updateFinding(finding.id, { retestStatus: value })}
                disabled={busy === `finding:${finding.id}`}
              >
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["not_requested", "pending", "validated", "failed"].map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReportsList({
  reports,
  busy,
  openReport,
}: {
  reports: ReportRecord[];
  busy: string | null;
  openReport: (report: ReportRecord) => void;
}) {
  if (reports.length === 0) return null;
  return (
    <div className="space-y-2">
      {reports.map((report) => (
        <div
          key={report.id}
          className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface p-3"
        >
          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{report.label}</span>
              <Badge variant="outline">{report.report_type}</Badge>
              <Badge variant="outline">{report.status}</Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              submitted {formatDate(report.submitted_at)}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openReport(report)}
            disabled={busy === `report:${report.id}`}
          >
            <Download className="mr-2 h-3.5 w-3.5" /> Open file
          </Button>
        </div>
      ))}
    </div>
  );
}

function Activity({ comments, events }: { comments: CommentRecord[]; events: EventRecord[] }) {
  return (
    <div className="space-y-2">
      {comments.map((item) => (
        <div key={item.id} className="border border-border bg-surface p-3">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {item.author_kind} · {formatDate(item.created_at)}
          </div>
          <div className="text-sm">{item.body}</div>
        </div>
      ))}
      {events
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 8)
        .map((event) => (
          <div
            key={event.id}
            className="border border-border/70 px-3 py-2 text-xs text-muted-foreground"
          >
            <span className="font-mono uppercase">{event.event_type}</span> · {event.actor_kind} ·{" "}
            {formatDate(event.created_at)}
            {event.body ? <div className="mt-1 text-foreground">{event.body}</div> : null}
          </div>
        ))}
    </div>
  );
}

const TONE_CLASS_TO_TONE = {
  "text-success": "success",
  "text-destructive": "destructive",
  "text-warning": "warning",
  "text-info": "primary",
} as const;

function StatTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const mapped = tone ? TONE_CLASS_TO_TONE[tone as keyof typeof TONE_CLASS_TO_TONE] : undefined;
  return <MetricCell label={label} value={value} tone={mapped} alarm={Boolean(mapped)} />;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 break-words text-sm">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
