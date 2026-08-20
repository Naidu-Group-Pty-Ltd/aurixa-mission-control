/**
 * Reading a Vercel webhook, and the one thing it is allowed to change.
 *
 * The drain polls a deployment only while the row is in `deploying`. The moment
 * a clone reaches `live` the polling stops — correctly, because polling every
 * live clone forever is how a fleet burns its rate limit on nothing. But it
 * leaves a real blind spot: the NEXT build, triggered by a cascade or by a push,
 * can fail and nothing here ever learns. The row keeps saying `live`, which is
 * true, while the code an operator believes is deployed is not.
 *
 * Two facts, and the reason this module exists is that they are different:
 *
 *   - **Is the clone serving?** Yes. Vercel keeps the last good production
 *     deployment in place when a build fails. Nothing went down.
 *   - **Is what is serving what we last pushed?** No.
 *
 * A single `status` cannot carry both, and overloading it would make a failed
 * build look like an outage — which sends whoever is paged to the wrong problem.
 * So `status` stays the deployment LIFECYCLE and build health is its own set of
 * columns, and this module decides what to write into them.
 */

export type VercelBuildState = "queued" | "building" | "ready" | "error" | "canceled";

export type WebhookReading =
  | { kind: "ignored"; reason: IgnoreReason }
  | {
      kind: "build";
      projectId: string;
      deploymentId: string | null;
      state: VercelBuildState;
      target: string;
      url: string | null;
      errorMessage: string | null;
    };

export type IgnoreReason = "unparseable" | "unhandled_type" | "no_project" | "not_production";

const TYPE_TO_STATE: Record<string, VercelBuildState> = {
  "deployment.created": "queued",
  "deployment.succeeded": "ready",
  "deployment.ready": "ready",
  "deployment.promoted": "ready",
  "deployment.error": "error",
  "deployment.canceled": "canceled",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Classify one webhook body.
 *
 * Every ignore path returns a REASON rather than null. A webhook receiver that
 * cannot say why it did nothing is one nobody can debug, and Vercel retries a
 * non-2xx — so "ignored, and here is why" has to be a 200 with a recorded
 * reason, not a silent drop and not an error.
 */
export function readVercelWebhook(body: unknown): WebhookReading {
  if (!body || typeof body !== "object") return { kind: "ignored", reason: "unparseable" };
  const event = body as Record<string, unknown>;

  const type = str(event.type);
  if (!type || !(type in TYPE_TO_STATE)) {
    return { kind: "ignored", reason: "unhandled_type" };
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const deployment = (payload.deployment ?? {}) as Record<string, unknown>;
  const project = (payload.project ?? {}) as Record<string, unknown>;

  const projectId = str(project.id) ?? str(payload.projectId) ?? str(deployment.projectId);
  if (!projectId) return { kind: "ignored", reason: "no_project" };

  // Only production. A failing PREVIEW build is a pull request that will not
  // merge, not a clone whose live site is stale — and treating the two the same
  // would alarm on every branch a developer pushes.
  //
  // Vercel omits `target` on some event shapes; when it is absent the deployment
  // object carries it. An event with neither is not evidence of production.
  const target = str(payload.target) ?? str(deployment.target) ?? str(payload.deploymentTarget);
  if (target !== "production") return { kind: "ignored", reason: "not_production" };

  return {
    kind: "build",
    projectId,
    deploymentId: str(deployment.id) ?? str(payload.deploymentId),
    state: TYPE_TO_STATE[type],
    target,
    url: str(deployment.url),
    errorMessage:
      str((payload.error as Record<string, unknown> | undefined)?.message) ??
      str(payload.errorMessage),
  };
}

/**
 * Whether a build reading should also change the row's LIFECYCLE status.
 *
 * Almost always: no. The webhook's job is to record build health beside a status
 * the drain owns, and a webhook that rewrote `status` would race the worker —
 * two writers on one column, arriving out of order, is how a row ends up
 * advertising a state neither of them decided.
 *
 * The single exception is a row the drain has parked at `deploying` waiting on a
 * build that has now finished: telling it the answer early saves a poll and, on
 * a failure, saves five.
 */
export function lifecyclePatchFor(input: {
  currentStatus: string | null | undefined;
  trackedDeploymentId: string | null | undefined;
  state: VercelBuildState;
  deploymentId: string | null;
}): { status: string; detail: string } | null {
  if (input.currentStatus !== "deploying") return null;
  // Only about the build the drain is actually watching. A concurrent build of
  // some other commit finishing first must not decide this row's fate.
  if (!input.deploymentId || input.deploymentId !== input.trackedDeploymentId) return null;

  if (input.state === "ready") {
    return { status: "attaching_domain", detail: "Build reported ready by webhook." };
  }
  if (input.state === "error" || input.state === "canceled") {
    return { status: "failed", detail: `Build ${input.state} (reported by webhook).` };
  }
  return null;
}
