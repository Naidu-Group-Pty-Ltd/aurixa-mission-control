// @ts-nocheck
// Server-only helper for enqueueing Codex Security scans WITHOUT a user
// context (used by pg_cron nightly job and by the GitHub webhook receiver).
//
// Insert-then-dispatch mirrors `enqueueScan` in
// src/lib/codex-security.functions.ts, but skips the RLS/auth gate because
// it runs behind a shared cron/webhook secret.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueCodexScan } from "@/server/codex-security-client.server";

const admin = supabaseAdmin as any;

export type EnqueueOpts = {
  kind:
    | "manual"
    | "nightly_full"
    | "pr_open"
    | "targeted_path"
    | "post_merge_revalidate";
  targetKind: "prime" | "clone";
  cloneId?: string | null;
  repoFullName: string;
  ref?: string | null;
  pathGlobs?: string[] | null;
  requestPayload?: Record<string, unknown>;
  dedupWindowHours?: number;
};

/**
 * Skip if the same target already has a completed/running scan of the same
 * kind within the dedup window. Prevents webhook floods (rapid PR pushes)
 * and cron overlap from stacking duplicate scans.
 */
async function recentDuplicate(opts: EnqueueOpts): Promise<boolean> {
  const window = opts.dedupWindowHours ?? 0;
  if (window <= 0) return false;
  const since = new Date(Date.now() - window * 60 * 60 * 1000).toISOString();
  const query = admin
    .from("codex_scan_jobs")
    .select("id, status, ref")
    .eq("target_kind", opts.targetKind)
    .eq("kind", opts.kind)
    .eq("repo_full_name", opts.repoFullName)
    .gte("created_at", since)
    .in("status", ["queued", "running", "completed"])
    .limit(1);
  if (opts.cloneId) query.eq("clone_id", opts.cloneId);
  else query.is("clone_id", null);
  if (opts.ref) query.eq("ref", opts.ref);
  const { data } = await query;
  return !!data?.length;
}

export async function enqueueScanNoAuth(
  opts: EnqueueOpts,
): Promise<
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }
> {
  if (!opts.repoFullName) return { skipped: true, reason: "missing_repo" };
  if (await recentDuplicate(opts)) {
    return { skipped: true, reason: "duplicate_within_window" };
  }

  const { data: job, error } = await admin
    .from("codex_scan_jobs")
    .insert({
      kind: opts.kind,
      target_kind: opts.targetKind,
      clone_id: opts.cloneId ?? null,
      repo_full_name: opts.repoFullName,
      ref: opts.ref ?? null,
      path_globs: opts.pathGlobs ?? null,
      requested_by: null,
      request_payload: opts.requestPayload ?? { source: opts.kind },
    })
    .select()
    .single();
  if (error) throw error;

  // Fire dispatch async — the response returns quickly; failures are
  // recorded to codex_scan_events so operators can retry.
  (async () => {
    try {
      const origin =
        process.env.APP_PUBLIC_URL || "https://mission-control.aurixasystems.com.au";
      const callbackSecret = process.env.CODEX_SECURITY_WEBHOOK_SECRET || "";
      const res = await enqueueCodexScan({
        jobId: job.id,
        repoFullName: opts.repoFullName,
        ref: opts.ref ?? null,
        pathGlobs: opts.pathGlobs ?? null,
        kind: opts.kind,
        callbackUrl: `${origin}/api/public/hooks/codex-security`,
        callbackSecret,
      });
      await admin
        .from("codex_scan_jobs")
        .update({
          external_scan_id: res.externalScanId,
          status: "running",
          started_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      await admin.from("codex_scan_events").insert({
        job_id: job.id,
        event_type: "dispatched",
        payload: { externalScanId: res.externalScanId, kind: opts.kind },
      });
    } catch (err) {
      await admin
        .from("codex_scan_jobs")
        .update({
          status: "failed",
          failure_count: 1,
          last_error: (err as Error).message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      await admin.from("codex_scan_events").insert({
        job_id: job.id,
        event_type: "dispatch_failed",
        payload: { error: (err as Error).message, kind: opts.kind },
      });
    }
  })();

  return { skipped: false, jobId: job.id };
}

export type NightlyResult = {
  enqueued: Array<{ target: string; jobId: string; kind: string }>;
  skipped: Array<{ target: string; reason: string }>;
};

/**
 * Enqueue nightly scans across Prime + every clone that has:
 *   - codex_nightly_enabled = true
 *   - a valid repo_full_name
 * Prime scan is skipped when prime_config.codex_nightly_enabled is false.
 */
export async function runNightlyScans(): Promise<NightlyResult> {
  const enqueued: NightlyResult["enqueued"] = [];
  const skipped: NightlyResult["skipped"] = [];

  const { data: prime } = await admin
    .from("prime_config")
    .select("github_owner, github_repo, default_branch, codex_nightly_enabled, codex_scan_dedup_hours")
    .limit(1)
    .maybeSingle();

  const dedupHours = prime?.codex_scan_dedup_hours ?? 6;

  if (prime && prime.codex_nightly_enabled) {
    const repo = `${prime.github_owner}/${prime.github_repo}`;
    try {
      const r = await enqueueScanNoAuth({
        kind: "nightly_full",
        targetKind: "prime",
        repoFullName: repo,
        ref: prime.default_branch || "main",
        dedupWindowHours: dedupHours,
        requestPayload: { source: "nightly" },
      });
      if (r.skipped) skipped.push({ target: `prime:${repo}`, reason: r.reason });
      else enqueued.push({ target: `prime:${repo}`, jobId: r.jobId, kind: "nightly_full" });
    } catch (err) {
      skipped.push({ target: `prime:${repo}`, reason: (err as Error).message });
    }
  } else if (prime) {
    skipped.push({ target: "prime", reason: "nightly_disabled" });
  }

  const { data: clones } = await admin
    .from("clones")
    .select("id, name, repo_full_name, github_owner, github_repo, default_branch, codex_nightly_enabled")
    .eq("codex_nightly_enabled", true);

  for (const c of clones ?? []) {
    const repo = c.repo_full_name || (c.github_owner && c.github_repo ? `${c.github_owner}/${c.github_repo}` : "");
    if (!repo) {
      skipped.push({ target: `clone:${c.name ?? c.id}`, reason: "no_repo" });
      continue;
    }
    try {
      const r = await enqueueScanNoAuth({
        kind: "nightly_full",
        targetKind: "clone",
        cloneId: c.id,
        repoFullName: repo,
        ref: c.default_branch || "main",
        dedupWindowHours: dedupHours,
        requestPayload: { source: "nightly", cloneId: c.id },
      });
      if (r.skipped) skipped.push({ target: `clone:${c.name ?? c.id}`, reason: r.reason });
      else enqueued.push({ target: `clone:${c.name ?? c.id}`, jobId: r.jobId, kind: "nightly_full" });
    } catch (err) {
      skipped.push({ target: `clone:${c.name ?? c.id}`, reason: (err as Error).message });
    }
  }

  return { enqueued, skipped };
}

/**
 * Resolve a repo full-name to (targetKind, cloneId) so webhook-driven scans
 * are stored against the right owner. Returns null if the repo is not Prime
 * and not a known clone (webhook still verified, just nothing to do).
 */
export async function resolveScanTarget(
  repoFullName: string,
): Promise<{ targetKind: "prime" | "clone"; cloneId?: string } | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  const { data: prime } = await admin
    .from("prime_config")
    .select("github_owner, github_repo")
    .limit(1)
    .maybeSingle();
  if (
    prime &&
    prime.github_owner?.toLowerCase() === owner.toLowerCase() &&
    prime.github_repo?.toLowerCase() === repo.toLowerCase()
  ) {
    return { targetKind: "prime" };
  }

  const { data: clone } = await admin
    .from("clones")
    .select("id")
    .or(`repo_full_name.eq.${repoFullName},and(github_owner.eq.${owner},github_repo.eq.${repo})`)
    .limit(1)
    .maybeSingle();
  if (clone?.id) return { targetKind: "clone", cloneId: clone.id };
  return null;
}
