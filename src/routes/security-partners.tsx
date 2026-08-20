import { createFileRoute } from "@tanstack/react-router";
import type { Tables } from "@/integrations/supabase/types";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ClipboardCheck,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  createSecurityAssessment,
  createSecurityPartner,
  inviteSecurityPartnerMember,
  listSecurityPartnerAdminData,
  updateSecurityAssessmentAdmin,
  addSecurityAssessmentComment,
  SECURITY_ASSESSMENT_STATUSES,
  SECURITY_REVIEW_STATUSES,
} from "@/server/security-partner-portal.functions";
import {
  bridgeCodexFindingsToAssessment,
  exportPartnerSignoffBundle,
} from "@/server/security-partner-codex.functions";

export const Route = createFileRoute("/security-partners")({
  component: () => (
    <ProtectedRoute>
      <SecurityPartnersPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Security Partners — Aurixa Mission Control" }] }),
});

type Partner = {
  id: string;
  name: string;
  slug: string;
  status: string;
  primary_contact_email?: string | null;
  primary_contact_name?: string | null;
};

type CloneRow = {
  id: string;
  name: string;
  deploy_url?: string | null;
  github_owner?: string | null;
  github_repo?: string | null;
  sync_status?: string | null;
};

type Assessment = Tables<"security_assessments"> & {
  clones: Pick<
    Tables<"clones">,
    "id" | "name" | "deploy_url" | "github_owner" | "github_repo" | "github_url"
  > | null;
  security_partners: Pick<Tables<"security_partners">, "id" | "name" | "slug"> | null;
  security_findings: Array<
    Pick<Tables<"security_findings">, "id" | "title" | "severity" | "status" | "retest_status">
  >;
  security_reports: Array<
    Pick<Tables<"security_reports">, "id" | "label" | "report_type" | "status" | "submitted_at">
  >;
  security_assessment_comments: Array<
    Pick<Tables<"security_assessment_comments">, "id" | "visibility" | "created_at">
  >;
};

const CYCLES = [
  { value: "quarterly", label: "Quarterly" },
  { value: "bi_annual", label: "Bi-annual" },
  { value: "annual", label: "Annual" },
  { value: "one_off", label: "One-off" },
] as const;

function splitList(input: string) {
  return input
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function isoOrNull(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function shortDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function statusTone(status: string) {
  if (status === "closed") return "border-success/40 text-success";
  if (status === "blocked" || status === "canceled")
    return "border-destructive/40 text-destructive";
  if (status === "in_progress" || status === "reporting" || status === "retesting") {
    return "border-info/40 text-info";
  }
  return "border-warning/40 text-warning";
}

function SecurityPartnersPage() {
  const listData = useServerFn(listSecurityPartnerAdminData);
  const createPartnerFn = useServerFn(createSecurityPartner);
  const inviteMemberFn = useServerFn(inviteSecurityPartnerMember);
  const createAssessmentFn = useServerFn(createSecurityAssessment);
  const updateAssessmentFn = useServerFn(updateSecurityAssessmentAdmin);
  const commentFn = useServerFn(addSecurityAssessmentComment);

  const [loading, setLoading] = useState(true);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [clones, setClones] = useState<CloneRow[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const [partnerName, setPartnerName] = useState("EC-Council");
  const [partnerEmail, setPartnerEmail] = useState("");
  const [partnerContact, setPartnerContact] = useState("");
  const [partnerNotes, setPartnerNotes] = useState("");

  const [memberPartnerId, setMemberPartnerId] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState<"partner_admin" | "tester" | "viewer">("tester");

  const [assessmentPartnerId, setAssessmentPartnerId] = useState("");
  const [assessmentCloneId, setAssessmentCloneId] = useState("");
  const [assessmentCycle, setAssessmentCycle] = useState<
    "quarterly" | "bi_annual" | "annual" | "one_off"
  >("quarterly");
  const [assessmentTitle, setAssessmentTitle] = useState("");
  const [scopeSummary, setScopeSummary] = useState("");
  const [rulesOfEngagement, setRulesOfEngagement] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [targetUrls, setTargetUrls] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [emergencyStop, setEmergencyStop] = useState("");
  const [escalationContacts, setEscalationContacts] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [retestRequired, setRetestRequired] = useState("false");
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    try {
      const data = await listData();
      setPartners((data.partners ?? []) as Partner[]);
      setMembers(data.members ?? []);
      setClones((data.clones ?? []) as CloneRow[]);
      setAssessments(data.assessments ?? []);
      const firstPartner = (data.partners ?? [])[0]?.id;
      if (firstPartner) {
        setMemberPartnerId((current) => current || firstPartner);
        setAssessmentPartnerId((current) => current || firstPartner);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load security partner data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const open = assessments.filter((a) =>
      [
        "pending",
        "scheduled",
        "in_progress",
        "reporting",
        "remediation_review",
        "retesting",
      ].includes(a.status),
    ).length;
    const reporting = assessments.filter((a) => a.status === "reporting").length;
    const closed = assessments.filter((a) => a.status === "closed").length;
    const critical = assessments.reduce(
      (sum, a) => sum + (a.security_findings ?? []).filter((f) => f.severity === "critical").length,
      0,
    );
    return { open, reporting, closed, critical };
  }, [assessments]);

  const createPartner = async () => {
    if (!partnerName.trim()) return toast.error("Partner name is required");
    setBusy("partner");
    try {
      await createPartnerFn({
        data: {
          name: partnerName,
          primaryContactName: partnerContact,
          primaryContactEmail: partnerEmail,
          notes: partnerNotes,
        },
      });
      toast.success("Security partner created");
      setPartnerEmail("");
      setPartnerContact("");
      setPartnerNotes("");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create partner");
    } finally {
      setBusy(null);
    }
  };

  const inviteMember = async () => {
    if (!memberPartnerId) return toast.error("Select a partner first");
    if (!memberEmail.trim()) return toast.error("Member email is required");
    setBusy("member");
    try {
      await inviteMemberFn({
        data: {
          partnerId: memberPartnerId,
          email: memberEmail,
          displayName: memberName,
          role: memberRole,
        },
      });
      toast.success("Partner user approved/invited");
      setMemberEmail("");
      setMemberName("");
      setMemberRole("tester");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not invite member");
    } finally {
      setBusy(null);
    }
  };

  const createAssessment = async () => {
    if (!assessmentPartnerId || !assessmentCloneId) {
      toast.error("Select a partner and clone/client");
      return;
    }
    setBusy("assessment");
    try {
      await createAssessmentFn({
        data: {
          partnerId: assessmentPartnerId,
          cloneId: assessmentCloneId,
          cycle: assessmentCycle,
          title: assessmentTitle,
          scopeSummary,
          rulesOfEngagement,
          exclusions,
          targetUrls: splitList(targetUrls),
          testingWindowStart: isoOrNull(windowStart),
          testingWindowEnd: isoOrNull(windowEnd),
          emergencyStopContact: emergencyStop,
          escalationContacts: splitList(escalationContacts),
          dueAt: isoOrNull(dueAt),
          retestRequired: retestRequired === "true",
        },
      });
      toast.success("Cybersecurity Module activated for client cycle");
      setAssessmentCloneId("");
      setAssessmentTitle("");
      setScopeSummary("");
      setRulesOfEngagement("");
      setExclusions("");
      setTargetUrls("");
      setWindowStart("");
      setWindowEnd("");
      setEmergencyStop("");
      setEscalationContacts("");
      setDueAt("");
      setRetestRequired("false");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create assessment");
    } finally {
      setBusy(null);
    }
  };

  const updateAssessment = async (
    assessmentId: string,
    patch: {
      status?: (typeof SECURITY_ASSESSMENT_STATUSES)[number];
      aurixaReviewStatus?: (typeof SECURITY_REVIEW_STATUSES)[number];
      clientReleaseApproved?: boolean;
      retestRequired?: boolean;
      note?: string;
    },
  ) => {
    setBusy(`assessment:${assessmentId}`);
    try {
      await updateAssessmentFn({ data: { assessmentId, ...patch } });
      toast.success("Assessment updated");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const addComment = async (assessmentId: string) => {
    const body = commentDrafts[assessmentId]?.trim();
    if (!body) return;
    setBusy(`comment:${assessmentId}`);
    try {
      await commentFn({ data: { assessmentId, body, visibility: "partner_thread" } });
      toast.success("Comment posted to partner thread");
      setCommentDrafts((prev) => ({ ...prev, [assessmentId]: "" }));
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Comment failed");
    } finally {
      setBusy(null);
    }
  };

  const bridgeFn = useServerFn(bridgeCodexFindingsToAssessment);
  const exportFn = useServerFn(exportPartnerSignoffBundle);

  const syncCodex = async (assessmentId: string) => {
    setBusy(`codex:${assessmentId}`);
    try {
      const res = await bridgeFn({ data: { assessmentId } });
      toast.success(
        `Codex sync: ${res.created} new, ${res.updated} updated (of ${res.considered} open Codex findings).`,
      );
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Codex sync failed");
    } finally {
      setBusy(null);
    }
  };

  const exportBundle = async (assessmentId: string) => {
    setBusy(`bundle:${assessmentId}`);
    try {
      const res = await exportFn({ data: { assessmentId } });
      toast.success(
        `Sign-off bundle uploaded (${res.totals.findings} findings, ${res.totals.codex_mirrored} from Codex).`,
      );
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bundle export failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-mono">mission control · restricted partner governance</p>
          <h1 className="mt-1 flex items-center gap-2 font-display text-[2.125rem] leading-[1.05]">
            <ShieldCheck className="h-7 w-7 text-primary" />
            Security Partner Portal
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Assign approved clones to cybersecurity partners, track penetration-testing cycles,
            review reports/findings, and keep Aurixa in control of client communication and closure.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      <section className="glass grid overflow-hidden md:grid-cols-4">
        <StatTile label="Active cycles" value={stats.open} />
        <StatTile label="Reporting" value={stats.reporting} tone="text-info" />
        <StatTile label="Critical findings" value={stats.critical} tone="text-destructive" />
        <StatTile label="Closed" value={stats.closed} tone="text-success" />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" /> Partner company
            </CardTitle>
            <CardDescription>
              Create delivery partners. EC-Council is seeded by the migration.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Partner name">
              <Input value={partnerName} onChange={(e) => setPartnerName(e.target.value)} />
            </Field>
            <Field label="Primary contact name">
              <Input value={partnerContact} onChange={(e) => setPartnerContact(e.target.value)} />
            </Field>
            <Field label="Primary contact email">
              <Input
                type="email"
                value={partnerEmail}
                onChange={(e) => setPartnerEmail(e.target.value)}
              />
            </Field>
            <Field label="Notes">
              <Textarea
                value={partnerNotes}
                onChange={(e) => setPartnerNotes(e.target.value)}
                rows={3}
              />
            </Field>
            <Button onClick={createPartner} disabled={busy === "partner"}>
              Create partner
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-4 w-4 text-primary" /> Partner user approval
            </CardTitle>
            <CardDescription>
              Every partner user is individually approved before portal access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Partner">
              <Select value={memberPartnerId} onValueChange={setMemberPartnerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select partner" />
                </SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Name">
              <Input value={memberName} onChange={(e) => setMemberName(e.target.value)} />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={memberEmail}
                onChange={(e) => setMemberEmail(e.target.value)}
              />
            </Field>
            <Field label="Role">
              <Select
                value={memberRole}
                onValueChange={(v) => setMemberRole(v as typeof memberRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="partner_admin">Partner admin</SelectItem>
                  <SelectItem value="tester">Tester</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button onClick={inviteMember} disabled={busy === "member"}>
              Approve / invite user
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approved partners</CardTitle>
            <CardDescription>{partners.length} partner organization(s)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {partners.map((partner) => (
              <div key={partner.id} className="border border-border bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-sm font-semibold">{partner.name}</div>
                  <Badge variant="outline">{partner.status}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {partner.primary_contact_name || "No named contact"}
                  {partner.primary_contact_email ? ` · ${partner.primary_contact_email}` : ""}
                </div>
              </div>
            ))}
            {members.length > 0 && (
              <div className="pt-2">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  approved users
                </div>
                <div className="max-h-40 space-y-1 overflow-auto">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between border px-2 py-1 text-xs"
                    >
                      <span>{m.display_name || m.email}</span>
                      <span className="font-mono text-muted-foreground">
                        {m.role} · {m.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4 text-primary" /> Activate client penetration-testing
            cycle
          </CardTitle>
          <CardDescription>
            This creates the client-specific testing record, assignment boundary, rules of
            engagement, partner access workflow, report lane, and audit trail.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-3">
          <Field label="Partner">
            <Select value={assessmentPartnerId} onValueChange={setAssessmentPartnerId}>
              <SelectTrigger>
                <SelectValue placeholder="Select partner" />
              </SelectTrigger>
              <SelectContent>
                {partners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Clone / client">
            <Select value={assessmentCloneId} onValueChange={setAssessmentCloneId}>
              <SelectTrigger>
                <SelectValue placeholder="Select clone" />
              </SelectTrigger>
              <SelectContent>
                {clones.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Testing cycle">
            <Select
              value={assessmentCycle}
              onValueChange={(v) => setAssessmentCycle(v as typeof assessmentCycle)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CYCLES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Title">
            <Input value={assessmentTitle} onChange={(e) => setAssessmentTitle(e.target.value)} />
          </Field>
          <Field label="Test window start">
            <Input
              type="datetime-local"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
            />
          </Field>
          <Field label="Test window end">
            <Input
              type="datetime-local"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
            />
          </Field>
          <Field label="Due date">
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <Field label="Retesting required?">
            <Select value={retestRequired} onValueChange={setRetestRequired}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="false">No / not yet</SelectItem>
                <SelectItem value="true">Yes</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Emergency stop contact">
            <Input value={emergencyStop} onChange={(e) => setEmergencyStop(e.target.value)} />
          </Field>
          <div className="lg:col-span-3">
            <Field label="Target URLs (comma or newline separated)">
              <Textarea
                value={targetUrls}
                onChange={(e) => setTargetUrls(e.target.value)}
                rows={2}
              />
            </Field>
          </div>
          <div className="lg:col-span-3">
            <Field label="Scope summary">
              <Textarea
                value={scopeSummary}
                onChange={(e) => setScopeSummary(e.target.value)}
                rows={3}
              />
            </Field>
          </div>
          <div className="lg:col-span-3">
            <Field label="Rules of engagement">
              <Textarea
                value={rulesOfEngagement}
                onChange={(e) => setRulesOfEngagement(e.target.value)}
                rows={3}
              />
            </Field>
          </div>
          <div className="lg:col-span-3">
            <Field label="Exclusions and out-of-scope areas">
              <Textarea
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
                rows={3}
              />
            </Field>
          </div>
          <div className="lg:col-span-3">
            <Field label="Escalation contacts (comma or newline separated)">
              <Textarea
                value={escalationContacts}
                onChange={(e) => setEscalationContacts(e.target.value)}
                rows={2}
              />
            </Field>
          </div>
          <div className="lg:col-span-3">
            <Button onClick={createAssessment} disabled={busy === "assessment"}>
              Activate Cybersecurity Module for selected client
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assessment governance queue</CardTitle>
          <CardDescription>
            Aurixa remains the client communication gateway. Partner updates stay restricted to
            assigned cycles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : assessments.length === 0 ? (
            <div className="border border-dashed p-8 text-center text-sm text-muted-foreground">
              No cybersecurity assessments have been activated yet.
            </div>
          ) : (
            <div className="space-y-3">
              {assessments.map((assessment) => (
                <div key={assessment.id} className="border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{assessment.title}</h3>
                        <Badge variant="outline" className={statusTone(assessment.status)}>
                          {assessment.status.replaceAll("_", " ")}
                        </Badge>
                        <Badge variant="outline">{assessment.cycle.replace("_", "-")}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {assessment.clones?.name ?? "Unknown clone"} ·{" "}
                        {assessment.security_partners?.name ?? "Unknown partner"}
                        {assessment.clones?.deploy_url && (
                          <a
                            href={assessment.clones.deploy_url}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 inline-flex items-center gap-1 text-primary"
                          >
                            target <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>due {shortDate(assessment.due_at)}</span>
                        <span>
                          window {shortDate(assessment.testing_window_start)} →{" "}
                          {shortDate(assessment.testing_window_end)}
                        </span>
                        <span>{assessment.security_findings?.length ?? 0} findings</span>
                        <span>{assessment.security_reports?.length ?? 0} reports</span>
                        <span>{assessment.security_assessment_comments?.length ?? 0} comments</span>
                      </div>
                    </div>
                    <div className="grid min-w-[320px] gap-2 sm:grid-cols-2">
                      <Select
                        value={assessment.status}
                        onValueChange={(status) =>
                          updateAssessment(assessment.id, {
                            status: status as (typeof SECURITY_ASSESSMENT_STATUSES)[number],
                          })
                        }
                        disabled={busy === `assessment:${assessment.id}`}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SECURITY_ASSESSMENT_STATUSES.map((status) => (
                            <SelectItem key={status} value={status}>
                              {status.replaceAll("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={assessment.aurixa_review_status}
                        onValueChange={(review) =>
                          updateAssessment(assessment.id, {
                            aurixaReviewStatus: review as (typeof SECURITY_REVIEW_STATUSES)[number],
                            clientReleaseApproved:
                              review === "released_to_client" ? true : undefined,
                          })
                        }
                        disabled={busy === `assessment:${assessment.id}`}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SECURITY_REVIEW_STATUSES.map((status) => (
                            <SelectItem key={status} value={status}>
                              {status.replaceAll("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
                    <Input
                      placeholder="Send a note to the partner thread…"
                      value={commentDrafts[assessment.id] ?? ""}
                      onChange={(e) =>
                        setCommentDrafts((prev) => ({ ...prev, [assessment.id]: e.target.value }))
                      }
                    />
                    <Button
                      variant="outline"
                      onClick={() => addComment(assessment.id)}
                      disabled={busy === `comment:${assessment.id}`}
                    >
                      Send note
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncCodex(assessment.id)}
                      disabled={busy === `codex:${assessment.id}`}
                    >
                      {busy === `codex:${assessment.id}`
                        ? "Syncing Codex…"
                        : "Mirror Codex findings"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => exportBundle(assessment.id)}
                      disabled={busy === `bundle:${assessment.id}`}
                    >
                      {busy === `bundle:${assessment.id}` ? "Exporting…" : "Export sign-off bundle"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
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
