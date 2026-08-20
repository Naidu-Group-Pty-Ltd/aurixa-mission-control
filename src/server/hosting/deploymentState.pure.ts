/**
 * The deployment lifecycle, and the three readings a badge has to keep apart.
 *
 * A clone with no deployment requested, a clone whose build is in flight, and a
 * clone whose build broke are three different facts. Collapsing them is the
 * failure `cron_delivery_health.delivered` is three-valued to avoid, and the one
 * `CaseRead` in the property dashboard carries `failed` separately from `row`
 * for: a read that FAILED is not a row that is ABSENT.
 *
 * So `reading()` returns four values and nothing here can paraphrase
 * `not_requested` into `failed` — a test asserts the two vocabularies share no
 * value.
 */

export const DEPLOYMENT_STATUSES = [
  "not_requested",
  "pending_platform",
  "pending",
  "creating_project",
  "linking_repo",
  "syncing_env",
  "deploying",
  "attaching_domain",
  "verifying_domain",
  "live",
  "failed",
  "detached",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * The order the worker advances through. Each entry names the state it is IN
 * and the state it moves to on success. The worker takes ONE step per pass and
 * persists — every step is a call to a rate-limited API, and a worker that tries
 * to run a clone end-to-end inside one invocation is a worker that loses its
 * progress when the Cloudflare Worker request is terminated. That is the same
 * lesson the provisioning cascade learned when a `void (async () => …)` was
 * killed mid-flight and left a fresh repo without its module files.
 */
export const ADVANCE: Partial<Record<DeploymentStatus, DeploymentStatus>> = {
  pending: "creating_project",
  creating_project: "linking_repo",
  linking_repo: "syncing_env",
  syncing_env: "deploying",
  deploying: "attaching_domain",
  attaching_domain: "verifying_domain",
  verifying_domain: "live",
};

/** States the drain should claim. Terminal and dormant states are excluded. */
export const CLAIMABLE: DeploymentStatus[] = [
  "pending",
  "creating_project",
  "linking_repo",
  "syncing_env",
  "deploying",
  "attaching_domain",
  "verifying_domain",
];

export function isTerminal(status: DeploymentStatus): boolean {
  return status === "live" || status === "failed" || status === "detached";
}

/**
 * `not_requested` and `pending_platform` are NOT terminal in the sense above —
 * they are dormant. A dormant row resumes the moment the platform is configured
 * or the operator asks for it; a terminal row does not resume on its own.
 */
export function isDormant(status: DeploymentStatus): boolean {
  return status === "not_requested" || status === "pending_platform";
}

/**
 * The four readings. `tone` maps onto the design system's status colours, and
 * `neutral` is what carries the point: nobody asked for a deployment here, so
 * there is nothing wrong.
 */
export type DeploymentReading = {
  reading: "absent" | "waiting" | "working" | "live" | "broken";
  label: string;
  detail: string;
  tone: "neutral" | "warning" | "destructive" | "success" | "primary";
};

export function reading(
  status: DeploymentStatus | null | undefined,
  opts?: { providerConfigured?: boolean },
): DeploymentReading {
  if (!status) {
    return {
      reading: "absent",
      label: "no deployment",
      detail: "This clone has never had a deployment requested.",
      tone: "neutral",
    };
  }
  switch (status) {
    case "not_requested":
      return {
        reading: "absent",
        label: "not requested",
        detail: "Deployment was declined for this clone. It is not a failure.",
        tone: "neutral",
      };
    case "pending_platform":
      return {
        reading: "waiting",
        label: "awaiting platform",
        detail: opts?.providerConfigured
          ? "Queued — the reconcile action will fan this out."
          : "No hosting provider token is configured. Nothing has been attempted.",
        tone: "warning",
      };
    case "failed":
      return {
        reading: "broken",
        label: "failed",
        detail: "The last attempt failed and will not retry without an operator.",
        tone: "destructive",
      };
    case "detached":
      return {
        reading: "absent",
        label: "detached",
        detail: "The project was detached. Nothing is being served from here.",
        tone: "neutral",
      };
    case "live":
      return {
        reading: "live",
        label: "live",
        detail: "The domain resolves to this project and the origin is recorded.",
        tone: "success",
      };
    default:
      return {
        reading: "working",
        label: status.replaceAll("_", " "),
        detail: "In progress. The worker advances one step a minute.",
        tone: "primary",
      };
  }
}

/**
 * Exponential backoff, capped at an hour — the same curve `edge-drain` uses, so
 * two workers draining two queues do not need two answers to the same question.
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(3600, Math.round(Math.pow(2, Math.max(0, attempts)) * 15));
}

/**
 * Whether a failure should be retried at all.
 *
 * A 4xx that is not 429 means the request was wrong, and repeating it wastes
 * five attempts to arrive at the same answer an hour later. `edge-drain` retries
 * everything to `max_attempts`, which is why a job with a malformed payload sits
 * in `retry` for over an hour before admitting it.
 */
export function isRetryable(err: { status?: number } | null | undefined): boolean {
  const status = err?.status;
  if (typeof status !== "number") return true; // network / unknown: worth another go
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}
