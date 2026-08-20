/**
 * Asking for a rebuild after code lands in a clone's repository.
 *
 * The decision is `decideRedeploy`; this is the write. Two things about it are
 * deliberate.
 *
 * It never throws. The caller is the cascade engine, mid-loop over every clone
 * in scope, and a cascade that pushed code correctly must not be reported as
 * failed because a hosting row could not be updated. The failure is recorded in
 * `deployment_events` instead, where it belongs.
 *
 * It never creates a row. `upsert` here would enrol every clone a cascade
 * touches into hosting — see the policy module.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideRedeploy, type RedeploySkipReason } from "./redeployPolicy.pure";
import type { DeploymentStatus } from "./deploymentState.pure";

const admin = supabaseAdmin as any;

export type RedeployRequest =
  | { queued: true; resumedAt: "pending" | "deploying"; from: DeploymentStatus }
  | { queued: false; reason: RedeploySkipReason | "db_error" };

export async function requestRedeployAfterPush(input: {
  cloneId: string;
  /** Free text for the audit trail — "cascade #123", "module sync", … */
  reason: string;
  sha?: string | null;
}): Promise<RedeployRequest> {
  const { data: row, error: readErr } = await admin
    .from("clone_deployments")
    .select("clone_id, status, project_id, provider_slug")
    .eq("clone_id", input.cloneId)
    .maybeSingle();

  // A read that FAILED is not a row that is ABSENT. Treating an error as "no
  // deployment" would silently stop rebuilding the whole fleet the moment the
  // table became briefly unreadable, and nothing would report it.
  if (readErr) return { queued: false, reason: "db_error" };
  if (!row) return { queued: false, reason: "no_deployment_row" };

  const decision = decideRedeploy({
    status: row.status as DeploymentStatus,
    hasProject: Boolean(row.project_id),
  });
  if (!decision.act) return { queued: false, reason: decision.reason };

  const patch: Record<string, unknown> = {
    status: decision.resumeAt,
    attempts: 0,
    error_message: null,
    status_detail: `Rebuild requested — ${input.reason}.`,
    next_attempt_at: new Date().toISOString(),
    worker_started_at: null,
    worker_finished_at: null,
  };
  // Cleared so the drain creates a NEW build instead of polling the finished one
  // and concluding it is already ready.
  if (decision.clearDeploymentId) patch.latest_deployment_id = null;

  const { error } = await admin
    .from("clone_deployments")
    .update(patch)
    .eq("clone_id", input.cloneId);

  await admin.from("deployment_events").insert({
    clone_id: input.cloneId,
    provider_slug: row.provider_slug ?? "vercel",
    action: "request_redeploy",
    from_status: row.status,
    to_status: error ? null : decision.resumeAt,
    success: !error,
    error_message: error?.message ?? null,
    // `payload`, not `detail`. `deployment_events` has no `detail` column, and
    // PostgREST answers 42703 for the WHOLE insert when a name is wrong — so a
    // mistyped column here would lose every redeploy audit row, silently,
    // because this insert's error is deliberately not fatal.
    payload: { reason: input.reason, sha: input.sha ?? null },
  });

  if (error) return { queued: false, reason: "db_error" };
  return { queued: true, resumedAt: decision.resumeAt, from: row.status as DeploymentStatus };
}
