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

  await octokit.request(
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    {
      owner: input.owner,
      repo: input.repo,
      workflow_id: workflowFile,
      ref: input.baseRef,
      inputs,
    },
  );

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
): Promise<boolean> {
  const secret = process.env.CODEX_REMEDIATION_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;
  if (provided.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++)
    diff |= hex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
