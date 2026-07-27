// @ts-nocheck
// Server-only helpers for dispatching a Codex Security remediation PR
// workflow. Uses the Aurixa GitHub App to trigger a `workflow_dispatch`
// event on the target repository (Prime or a clone). The workflow itself
// lives in the target repo at `.github/workflows/codex-remediation.yml`
// and is responsible for producing the draft PR and calling the
// remediation callback with the resulting PR URL / state.

import { getAppOctokit } from "@/server/github-app.server";

export type DispatchRemediationInput = {
  remediationId: string;
  owner: string;
  repo: string;
  baseRef: string;
  branchName: string;
  installationId?: string | null;
  finding: {
    id: string;
    title: string;
    severity: string;
    description?: string | null;
    file?: string | null;
    line?: number | null;
    cwe?: string | null;
  };
  callbackUrl: string;
  callbackSecret: string;
  workflowFile?: string;
};

export type DispatchRemediationResult = {
  workflowRunId: number | null;
  workflowRunUrl: string | null;
};

/**
 * Trigger the codex-remediation workflow on the target repo. GitHub's
 * `workflow_dispatch` endpoint does NOT return the run id, so we fetch
 * the most recent run for the workflow immediately after and store its
 * id + html_url on the remediation row.
 */
export async function dispatchRemediationWorkflow(
  input: DispatchRemediationInput,
): Promise<DispatchRemediationResult> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  const workflowFile = input.workflowFile || "codex-remediation.yml";

  const inputs = {
    remediation_id: input.remediationId,
    finding_id: input.finding.id,
    finding_title: (input.finding.title || "").slice(0, 200),
    finding_severity: input.finding.severity,
    finding_file: input.finding.file ?? "",
    finding_line: String(input.finding.line ?? ""),
    finding_cwe: input.finding.cwe ?? "",
    finding_description: (input.finding.description ?? "").slice(0, 4000),
    base_ref: input.baseRef,
    branch_name: input.branchName,
    callback_url: input.callbackUrl,
    callback_secret: input.callbackSecret,
  } as Record<string, string>;

  const dispatchedAt = new Date();

  await octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner: input.owner,
    repo: input.repo,
    workflow_id: workflowFile,
    ref: input.baseRef,
    inputs,
  });

  // Best-effort: find the run we just triggered.
  let workflowRunId: number | null = null;
  let workflowRunUrl: string | null = null;
  try {
    // Small wait so GitHub has time to schedule the run.
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      {
        owner: input.owner,
        repo: input.repo,
        workflow_id: workflowFile,
        event: "workflow_dispatch",
        per_page: 5,
      },
    );
    const match = runs.data.workflow_runs.find((r: any) => {
      const created = new Date(r.created_at).getTime();
      return created >= dispatchedAt.getTime() - 5000;
    });
    if (match) {
      workflowRunId = match.id;
      workflowRunUrl = match.html_url;
    }
  } catch {
    /* non-fatal — the callback will still update state */
  }

  return { workflowRunId, workflowRunUrl };
}

/**
 * Verify the HMAC signature sent by the codex-remediation workflow when
 * it reports PR state back to Mission Control. Same shape as the Codex
 * webhook: `sha256=<hex>` (or bare hex) over the raw body using the
 * `CODEX_REMEDIATION_WEBHOOK_SECRET`.
 */
export async function verifyRemediationSignature(
  rawBody: string,
  signatureHeader: string | null,
  extraSecrets: (string | null | undefined)[] = [],
): Promise<boolean> {
  // Delegates to the shared constant-time verifier, but with the
  // remediation key set only — the scan webhook's secret must not be able
  // to forge remediation callbacks.
  const { verifyHmacSignature } = await import("@/server/codex-security-client.server");
  return verifyHmacSignature(rawBody, signatureHeader, [
    process.env.CODEX_REMEDIATION_WEBHOOK_SECRET,
    ...extraSecrets,
  ]);
}

/**
 * Merge a Codex remediation PR via the GitHub App installation. Uses a
 * squash-merge by default so the branch history stays clean. Returns the
 * merge commit SHA on success.
 */
export async function mergeRemediationPRViaGitHub(input: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: string | null;
  commitTitle?: string;
  commitMessage?: string;
  method?: "squash" | "merge" | "rebase";
}): Promise<{ sha: string; merged: boolean }> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  const res = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    merge_method: input.method || "squash",
    commit_title: input.commitTitle,
    commit_message: input.commitMessage,
  });
  return { sha: (res.data as any).sha, merged: (res.data as any).merged };
}
