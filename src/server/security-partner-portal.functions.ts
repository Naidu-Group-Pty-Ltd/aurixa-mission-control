import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const admin = supabaseAdmin as any;

export const SECURITY_ASSESSMENT_STATUSES = [
  "pending",
  "scheduled",
  "in_progress",
  "reporting",
  "remediation_review",
  "retesting",
  "closed",
  "blocked",
  "canceled",
] as const;

export const SECURITY_REVIEW_STATUSES = [
  "not_submitted",
  "submitted",
  "in_review",
  "changes_requested",
  "approved",
  "released_to_client",
] as const;

const AssessmentStatus = z.enum(SECURITY_ASSESSMENT_STATUSES);
const ReviewStatus = z.enum(SECURITY_REVIEW_STATUSES);
const Cycle = z.enum(["quarterly", "bi_annual", "annual", "one_off"]);
const MemberRole = z.enum(["partner_admin", "tester", "viewer"]);
const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
const FindingStatus = z.enum(["open", "remediation_review", "resolved", "accepted_risk", "false_positive"]);
const RetestStatus = z.enum(["not_requested", "pending", "validated", "failed"]);
const ReportType = z.enum(["draft", "final", "retest", "evidence"]);

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function cleanEmail(email: string) {
  return email.trim().toLowerCase();
}

function cleanTextList(values?: string[] | null) {
  return Array.from(new Set((values ?? []).map((v) => v.trim()).filter(Boolean)));
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

async function writeAudit(input: {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await admin.from("audit_log").insert({
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    actor_user_id: input.actorUserId ?? null,
    metadata: input.metadata ?? {},
  });
}

async function claimPartnerInvites(userId: string, email?: string | null) {
  if (!email) return;
  const normalized = cleanEmail(email);
  await admin
    .from("security_partner_memberships")
    .update({
      user_id: userId,
      status: "active",
      accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("email", normalized)
    .is("user_id", null)
    .in("status", ["invited", "active"]);
}

async function getActiveMemberships(userId: string, email?: string | null) {
  await claimPartnerInvites(userId, email);
  const { data, error } = await admin
    .from("security_partner_memberships")
    .select("id, partner_id, role, status, email, display_name, security_partners(id, name, slug, status, primary_contact_email, primary_contact_name)")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  await admin
    .from("security_partner_memberships")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("status", "active");
  return data ?? [];
}

async function userHasInternalRole(supabase: any, userId: string) {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data as Array<{ role: string }> | null) ?? []).map((r) => r.role);
  return roles.some((r) => r === "super_admin" || r === "admin" || r === "operator");
}

async function getAssessmentForPartnerAccess(assessmentId: string, userId: string, email?: string | null) {
  await claimPartnerInvites(userId, email);
  const { data: assessment, error } = await admin
    .from("security_assessments")
    .select("id, partner_id, clone_id, status, aurixa_review_status, retest_required, client_release_approved, started_at")
    .eq("id", assessmentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!assessment) throw new Error("assessment_not_found");

  const { data: membership } = await admin
    .from("security_partner_memberships")
    .select("id, role")
    .eq("partner_id", assessment.partner_id)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!membership) throw new Error("forbidden_partner_assessment");
  return { assessment, membership };
}

export const listSecurityPartnerAdminData = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const [partnersRes, membersRes, clonesRes, assessmentsRes] = await Promise.all([
      admin.from("security_partners").select("*").order("created_at", { ascending: false }),
      admin
        .from("security_partner_memberships")
        .select("*, security_partners(id, name, slug)")
        .order("created_at", { ascending: false }),
      admin
        .from("clones")
        .select("id, name, slug, deploy_url, github_owner, github_repo, github_url, tags, sync_status, created_at")
        .order("name", { ascending: true }),
      admin
        .from("security_assessments")
        .select("*, clones(id, name, deploy_url, github_owner, github_repo, github_url), security_partners(id, name, slug), security_findings(id, title, severity, status, retest_status), security_reports(id, label, report_type, status, submitted_at), security_assessment_comments(id, visibility, created_at)")
        .order("created_at", { ascending: false }),
    ]);

    for (const res of [partnersRes, membersRes, clonesRes, assessmentsRes]) {
      if (res.error) throw new Error(res.error.message);
    }

    return {
      partners: partnersRes.data ?? [],
      members: membersRes.data ?? [],
      clones: clonesRes.data ?? [],
      assessments: assessmentsRes.data ?? [],
    };
  });

export const createSecurityPartner = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().min(2),
        slug: z.string().optional(),
        primaryContactName: z.string().optional(),
        primaryContactEmail: z.string().email().optional().or(z.literal("")),
        notes: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const slug = slugify(data.slug || data.name);
    const { data: row, error } = await admin
      .from("security_partners")
      .insert({
        name: data.name.trim(),
        slug,
        primary_contact_name: data.primaryContactName?.trim() || null,
        primary_contact_email: data.primaryContactEmail ? cleanEmail(data.primaryContactEmail) : null,
        notes: data.notes?.trim() || null,
        created_by: context.userId,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeAudit({
      actorUserId: context.userId,
      action: "security.partner.created",
      entityType: "security_partner",
      entityId: row.id,
      metadata: { partner_id: row.id, slug: row.slug },
    });

    return { ok: true, partner: row };
  });

export const inviteSecurityPartnerMember = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        partnerId: z.string().uuid(),
        email: z.string().email(),
        displayName: z.string().optional(),
        role: MemberRole.default("tester"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const { data: row, error } = await admin
      .from("security_partner_memberships")
      .upsert(
        {
          partner_id: data.partnerId,
          email: cleanEmail(data.email),
          display_name: data.displayName?.trim() || null,
          role: data.role,
          status: "invited",
          approved_by: context.userId,
          approved_at: now,
          updated_at: now,
        },
        { onConflict: "partner_id,email" },
      )
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeAudit({
      actorUserId: context.userId,
      action: "security.partner_user.invited",
      entityType: "security_partner",
      entityId: data.partnerId,
      metadata: { member_id: row.id, email: row.email, role: row.role },
    });

    return { ok: true, member: row };
  });

export const createSecurityAssessment = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        partnerId: z.string().uuid(),
        cloneId: z.string().uuid(),
        cycle: Cycle.default("one_off"),
        title: z.string().optional(),
        scopeSummary: z.string().optional(),
        rulesOfEngagement: z.string().optional(),
        exclusions: z.string().optional(),
        targetUrls: z.array(z.string()).default([]),
        testingWindowStart: z.string().nullable().optional(),
        testingWindowEnd: z.string().nullable().optional(),
        emergencyStopContact: z.string().optional(),
        escalationContacts: z.array(z.string()).default([]),
        dueAt: z.string().nullable().optional(),
        retestRequired: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const { data: clone, error: cloneError } = await admin
      .from("clones")
      .select("id, name")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (cloneError) throw new Error(cloneError.message);
    if (!clone) throw new Error("clone_not_found");

    const existingAssignment = await admin
      .from("security_partner_assignments")
      .select("id")
      .eq("partner_id", data.partnerId)
      .eq("clone_id", data.cloneId)
      .is("revoked_at", null)
      .maybeSingle();

    let assignmentId = existingAssignment.data?.id as string | undefined;
    if (!assignmentId) {
      const { data: assignment, error: assignmentError } = await admin
        .from("security_partner_assignments")
        .insert({
          partner_id: data.partnerId,
          clone_id: data.cloneId,
          assigned_by: context.userId,
          assigned_at: now,
          metadata: { created_from: "security_assessment" },
        })
        .select("id")
        .single();
      if (assignmentError) throw new Error(assignmentError.message);
      assignmentId = assignment.id;
    }

    const title = data.title?.trim() || `${clone.name} ${data.cycle.replace("_", "-")} penetration test`;
    const { data: assessment, error } = await admin
      .from("security_assessments")
      .insert({
        partner_id: data.partnerId,
        clone_id: data.cloneId,
        assignment_id: assignmentId,
        title,
        cycle: data.cycle,
        status: "pending",
        scope_summary: data.scopeSummary?.trim() || null,
        rules_of_engagement: data.rulesOfEngagement?.trim() || null,
        exclusions: data.exclusions?.trim() || null,
        target_urls: cleanTextList(data.targetUrls),
        testing_window_start: data.testingWindowStart || null,
        testing_window_end: data.testingWindowEnd || null,
        emergency_stop_contact: data.emergencyStopContact?.trim() || null,
        escalation_contacts: cleanTextList(data.escalationContacts),
        due_at: data.dueAt || null,
        retest_required: data.retestRequired,
        created_by: context.userId,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeSecurityEvent({
      assessmentId: assessment.id,
      partnerId: data.partnerId,
      cloneId: data.cloneId,
      actorUserId: context.userId,
      actorKind: "aurixa",
      eventType: "assessment.created",
      body: "Aurixa activated the Cybersecurity Module for this client testing cycle.",
      metadata: { cycle: data.cycle, assignment_id: assignmentId },
    });

    await writeAudit({
      actorUserId: context.userId,
      action: "security.assessment.created",
      entityType: "security_assessment",
      entityId: assessment.id,
      metadata: { partner_id: data.partnerId, clone_id: data.cloneId, cycle: data.cycle },
    });

    return { ok: true, assessment };
  });

export const updateSecurityAssessmentAdmin = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        assessmentId: z.string().uuid(),
        status: AssessmentStatus.optional(),
        aurixaReviewStatus: ReviewStatus.optional(),
        clientReleaseApproved: z.boolean().optional(),
        remediationOwner: z.string().optional(),
        retestRequired: z.boolean().optional(),
        note: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.status) patch.status = data.status;
    if (data.status === "closed") patch.completed_at = new Date().toISOString();
    if (data.status === "in_progress") patch.started_at = new Date().toISOString();
    if (data.aurixaReviewStatus) patch.aurixa_review_status = data.aurixaReviewStatus;
    if (typeof data.clientReleaseApproved === "boolean") patch.client_release_approved = data.clientReleaseApproved;
    if (typeof data.retestRequired === "boolean") patch.retest_required = data.retestRequired;
    if (data.remediationOwner !== undefined) patch.remediation_owner = data.remediationOwner.trim() || null;

    const { data: row, error } = await admin
      .from("security_assessments")
      .update(patch)
      .eq("id", data.assessmentId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeSecurityEvent({
      assessmentId: row.id,
      partnerId: row.partner_id,
      cloneId: row.clone_id,
      actorUserId: context.userId,
      actorKind: "aurixa",
      eventType: "assessment.admin_updated",
      body: data.note?.trim() || null,
      metadata: patch,
    });

    return { ok: true, assessment: row };
  });

export const getPartnerPortal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const email = (context.claims as any)?.email as string | undefined;
    const memberships = await getActiveMemberships(context.userId, email);
    const partnerIds = memberships
      .map((m: any) => m.partner_id as string)
      .filter(Boolean);

    if (partnerIds.length === 0) {
      return { ok: false, reason: "no_partner_membership", memberships: [] };
    }

    const { data: assessments, error } = await admin
      .from("security_assessments")
      .select("*, clones(id, name, deploy_url, tags), security_partners(id, name, slug), security_findings(*), security_reports(*), security_assessment_comments(*), security_assessment_events(*)")
      .in("partner_id", partnerIds)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    const visibleAssessments = (assessments ?? []).map((assessment: any) => ({
      ...assessment,
      security_assessment_comments: (assessment.security_assessment_comments ?? []).filter(
        (comment: any) => comment.visibility === "partner_thread",
      ),
    }));

    const stats = {
      assigned: visibleAssessments.length,
      active: visibleAssessments.filter((a: any) =>
        ["pending", "scheduled", "in_progress", "reporting", "remediation_review", "retesting"].includes(a.status),
      ).length,
      closed: visibleAssessments.filter((a: any) => a.status === "closed").length,
      criticalFindings: visibleAssessments.reduce(
        (sum: number, a: any) =>
          sum + ((a.security_findings ?? []).filter((f: any) => f.severity === "critical").length ?? 0),
        0,
      ),
    };

    return {
      ok: true,
      memberships,
      activePartner: memberships[0]?.security_partners ?? null,
      assessments: visibleAssessments,
      stats,
    };
  });

export const updatePartnerAssessment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        assessmentId: z.string().uuid(),
        status: AssessmentStatus.optional(),
        scopeSummary: z.string().optional(),
        rulesOfEngagement: z.string().optional(),
        exclusions: z.string().optional(),
        targetUrls: z.array(z.string()).optional(),
        testingWindowStart: z.string().nullable().optional(),
        testingWindowEnd: z.string().nullable().optional(),
        emergencyStopContact: z.string().optional(),
        escalationContacts: z.array(z.string()).optional(),
        note: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const email = (context.claims as any)?.email as string | undefined;
    const { assessment } = await getAssessmentForPartnerAccess(data.assessmentId, context.userId, email);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.status) {
      patch.status = data.status;
      if (data.status === "in_progress" && !assessment.started_at) patch.started_at = new Date().toISOString();
      if (data.status === "closed") patch.completed_at = new Date().toISOString();
      if (["reporting", "remediation_review"].includes(data.status)) patch.aurixa_review_status = "submitted";
    }
    if (data.scopeSummary !== undefined) patch.scope_summary = data.scopeSummary.trim() || null;
    if (data.rulesOfEngagement !== undefined) patch.rules_of_engagement = data.rulesOfEngagement.trim() || null;
    if (data.exclusions !== undefined) patch.exclusions = data.exclusions.trim() || null;
    if (data.targetUrls !== undefined) patch.target_urls = cleanTextList(data.targetUrls);
    if (data.testingWindowStart !== undefined) patch.testing_window_start = data.testingWindowStart || null;
    if (data.testingWindowEnd !== undefined) patch.testing_window_end = data.testingWindowEnd || null;
    if (data.emergencyStopContact !== undefined) patch.emergency_stop_contact = data.emergencyStopContact.trim() || null;
    if (data.escalationContacts !== undefined) patch.escalation_contacts = cleanTextList(data.escalationContacts);

    const { data: row, error } = await admin
      .from("security_assessments")
      .update(patch)
      .eq("id", data.assessmentId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeSecurityEvent({
      assessmentId: row.id,
      partnerId: row.partner_id,
      cloneId: row.clone_id,
      actorUserId: context.userId,
      actorKind: "partner",
      eventType: "assessment.partner_updated",
      body: data.note?.trim() || null,
      metadata: patch,
    });

    return { ok: true, assessment: row };
  });

export const createSecurityFinding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        assessmentId: z.string().uuid(),
        title: z.string().min(3),
        severity: Severity.default("medium"),
        affectedAsset: z.string().optional(),
        description: z.string().optional(),
        evidence: z.string().optional(),
        recommendation: z.string().optional(),
        cvss: z.string().optional(),
        cwe: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const isInternal = await userHasInternalRole(context.supabase, context.userId);
    const email = (context.claims as any)?.email as string | undefined;
    let assessment;
    if (isInternal) {
      const res = await admin
        .from("security_assessments")
        .select("id, partner_id, clone_id")
        .eq("id", data.assessmentId)
        .maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) throw new Error("assessment_not_found");
      assessment = res.data;
    } else {
      assessment = (await getAssessmentForPartnerAccess(data.assessmentId, context.userId, email)).assessment;
    }

    const { data: row, error } = await admin
      .from("security_findings")
      .insert({
        assessment_id: data.assessmentId,
        partner_id: assessment.partner_id,
        clone_id: assessment.clone_id,
        title: data.title.trim(),
        severity: data.severity,
        affected_asset: data.affectedAsset?.trim() || null,
        description: data.description?.trim() || null,
        evidence: data.evidence?.trim() || null,
        recommendation: data.recommendation?.trim() || null,
        cvss: data.cvss?.trim() || null,
        cwe: data.cwe?.trim() || null,
        submitted_by: context.userId,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeSecurityEvent({
      assessmentId: data.assessmentId,
      partnerId: assessment.partner_id,
      cloneId: assessment.clone_id,
      actorUserId: context.userId,
      actorKind: isInternal ? "aurixa" : "partner",
      eventType: "finding.created",
      body: row.title,
      metadata: { finding_id: row.id, severity: row.severity },
    });

    return { ok: true, finding: row };
  });

export const updateSecurityFinding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        findingId: z.string().uuid(),
        status: FindingStatus.optional(),
        retestStatus: RetestStatus.optional(),
        recommendation: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: finding, error: findingError } = await admin
      .from("security_findings")
      .select("id, assessment_id, partner_id, clone_id")
      .eq("id", data.findingId)
      .maybeSingle();
    if (findingError) throw new Error(findingError.message);
    if (!finding) throw new Error("finding_not_found");

    const isInternal = await userHasInternalRole(context.supabase, context.userId);
    if (!isInternal) {
      const email = (context.claims as any)?.email as string | undefined;
      await getAssessmentForPartnerAccess(finding.assessment_id, context.userId, email);
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.status) {
      patch.status = data.status;
      if (["resolved", "accepted_risk", "false_positive"].includes(data.status)) {
        patch.resolved_at = new Date().toISOString();
      }
    }
    if (data.retestStatus) patch.retest_status = data.retestStatus;
    if (data.recommendation !== undefined) patch.recommendation = data.recommendation.trim() || null;

    const { data: row, error } = await admin
      .from("security_findings")
      .update(patch)
      .eq("id", data.findingId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeSecurityEvent({
      assessmentId: finding.assessment_id,
      partnerId: finding.partner_id,
      cloneId: finding.clone_id,
      actorUserId: context.userId,
      actorKind: isInternal ? "aurixa" : "partner",
      eventType: "finding.updated",
      body: data.note?.trim() || null,
      metadata: { finding_id: data.findingId, ...patch },
    });

    return { ok: true, finding: row };
  });

export const createSecurityReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        assessmentId: z.string().uuid(),
        label: z.string().min(3),
        reportType: ReportType.default("draft"),
        fileUrl: z.string().url().optional().or(z.literal("")),
        filePath: z.string().optional(),
        notes: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const isInternal = await userHasInternalRole(context.supabase, context.userId);
    const email = (context.claims as any)?.email as string | undefined;
    let assessment;
    if (isInternal) {
      const res = await admin
        .from("security_assessments")
        .select("id, partner_id, clone_id")
        .eq("id", data.assessmentId)
        .maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) throw new Error("assessment_not_found");
      assessment = res.data;
    } else {
      assessment = (await getAssessmentForPartnerAccess(data.assessmentId, context.userId, email)).assessment;
    }

    const { data: row, error } = await admin
      .from("security_reports")
      .insert({
        assessment_id: data.assessmentId,
        partner_id: assessment.partner_id,
        clone_id: assessment.clone_id,
        label: data.label.trim(),
        report_type: data.reportType,
        file_url: data.fileUrl?.trim() || null,
        file_path: data.filePath?.trim() || null,
        notes: data.notes?.trim() || null,
        submitted_by: context.userId,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await admin
      .from("security_assessments")
      .update({
        status: "reporting",
        aurixa_review_status: "submitted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.assessmentId);

    await writeSecurityEvent({
      assessmentId: data.assessmentId,
      partnerId: assessment.partner_id,
      cloneId: assessment.clone_id,
      actorUserId: context.userId,
      actorKind: isInternal ? "aurixa" : "partner",
      eventType: "report.submitted",
      body: row.label,
      metadata: { report_id: row.id, report_type: row.report_type, file_url: row.file_url },
    });

    return { ok: true, report: row };
  });

export const addSecurityAssessmentComment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        assessmentId: z.string().uuid(),
        body: z.string().min(1),
        visibility: z.enum(["partner_thread", "internal"]).default("partner_thread"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const isInternal = await userHasInternalRole(context.supabase, context.userId);
    const email = (context.claims as any)?.email as string | undefined;
    let assessment;
    if (isInternal) {
      const res = await admin
        .from("security_assessments")
        .select("id, partner_id, clone_id")
        .eq("id", data.assessmentId)
        .maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) throw new Error("assessment_not_found");
      assessment = res.data;
    } else {
      assessment = (await getAssessmentForPartnerAccess(data.assessmentId, context.userId, email)).assessment;
    }

    const visibility = isInternal ? data.visibility : "partner_thread";
    const { data: row, error } = await admin
      .from("security_assessment_comments")
      .insert({
        assessment_id: data.assessmentId,
        partner_id: assessment.partner_id,
        clone_id: assessment.clone_id,
        author_user_id: context.userId,
        author_kind: isInternal ? "aurixa" : "partner",
        visibility,
        body: data.body.trim(),
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await writeSecurityEvent({
      assessmentId: data.assessmentId,
      partnerId: assessment.partner_id,
      cloneId: assessment.clone_id,
      actorUserId: context.userId,
      actorKind: isInternal ? "aurixa" : "partner",
      eventType: "comment.created",
      body: visibility === "internal" ? "Internal Aurixa note added." : data.body.trim(),
      metadata: { comment_id: row.id, visibility },
    });

    return { ok: true, comment: row };
  });