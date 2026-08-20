// Server-only helpers for dispatching a Codex Security remediation PR
// workflow. Uses the Aurixa GitHub App to trigger a `workflow_dispatch`
// event on the target repository (Prime or a clone). The workflow itself
// lives in the target repo at `.github/workflows/codex-remediation.yml`
// and is responsible for producing the draft PR and calling the
// remediation callback with the resulting PR URL / state.
//
// Engine: the patch is authored by the OpenAI Codex CLI (`@openai/codex`)
// running inside the target repo's GitHub Actions runner with
// `--sandbox workspace-write`. It edits real files in a checkout of
// `base_ref`; the workflow then verifies the patched tree against the
// repo's own checks, commits, and opens a DRAFT pull request. Mission
// Control never writes code itself and never merges without human review.

import { getAppOctokit } from "@/server/github-app.server";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

export const REMEDIATION_ENGINE = "codex_cli";

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
    /** Offending source excerpt, when the scanner captured one. */
    snippet?: string | null;
    scanner?: string | null;
    ruleId?: string | null;
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
 * Serialise a finding into the workflow's single `finding` input.
 *
 * Field lengths are clamped here as well as in the workflow: this side keeps
 * the dispatch request inside GitHub's payload limit, and the workflow side
 * cannot trust that a repo received its inputs from this code path.
 *
 * `scanner`, `ruleId` and `snippet` matter to patch quality — a title and a
 * line number alone make for weak fixes. They travel as their own fields
 * rather than being stuffed into `description` so the workflow can clamp and
 * present each one on its own terms.
 */
export function buildFindingInput(finding: DispatchRemediationInput["finding"]): string {
  return JSON.stringify({
    id: finding.id,
    title: (finding.title || "").slice(0, 200),
    severity: finding.severity,
    file: finding.file ?? "",
    line: finding.line == null ? "" : String(finding.line),
    cwe: finding.cwe ?? "",
    description: (finding.description ?? "").slice(0, 4000),
    scanner: finding.scanner ?? "",
    ruleId: finding.ruleId ?? "",
    snippet: (finding.snippet ?? "").slice(0, 2000),
  });
}

/**
 * Trigger the codex-remediation workflow on the target repo.
 *
 * The run id is NOT polled for here: `workflow_dispatch` does not return
 * one, and the previous approach (sleep 1.5s, then take the newest matching
 * run) both added latency to every dispatch and could attribute somebody
 * else's concurrent run to this remediation. The workflow reports its own
 * `GITHUB_RUN_ID` in the `workflow.started` callback instead.
 */
export async function dispatchRemediationWorkflow(
  input: DispatchRemediationInput,
): Promise<DispatchRemediationResult> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  const workflowFile = input.workflowFile || "codex-remediation.yml";

  const inputs = {
    remediation_id: input.remediationId,
    // One JSON field rather than seven flat finding_* inputs: GitHub caps
    // workflow_dispatch at 10 inputs and rejects the entire workflow file
    // past that, so the flat form could never be dispatched at all. The
    // workflow parses this with node and never lets the text reach a shell.
    finding: buildFindingInput(input.finding),
    base_ref: input.baseRef,
    branch_name: input.branchName,
    callback_url: input.callbackUrl,
    callback_secret: input.callbackSecret,
  } as Record<string, string>;

  try {
    await withRetry(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: input.owner,
          repo: input.repo,
          workflow_id: workflowFile,
          ref: input.baseRef,
          inputs,
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
  } catch (err) {
    throw new Error(
      describeRemediationDispatchError(err, input.owner, input.repo, workflowFile, input.baseRef),
    );
  }

  return { workflowRunId: null, workflowRunUrl: null };
}

/**
 * GitHub answers a missing workflow file, a missing branch, and a missing
 * permission all with "Not Found". Say which one it probably is.
 */
function describeRemediationDispatchError(
  err: unknown,
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
): string {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  if (status === 404) {
    return (
      `GitHub returned 404 dispatching ${workflowFile} on ${target}@${ref}. ` +
      `Check that .github/workflows/${workflowFile} exists on branch "${ref}", that the ` +
      `branch exists, and that the Aurixa GitHub App is installed on ${target} with ` +
      `Actions: read & write.`
    );
  }
  if (status === 403) {
    return (
      `GitHub returned 403 dispatching ${workflowFile} on ${target}. The App installation ` +
      `is missing Actions: read & write (re-accept its permissions). Detail: ${message}`
    );
  }
  if (status === 422) {
    return (
      `GitHub rejected the dispatch inputs for ${workflowFile} on ${target}@${ref}: ${message}. ` +
      `The workflow file in the target repo is probably an older revision whose ` +
      `workflow_dispatch inputs no longer match — re-sync the workflow template.`
    );
  }
  return `Remediation dispatch failed for ${target}@${ref}${status ? ` [${status}]` : ""}: ${message}`;
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
 * Take a draft PR out of draft state.
 *
 * Remediation PRs are opened as drafts on purpose, but GitHub refuses to
 * merge a draft ("Draft pull requests cannot be merged", 405) and the REST
 * API has no endpoint to clear the flag — only the GraphQL
 * `markPullRequestReadyForReview` mutation can. Without this step the
 * two-key merge gate could be fully satisfied and merging would still
 * always fail.
 */
export async function markPullRequestReady(input: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: string | null;
}): Promise<{ wasDraft: boolean }> {
  const octokit = getAppOctokit(input.installationId ?? undefined);

  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });

  if (!pr?.draft) return { wasDraft: false };

  await octokit.graphql(
    `mutation($id: ID!) {
       markPullRequestReadyForReview(input: { pullRequestId: $id }) {
         pullRequest { isDraft }
       }
     }`,
    { id: pr.node_id },
  );

  return { wasDraft: true };
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
}): Promise<{ sha: string; merged: boolean; wasDraft: boolean }> {
  const octokit = getAppOctokit(input.installationId ?? undefined);

  // Clear the draft flag first — see markPullRequestReady.
  const { wasDraft } = await markPullRequestReady({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    installationId: input.installationId,
  });

  const res = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    merge_method: input.method || "squash",
    commit_title: input.commitTitle,
    commit_message: input.commitMessage,
  });

  return {
    sha: (res.data as any).sha,
    merged: (res.data as any).merged,
    wasDraft,
  };
}
