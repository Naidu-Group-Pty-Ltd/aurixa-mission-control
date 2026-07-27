// @ts-nocheck
// Phase 6 — Bridge Codex findings into the Security Partner Portal and
// export a signed sign-off bundle to the security-reports bucket.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const admin = supabaseAdmin as any;
const REPORT_BUCKET = "security-reports";

async function writeSecurityEvent(input: {
  assessmentId: string;
  partnerId?: string | null;
  cloneId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await admin.from("security_assessment_events").insert({
    assessment_id: input.assessmentId,
    partner_id: input.partnerId ?? null,
    clone_id: input.cloneId ?? null,
    actor_user_id: input.actorUserId ?? null,
    actor_kind: "aurixa",
    event_type: input.eventType,
    body: input.body ?? null,
    metadata: input.metadata ?? {},
  });
}

/**
 * Mirror open Codex findings for an assessment's clone into
 * public.security_findings, so EC-Council reviewers can triage them in the
 * partner portal alongside their own findings. Idempotent — the unique
 * (assessment_id, codex_finding_id) index guards duplicates.
 */
export const bridgeCodexFindingsToAssessment = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ assessmentId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: assessment, error: aErr } = await admin
      .from("security_assessments")
      .select("id, clone_id, partner_id, status")
      .eq("id", data.assessmentId)
      .maybeSingle();
    if (aErr) throw new Error(aErr.message);
    if (!assessment) throw new Error("assessment_not_found");
    if (!assessment.clone_id) throw new Error("assessment_has_no_clone");

    const { data: codex, error: cErr } = await admin
      .from("codex_findings")
      .select(
        "id, codex_finding_id, title, description, severity, state, cvss, cwe, affected_file, affected_line, remediation_pr_url, remediation_pr_state",
      )
      .eq("clone_id", assessment.clone_id)
      .in("state", ["open", "triaging", "fix_drafted", "pr_open", "fix_merged"]);
    if (cErr) throw new Error(cErr.message);

    const rows = codex ?? [];

    // Previously this ran a SELECT plus an INSERT/UPDATE per finding — three
    // round trips per row, so a clone with 200 findings meant ~400 queries
    // and routinely timed out. One lookup + two batched writes instead.
    const { data: mirrored, error: mErr } = await admin
      .from("security_findings")
      .select("id, codex_finding_id")
      .eq("assessment_id", assessment.id)
      .not("codex_finding_id", "is", null);
    if (mErr) throw new Error(mErr.message);

    const existingByCodexId = new Map<string, string>(
      (mirrored ?? []).map((m: any) => [m.codex_finding_id, m.id]),
    );

    const nowIso = new Date().toISOString();
    const toInsert: any[] = [];
    const toUpdate: any[] = [];

    for (const f of rows) {
      const affectedAsset = [f.affected_file, f.affected_line].filter(Boolean).join(":") || null;
      const base = {
        assessment_id: assessment.id,
        partner_id: assessment.partner_id,
        clone_id: assessment.clone_id,
        codex_finding_id: f.id,
        source: "codex",
        title: `[Codex] ${f.title}`,
        severity: f.severity,
        description: f.description,
        affected_asset: affectedAsset,
        cvss: f.cvss != null ? String(f.cvss) : null,
        cwe: f.cwe ?? null,
        remediation_pr_url: f.remediation_pr_url ?? null,
      };

      const existingId = existingByCodexId.get(f.id);
      if (existingId) {
        toUpdate.push({ ...base, id: existingId, updated_at: nowIso });
      } else {
        toInsert.push({ ...base, recommendation: null, submitted_by: context.userId });
      }
    }

    let created = 0;
    let updated = 0;

    if (toInsert.length) {
      const ins = await admin.from("security_findings").insert(toInsert).select("id");
      if (ins.error) throw new Error(ins.error.message);
      created = ins.data?.length ?? 0;
    }

    if (toUpdate.length) {
      // Upsert on the primary key updates the whole batch in one statement.
      const upd = await admin
        .from("security_findings")
        .upsert(toUpdate, { onConflict: "id" })
        .select("id");
      if (upd.error) throw new Error(upd.error.message);
      updated = upd.data?.length ?? 0;
    }

    await writeSecurityEvent({
      assessmentId: assessment.id,
      partnerId: assessment.partner_id,
      cloneId: assessment.clone_id,
      actorUserId: context.userId,
      eventType: "codex.bridge_sync",
      body: `Mirrored ${created} new + ${updated} updated Codex findings into this assessment.`,
      metadata: { created, updated, considered: rows.length },
    });

    return { ok: true, created, updated, considered: rows.length };
  });

/**
 * Export a signed sign-off bundle for an assessment (assessment metadata,
 * findings, comments, reports, event log) to the security-reports bucket
 * and register it as a `security_reports` row of type `final`.
 */
export const exportPartnerSignoffBundle = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        assessmentId: z.string().uuid(),
        label: z.string().min(3).max(160).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: assessment, error: aErr } = await admin
      .from("security_assessments")
      .select(
        "*, security_partners(id, name, slug), clones(id, name, deploy_url, github_url), security_findings(*), security_reports(id, label, report_type, status, submitted_at, file_path, file_url), security_assessment_comments(id, author_kind, visibility, body, created_at), security_assessment_events(id, actor_kind, event_type, body, metadata, created_at)",
      )
      .eq("id", data.assessmentId)
      .maybeSingle();

    if (aErr) throw new Error(aErr.message);
    if (!assessment) throw new Error("assessment_not_found");

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const filePath = `bundles/${assessment.id}/signoff-${stamp}.json`;
    const label =
      data.label?.trim() || `Partner sign-off bundle — ${now.toISOString().slice(0, 10)}`;

    const bundle = {
      generated_at: now.toISOString(),
      generated_by: context.userId,
      assessment: {
        id: assessment.id,
        title: assessment.title,
        cycle: assessment.cycle,
        status: assessment.status,
        aurixa_review_status: assessment.aurixa_review_status,
        client_release_approved: assessment.client_release_approved,
        retest_required: assessment.retest_required,
        scope_summary: assessment.scope_summary,
        rules_of_engagement: assessment.rules_of_engagement,
        exclusions: assessment.exclusions,
        target_urls: assessment.target_urls,
        testing_window_start: assessment.testing_window_start,
        testing_window_end: assessment.testing_window_end,
        due_at: assessment.due_at,
        started_at: assessment.started_at,
        completed_at: assessment.completed_at,
      },
      clone: assessment.clones,
      partner: assessment.security_partners,
      findings: assessment.security_findings ?? [],
      reports: assessment.security_reports ?? [],
      comments: assessment.security_assessment_comments ?? [],
      events: assessment.security_assessment_events ?? [],
      totals: {
        findings: (assessment.security_findings ?? []).length,
        open: (assessment.security_findings ?? []).filter((f: any) => f.status === "open").length,
        critical: (assessment.security_findings ?? []).filter((f: any) => f.severity === "critical")
          .length,
        codex_mirrored: (assessment.security_findings ?? []).filter(
          (f: any) => f.source === "codex",
        ).length,
      },
    };

    const body = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
    const upload = await admin.storage
      .from(REPORT_BUCKET)
      .upload(filePath, body, { contentType: "application/json", upsert: true });
    if (upload.error) throw new Error(upload.error.message);

    const report = await admin
      .from("security_reports")
      .insert({
        assessment_id: assessment.id,
        partner_id: assessment.partner_id,
        clone_id: assessment.clone_id,
        label,
        report_type: "final",
        status: "submitted",
        file_path: filePath,
        notes: `Auto-generated sign-off bundle (${bundle.totals.findings} findings; ${bundle.totals.codex_mirrored} from Codex).`,
        submitted_by: context.userId,
      })
      .select("id, file_path, label, report_type, status, submitted_at")
      .single();

    if (report.error) throw new Error(report.error.message);

    await writeSecurityEvent({
      assessmentId: assessment.id,
      partnerId: assessment.partner_id,
      cloneId: assessment.clone_id,
      actorUserId: context.userId,
      eventType: "signoff.bundle_exported",
      body: label,
      metadata: { report_id: report.data.id, file_path: filePath, totals: bundle.totals },
    });

    await admin.from("audit_log").insert({
      action: "security.signoff.bundle_exported",
      entity_type: "security_assessment",
      entity_id: assessment.id,
      actor_user_id: context.userId,
      metadata: { report_id: report.data.id, file_path: filePath },
    });

    return { ok: true, report: report.data, totals: bundle.totals };
  });
