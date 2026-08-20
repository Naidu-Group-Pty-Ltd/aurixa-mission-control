/**
 * Whether a push into a clone's repository should rebuild it, and from where.
 *
 * Vercel rebuilds on push only when its GitHub App is installed on the
 * repository — which Mission Control cannot assume, because it forks clones
 * through its OWN GitHub App and never asks Vercel to install anything. So on a
 * fleet where the Vercel app is absent, a cascade merges code into forty
 * repositories and forty live sites keep serving the previous build, silently
 * and indefinitely. Mission Control has to ask for the rebuild itself.
 *
 * Asking unconditionally is worse than not asking. A cascade touches every clone
 * in scope, including ones nobody asked to host, ones an operator deliberately
 * declined, and ones already mid-pipeline — and "rebuild everything on every
 * push" is how a fleet-wide cascade turns into forty concurrent builds against a
 * rate-limited team API.
 *
 * So this module decides, and it is pure so the decision can be tested against
 * every state rather than against the two that happen to occur in a dev fleet.
 */

import type { DeploymentStatus } from "./deploymentState.pure";

export type RedeployDecision =
  | { act: false; reason: RedeploySkipReason }
  | { act: true; resumeAt: "pending" | "deploying"; clearDeploymentId: boolean };

export type RedeploySkipReason =
  | "no_deployment_row"
  | "declined"
  | "detached"
  | "provider_unconfigured"
  | "already_pending_earlier_step";

/**
 * `status` is the clone's current deployment state; `hasProject` says whether a
 * provider project already exists for it.
 */
export function decideRedeploy(input: {
  status: DeploymentStatus | null | undefined;
  hasProject: boolean;
}): RedeployDecision {
  const status = input.status;

  // No row at all. A cascade must never ENROL a clone into hosting — that is a
  // decision an operator makes in the wizard or on the clone page, and inferring
  // it from "somebody pushed code" would quietly start billing for a project
  // nobody asked for.
  if (!status) return { act: false, reason: "no_deployment_row" };

  switch (status) {
    // Someone said no. A push is not a change of mind.
    case "not_requested":
      return { act: false, reason: "declined" };

    // Deliberately torn down. Rebuilding would resurrect a site that was
    // switched off, which is the one failure mode worse than not rebuilding.
    case "detached":
      return { act: false, reason: "detached" };

    // Dormant for want of a token. `reconcilePendingDeployments` is the way out
    // of this state, and it is an operator action on purpose.
    case "pending_platform":
      return { act: false, reason: "provider_unconfigured" };

    // Already queued at, or before, the build step. The pipeline will reach
    // `deploying` on its own and build whatever HEAD is by then, so re-queueing
    // achieves nothing and restarting from `pending` would re-run project
    // creation and env sync for no reason.
    case "pending":
    case "creating_project":
    case "linking_repo":
    case "syncing_env":
      return { act: false, reason: "already_pending_earlier_step" };

    // A build is in flight — from the commit BEFORE this push. Letting it finish
    // marks the clone live on stale code, and the request that prompted this is
    // never satisfied. Clearing the tracked deployment id makes the drain create
    // a fresh build from current HEAD; the abandoned build costs some build
    // minutes and nothing else.
    case "deploying":
      return { act: true, resumeAt: "deploying", clearDeploymentId: true };

    // Past the build and working on the domain. The domain work is about the
    // NAME, not the code, so it would finish and leave the old build serving.
    // Rewind to the build; the domain steps are idempotent and re-run cheaply.
    case "attaching_domain":
    case "verifying_domain":
      return { act: true, resumeAt: "deploying", clearDeploymentId: true };

    // The ordinary case: a live clone gets new code.
    case "live":
      return { act: true, resumeAt: "deploying", clearDeploymentId: true };

    // A previous attempt failed. The commit that just landed is the most likely
    // thing to have fixed it, so this is worth retrying — but only from a step
    // that makes sense: with no project, `deploying` fails instantly on a null
    // project_id and spends an attempt saying so.
    case "failed":
      return {
        act: true,
        resumeAt: input.hasProject ? "deploying" : "pending",
        clearDeploymentId: true,
      };

    default:
      return { act: false, reason: "no_deployment_row" };
  }
}
