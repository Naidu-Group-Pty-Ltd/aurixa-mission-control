// @ts-nocheck
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const DraftInput = z.object({
  findingId: z.string().uuid(),
  baseRef: z.string().optional(),
});

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function resolveRepo(
  supabase: any,
  targetKind: string,
  cloneId: string | null,
  fallbackRepo: string,
) {
  if (targetKind === "prime") {
    const { data: p } = await supabase
      .from("prime_config")
      .select("github_owner, github_repo, default_branch, github_app_installation_id")
      .limit(1)
      .maybeSingle();
    if (!p) throw new Error("prime_config not set");
    return {
      owner: p.github_owner,
      repo: p.github_repo,
      baseRef: p.default_branch || "main",
      installationId: p.github_app_installation_id ?? null,
    };
  }
  if (!cloneId) throw new Error("cloneId missing for clone remediation");
  const { data: c } = await supabase
    .from("clones")
    .select("github_owner, github_repo, default_branch, github_app_installation_id")
    .eq("id", cloneId)
    .maybeSingle();
  if (!c) throw new Error("clone not found");
  const [owner, repo] = (fallbackRepo || "").split("/");
  return {
    owner: c.github_owner || owner,
    repo: c.github_repo || repo,
    baseRef: c.default_branch || "main",
    installationId: c.github_app_installation_id ?? null,
  };
}

export const draftRemediationPR = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => DraftInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Admin-only gate — RLS enforces too.
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: finding, error: fErr } = await supabase
      .from("codex_findings")
      .select(
        "id, scan_job_id, clone_id, codex_finding_id, title, severity, description, affected_file, affected_line, cwe, state",
      )
      .eq("id", data.findingId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!finding) throw new Error("finding not found");

    const { data: job } = await supabase
      .from("codex_scan_jobs")
      .select("id, target_kind, clone_id, repo_full_name, ref")
      .eq("id", finding.scan_job_id)
      .maybeSingle();
    if (!job) throw new Error("scan job not found");

    // Refuse to double-book an in-flight remediation for the same finding.
    const { data: existing } = await supabase
      .from("codex_remediations")
      .select("id, status")
      .eq("finding_id", finding.id)
      .in("status", ["queued", "dispatched", "pr_opened", "pr_updated"])
      .maybeSingle();
    if (existing) {
      return { remediationId: existing.id, reused: true };
    }

    const repoInfo = await resolveRepo(
      supabase,
      job.target_kind,
      job.clone_id,
      job.repo_full_name,
    );
    const baseRef = data.baseRef || job.ref || repoInfo.baseRef;
    const branchName = `codex/fix-${slugify(finding.severity + "-" + finding.title)}-${finding.codex_finding_id.slice(0, 8)}`;

    const { data: row, error: insErr } = await supabase
      .from("codex_remediations")
      .insert({
        finding_id: finding.id,
        scan_job_id: finding.scan_job_id,
        clone_id: finding.clone_id,
        repo_full_name: `${repoInfo.owner}/${repoInfo.repo}`,
        base_ref: baseRef,
        branch_name: branchName,
        status: "queued",
        requested_by: userId,
        dispatch_payload: {
          finding_id: finding.codex_finding_id,
          title: finding.title,
          severity: finding.severity,
        },
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // Fire-and-forget dispatch to GitHub Actions.
    (async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      try {
        const { dispatchRemediationWorkflow } = await import(
          "@/server/codex-remediation.server"
        );
        const origin =
          process.env.APP_PUBLIC_URL || "https://mission-control.aurixasystems.com.au";
        const callbackSecret = process.env.CODEX_REMEDIATION_WEBHOOK_SECRET || "";
        const res = await dispatchRemediationWorkflow({
          remediationId: row.id,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          baseRef,
          branchName,
          installationId: repoInfo.installationId,
          finding: {
            id: finding.codex_finding_id,
            title: finding.title,
            severity: finding.severity,
            description: finding.description,
            file: finding.affected_file,
            line: finding.affected_line,
            cwe: finding.cwe,
          },
          callbackUrl: `${origin}/api/public/hooks/codex-remediation`,
          callbackSecret,
        });
        await supabaseAdmin
          .from("codex_remediations")
          .update({
            status: "dispatched",
            dispatched_at: new Date().toISOString(),
            workflow_run_id: res.workflowRunId,
            workflow_run_url: res.workflowRunUrl,
          })
          .eq("id", row.id);
        await supabaseAdmin
          .from("codex_findings")
          .update({ state: "fix_drafted" })
          .eq("id", finding.id);
        await supabaseAdmin.from("codex_scan_events").insert({
          job_id: finding.scan_job_id,
          event_type: "remediation.dispatched",
          actor: userId,
          payload: {
            remediation_id: row.id,
            finding_id: finding.id,
            workflow_run_id: res.workflowRunId,
          },
        });
      } catch (err) {
        await supabaseAdmin
          .from("codex_remediations")
          .update({
            status: "failed",
            last_error: (err as Error).message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        await supabaseAdmin.from("codex_scan_events").insert({
          job_id: finding.scan_job_id,
          event_type: "remediation.dispatch_failed",
          actor: userId,
          payload: { remediation_id: row.id, error: (err as Error).message },
        });
      }
    })();

    return { remediationId: row.id, reused: false };
  });

const ListInput = z.object({
  jobId: z.string().uuid().optional(),
  findingId: z.string().uuid().optional(),
});

export const listRemediations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("codex_remediations")
      .select(
        "id, finding_id, scan_job_id, repo_full_name, base_ref, branch_name, workflow_run_id, workflow_run_url, pr_number, pr_url, pr_state, status, last_error, dispatched_at, completed_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (data.jobId) q = q.eq("scan_job_id", data.jobId);
    if (data.findingId) q = q.eq("finding_id", data.findingId);
    const { data: rows, error } = await q;
    if (error) throw error;
    return { remediations: rows ?? [] };
  });
