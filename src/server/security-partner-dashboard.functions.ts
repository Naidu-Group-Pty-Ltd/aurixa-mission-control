// @ts-nocheck — 1 unresolved type error (argument types ×1).
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
import { createServerFn } from "@tanstack/react-start";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const admin = supabaseAdmin as any;

const Cycle = z.enum(["quarterly", "bi_annual", "annual", "one_off"]);
const REPORT_BUCKET = "security-reports";

type SecurityAssessmentRow = {
  id: string;
  clone_id: string;
  partner_id: string;
  title: string;
  cycle: string;
  status: string;
  aurixa_review_status: string;
  due_at: string | null;
  retest_required: boolean;
  client_release_approved: boolean;
  security_partners?: { id: string; name: string; slug: string } | null;
  security_findings?: Array<{
    id: string;
    severity: string;
    status: string;
    retest_status: string;
  }>;
  security_reports?: Array<{
    id: string;
    label?: string;
    report_type: string;
    status: string;
    submitted_at: string;
    file_path?: string | null;
    file_url?: string | null;
  }>;
};

async function isInternalUser(supabase: any, userId: string) {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data as Array<{ role: string }> | null) ?? []).map((r) => r.role);
  return roles.some((r) => r === "super_admin" || r === "admin" || r === "operator");
}

async function writeSecurityEvent(input: {
  assessmentId?: string | null;
  partnerId?: string | null;
  cloneId?: string | null;
  actorUserId?: string | null;
  actorKind: "aurixa" | "partner" | "system";
  eventType: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await admin.from("security_assessment_events").insert({
    assessment_id: input.assessmentId ?? null,
    partner_id: input.partnerId ?? null,
    clone_id: input.cloneId ?? null,
    actor_user_id: input.actorUserId ?? null,
    actor_kind: input.actorKind,
    event_type: input.eventType,
    body: input.body ?? null,
    metadata: input.metadata ?? {},
  });
}

function summarise(row: SecurityAssessmentRow) {
  const findings = row.security_findings ?? [];
  const reports = row.security_reports ?? [];
  return {
    id: row.id,
    clone_id: row.clone_id,
    title: row.title,
    cycle: row.cycle,
    status: row.status,
    aurixa_review_status: row.aurixa_review_status,
    due_at: row.due_at,
    retest_required: row.retest_required,
    client_release_approved: row.client_release_approved,
    partner: row.security_partners ?? null,
    open_findings: findings.filter((f) => f.status === "open" || f.status === "remediation_review")
      .length,
    critical_findings: findings.filter((f) => f.severity === "critical").length,
    high_findings: findings.filter((f) => f.severity === "high").length,
    pending_retests: findings.filter(
      (f) => f.retest_status === "pending" || f.retest_status === "failed",
    ).length,
    report_count: reports.length,
    latest_report_at:
      reports
        .map((r) => r.submitted_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
  };
}

export const listSecurityDashboardSummaries = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ cloneIds: z.array(z.string().uuid()).default([]) }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let query = admin
      .from("security_assessments")
      .select(
        "id, clone_id, partner_id, title, cycle, status, aurixa_review_status, due_at, retest_required, client_release_approved, security_partners(id, name, slug), security_findings(id, severity, status, retest_status), security_reports(id, label, report_type, status, submitted_at, file_path, file_url)",
      )
      .order("created_at", { ascending: false });

    if (data.cloneIds.length > 0) query = query.in("clone_id", data.cloneIds);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return { summaries: ((rows ?? []) as SecurityAssessmentRow[]).map(summarise) };
  });

export const getCloneSecurityAssessments = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .inputValidator((input: { cloneId: string }) =>
    z.object({ cloneId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await admin
      .from("security_assessments")
      .select(
        "*, security_partners(id, name, slug), security_findings(*), security_reports(*), security_assessment_comments(id, author_kind, visibility, body, created_at), security_assessment_events(id, actor_kind, event_type, body, created_at)",
      )
      .eq("clone_id", data.cloneId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return {
      assessments: rows ?? [],
      summaries: ((rows ?? []) as SecurityAssessmentRow[]).map(summarise),
    };
  });

export const listSecurityPartnersForAssignment = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { data, error } = await admin
      .from("security_partners")
      .select("id, name, slug, status")
      .eq("status", "active")
      .order("name");
    if (error) throw new Error(error.message);
    return { partners: data ?? [] };
  });

export const createBulkSecurityAssessments = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        partnerId: z.string().uuid(),
        cloneIds: z.array(z.string().uuid()).min(1),
        cycle: Cycle.default("quarterly"),
        dueAt: z.string().nullable().optional(),
        scopeSummary: z.string().optional(),
        rulesOfEngagement: z.string().optional(),
        retestRequired: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const { data: partner, error: partnerError } = await admin
      .from("security_partners")
      .select("id, name, slug")
      .eq("id", data.partnerId)
      .maybeSingle();
    if (partnerError) throw new Error(partnerError.message);
    if (!partner) throw new Error("security_partner_not_found");

    const { data: clones, error: clonesError } = await admin
      .from("clones")
      .select("id, name, deploy_url")
      .in("id", data.cloneIds);
    if (clonesError) throw new Error(clonesError.message);

    const created: unknown[] = [];
    const skipped: Array<{ cloneId: string; reason: string }> = [];

    for (const clone of clones ?? []) {
      const active = await admin
        .from("security_assessments")
        .select("id")
        .eq("clone_id", clone.id)
        .eq("partner_id", data.partnerId)
        .in("status", [
          "pending",
          "scheduled",
          "in_progress",
          "reporting",
          "remediation_review",
          "retesting",
          "blocked",
        ])
        .maybeSingle();

      if (active.data?.id) {
        skipped.push({ cloneId: clone.id, reason: "active_cycle_exists" });
        continue;
      }

      const existingAssignment = await admin
        .from("security_partner_assignments")
        .select("id")
        .eq("partner_id", data.partnerId)
        .eq("clone_id", clone.id)
        .is("revoked_at", null)
        .maybeSingle();

      let assignmentId = existingAssignment.data?.id as string | undefined;
      if (!assignmentId) {
        const assignmentRes = await admin
          .from("security_partner_assignments")
          .insert({
            partner_id: data.partnerId,
            clone_id: clone.id,
            status: "active",
            assigned_by: context.userId,
            assigned_at: now,
            metadata: { created_from: "dashboard_bulk_activation" },
          })
          .select("id")
          .single();
        if (assignmentRes.error) throw new Error(assignmentRes.error.message);
        assignmentId = assignmentRes.data.id;
      }

      const assessmentRes = await admin
        .from("security_assessments")
        .insert({
          partner_id: data.partnerId,
          clone_id: clone.id,
          assignment_id: assignmentId,
          title: `${clone.name} ${data.cycle.replace("_", "-")} penetration test`,
          cycle: data.cycle,
          status: "pending",
          scope_summary: data.scopeSummary?.trim() || null,
          rules_of_engagement: data.rulesOfEngagement?.trim() || null,
          target_urls: clone.deploy_url ? [clone.deploy_url] : [],
          due_at: data.dueAt || null,
          retest_required: data.retestRequired,
          created_by: context.userId,
        })
        .select("*")
        .single();
      if (assessmentRes.error) throw new Error(assessmentRes.error.message);

      created.push(assessmentRes.data);
      await writeSecurityEvent({
        assessmentId: assessmentRes.data.id,
        partnerId: data.partnerId,
        cloneId: clone.id,
        actorUserId: context.userId,
        actorKind: "aurixa",
        eventType: "assessment.bulk_created",
        body: `Aurixa activated ${partner.name} partner testing access for this client cycle.`,
        metadata: { source: "dashboard_bulk_activation", cycle: data.cycle },
      });
      await writeAuditLog({
        actorUserId: context.userId,
        action: "security.assessment.bulk_created",
        entityType: "security_assessment",
        entityId: assessmentRes.data.id,
        metadata: { partner_id: data.partnerId, clone_id: clone.id, cycle: data.cycle },
      });
      await notifyOperators({
        kind: "security_assessment_created",
        severity: "info",
        title: `Security testing activated: ${clone.name}`,
        body: `${partner.name} was assigned to a ${data.cycle.replace("_", "-")} penetration-testing cycle.`,
        cloneId: clone.id,
        url: `/clones/${clone.id}`,
        metadata: { assessment_id: assessmentRes.data.id, partner_id: data.partnerId },
      });
    }

    return { ok: true, created, skipped };
  });

export const getSecurityReportDownloadUrl = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reportId: string; expiresIn?: number }) =>
    z
      .object({
        reportId: z.string().uuid(),
        expiresIn: z.number().int().min(60).max(3600).default(600),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: report, error } = await admin
      .from("security_reports")
      .select("id, assessment_id, partner_id, clone_id, file_path, file_url, label")
      .eq("id", data.reportId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!report) throw new Error("security_report_not_found");

    const internal = await isInternalUser(context.supabase, context.userId);
    if (!internal) {
      const { data: membership } = await admin
        .from("security_partner_memberships")
        .select("id")
        .eq("partner_id", report.partner_id)
        .eq("user_id", context.userId)
        .eq("status", "active")
        .maybeSingle();
      if (!membership) throw new Error("forbidden_report");
    }

    if (report.file_url) return { url: report.file_url, label: report.label, external: true };
    if (!report.file_path) throw new Error("report_has_no_file");

    const signed = await admin.storage
      .from(REPORT_BUCKET)
      .createSignedUrl(report.file_path, data.expiresIn);
    if (signed.error) throw new Error(signed.error.message);
    return {
      url: signed.data.signedUrl,
      label: report.label,
      external: false,
      expiresIn: data.expiresIn,
    };
  });
