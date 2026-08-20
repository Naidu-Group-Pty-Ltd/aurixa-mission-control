// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Two-key merge gate for Codex remediation PRs. Admins record approve /
// reject / changes-requested decisions; merging a PR requires N distinct
// approvals from admins other than the requester.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

const ReviewInput = z.object({
  remediationId: z.string().uuid(),
  decision: z.enum(["approve", "reject", "changes_requested"]),
  comment: z.string().max(2000).optional(),
});

export const reviewRemediation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ReviewInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: rem, error: rErr } = await supabase
      .from("codex_remediations")
      .select("id, requested_by, status, approvals_required, finding_id, scan_job_id")
      .eq("id", data.remediationId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!rem) throw new Error("remediation not found");
    if (rem.requested_by === userId && data.decision === "approve") {
      throw new Error("Requester cannot approve their own remediation");
    }
    if (["merged", "closed", "rejected", "failed"].includes(rem.status)) {
      throw new Error(`Cannot review remediation in status: ${rem.status}`);
    }

    // Upsert reviewer's decision (one review per admin per remediation).
    const { error: upErr } = await supabase.from("codex_remediation_reviews").upsert(
      {
        remediation_id: rem.id,
        reviewer_id: userId,
        decision: data.decision,
        comment: data.comment ?? null,
      },
      { onConflict: "remediation_id,reviewer_id" },
    );
    if (upErr) throw upErr;

    // Recompute aggregate status.
    const { data: reviews } = await supabase
      .from("codex_remediation_reviews")
      .select("decision, reviewer_id")
      .eq("remediation_id", rem.id);
    const approvals = (reviews ?? []).filter((r: any) => r.decision === "approve").length;
    const rejects = (reviews ?? []).filter((r: any) => r.decision === "reject").length;
    const changes = (reviews ?? []).filter((r: any) => r.decision === "changes_requested").length;

    let newStatus: string | null = null;
    if (rejects > 0) newStatus = "rejected";
    else if (changes > 0 && approvals < rem.approvals_required) newStatus = "changes_requested";
    else if (approvals >= rem.approvals_required) newStatus = "approved";

    if (newStatus && newStatus !== rem.status) {
      const patch: Database["public"]["Tables"]["codex_remediations"]["Update"] = {
        status: newStatus as Database["public"]["Enums"]["codex_remediation_status"],
      };
      if (newStatus === "rejected") {
        patch.rejected_by = userId;
        patch.rejected_at = new Date().toISOString();
        patch.rejected_reason = data.comment ?? null;
      }
      await supabase.from("codex_remediations").update(patch).eq("id", rem.id);
    }

    // Audit event. `codex_scan_events.job_id` is NOT NULL, so a remediation
    // that was never tied to a scan job simply has no event trail to append to.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scanJobId = rem.scan_job_id;
    if (scanJobId) await supabaseAdmin.from("codex_scan_events").insert({
      job_id: scanJobId,
      event_type: `remediation.review.${data.decision}`,
      actor: userId,
      payload: {
        remediation_id: rem.id,
        approvals,
        rejects,
        changes_requested: changes,
        required: rem.approvals_required,
      },
    });

    return { approvals, rejects, changes_requested: changes, status: newStatus ?? rem.status };
  });

const ListInput = z.object({ remediationId: z.string().uuid() });

export const listRemediationReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("codex_remediation_reviews")
      .select("id, reviewer_id, decision, comment, created_at")
      .eq("remediation_id", data.remediationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return { reviews: rows ?? [] };
  });

const MergeInput = z.object({
  remediationId: z.string().uuid(),
  method: z.enum(["squash", "merge", "rebase"]).optional(),
});

export const mergeRemediationPR = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => MergeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: rem } = await supabase
      .from("codex_remediations")
      .select(
        "id, status, approvals_required, requested_by, repo_full_name, pr_number, scan_job_id, finding_id, clone_id, base_ref, branch_name",
      )
      .eq("id", data.remediationId)
      .maybeSingle();
    if (!rem) throw new Error("remediation not found");
    if (!rem.pr_number) throw new Error("PR not yet opened");
    if (rem.status === "merged") throw new Error("Already merged");
    if (rem.status === "rejected") throw new Error("Remediation was rejected");
    // NOT NULL on codex_scan_events.job_id: no scan job, no event trail.
    const scanJobId = rem.scan_job_id;

    // Verify approval count from DB (never trust client status).
    const { data: reviews } = await supabase
      .from("codex_remediation_reviews")
      .select("decision, reviewer_id")
      .eq("remediation_id", rem.id);
    const approvals = (reviews ?? []).filter(
      (r: any) => r.decision === "approve" && r.reviewer_id !== rem.requested_by,
    );
    const uniqueApprovers = new Set(approvals.map((r: any) => r.reviewer_id));
    if (uniqueApprovers.size < rem.approvals_required) {
      throw new Error(`Insufficient approvals: ${uniqueApprovers.size}/${rem.approvals_required}`);
    }
    if ((reviews ?? []).some((r: any) => r.decision === "reject")) {
      throw new Error("A reviewer rejected this remediation");
    }
    if (uniqueApprovers.has(userId) === false && rem.requested_by === userId) {
      throw new Error("Requester cannot merge without independent approvals");
    }

    const [owner, repo] = (rem.repo_full_name || "").split("/");
    if (!owner || !repo) throw new Error("Invalid repo on remediation");

    // Resolve installation id from prime_config or clones. The clone lookup
    // goes through the tolerant loader — naming an optional column inline
    // fails the whole select on an unmigrated deployment.
    let installationId: string | null = null;
    if (rem.clone_id) {
      const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
      installationId = await loadCloneInstallationId(supabase, rem.clone_id);
    } else {
      const { data: p } = await supabase
        .from("prime_config")
        .select("github_app_installation_id")
        .limit(1)
        .maybeSingle();
      installationId = p?.github_app_installation_id ?? null;
    }

    const { mergeRemediationPRViaGitHub } = await import("@/server/codex-remediation.server");
    const merge = await mergeRemediationPRViaGitHub({
      owner,
      repo,
      prNumber: rem.pr_number,
      installationId,
      commitTitle: `Codex remediation #${rem.pr_number}`,
      commitMessage: `Approved by ${uniqueApprovers.size} reviewer(s) via Mission Control.`,
      method: data.method || "squash",
    });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Load finding title for cascade summary + audit payload.
    const { data: finding } = await supabaseAdmin
      .from("codex_findings")
      .select("title, severity, cwe")
      .eq("id", rem.finding_id)
      .maybeSingle();

    // Phase 3: cascade the merged security patch to the clone fleet.
    // Only fan out when the remediation lives in Prime — clone-scoped
    // fixes stay in that clone. Choose cascade mode from prime_config,
    // falling back to `pr` for safety.
    let cascadeEventId: string | null = null;
    let cascadeError: string | null = null;
    if (!rem.clone_id) {
      try {
        const { data: prime } = await supabaseAdmin
          .from("prime_config")
          .select("default_cascade_mode, default_branch")
          .limit(1)
          .maybeSingle();
        const mode = (prime?.default_cascade_mode as any) || "pr";
        const sourceBranch = prime?.default_branch || rem.base_ref || "main";
        const title = (finding?.title || "security patch").slice(0, 140);
        const severity = (finding?.severity || "").toUpperCase();
        const { createCascadeForAllClones } = await import("@/server/cascade-trigger.server");
        const cascade = await createCascadeForAllClones({
          supabase: supabaseAdmin,
          mode,
          trigger: "commit",
          sourceBranch,
          sourceSha: merge.sha,
          initiatedBy: userId,
          summary: `Codex security patch${severity ? ` [${severity}]` : ""}: ${title} (PR #${rem.pr_number})`,
        });
        cascadeEventId = cascade.eventId;
        if (cascade.error && !cascade.eventId) {
          cascadeError = cascade.error;
        }
      } catch (err) {
        cascadeError = (err as Error).message;
      }
    }

    await supabaseAdmin
      .from("codex_remediations")
      .update({
        status: "merged",
        merged_by: userId,
        merged_at: new Date().toISOString(),
        merge_commit_sha: merge.sha,
        pr_state: "merged",
        completed_at: new Date().toISOString(),
        cascade_event_id: cascadeEventId,
      })
      .eq("id", rem.id);
    await supabaseAdmin
      .from("codex_findings")
      .update({ state: "fix_merged", resolved_at: new Date().toISOString() })
      .eq("id", rem.finding_id);
    if (scanJobId) await supabaseAdmin.from("codex_scan_events").insert({
      job_id: scanJobId,
      event_type: "remediation.merged",
      actor: userId,
      payload: {
        remediation_id: rem.id,
        sha: merge.sha,
        pr_number: rem.pr_number,
        cascade_event_id: cascadeEventId,
        cascade_error: cascadeError,
      },
    });
    if (cascadeEventId && scanJobId) {
      await supabaseAdmin.from("codex_scan_events").insert({
        job_id: scanJobId,
        event_type: "remediation.cascade_triggered",
        actor: userId,
        payload: {
          remediation_id: rem.id,
          cascade_event_id: cascadeEventId,
          source_sha: merge.sha,
        },
      });
    } else if (cascadeError && scanJobId) {
      await supabaseAdmin.from("codex_scan_events").insert({
        job_id: scanJobId,
        event_type: "remediation.cascade_skipped",
        actor: userId,
        payload: { remediation_id: rem.id, reason: cascadeError },
      });
    }

    return {
      ok: true,
      sha: merge.sha,
      // Remediation PRs are opened as drafts and GitHub refuses to merge a
      // draft; the merge helper clears the flag first. Surfaced so the
      // operator knows the PR left draft state on their behalf.
      wasDraft: merge.wasDraft,
      cascadeEventId,
      cascadeError,
    };
  });
