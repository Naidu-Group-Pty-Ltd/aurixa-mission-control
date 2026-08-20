// @ts-nocheck — 3 unresolved type errors (argument types ×2, assignability ×1).
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Server-only orchestration for Codex Security scans without a user context
// (pg_cron nightly job, the GitHub webhook receiver, and the sweeper).
//
// This is the single insert-then-dispatch path for the whole feature; the
// authenticated `enqueueScan` server fn in src/lib/codex-security.functions.ts
// delegates here after its admin check rather than keeping a parallel copy
// that could drift.
//
// Dispatch is AWAITED, not fire-and-forget. The previous implementation
// kicked off a floating `(async () => {...})()` and returned immediately;
// on Cloudflare Workers the isolate can be reclaimed as soon as the response
// is written, so jobs were routinely left stranded at `queued` with no event
// row at all — a large part of why the pipeline looked dead.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  dispatchCodexScan,
  resolveScanEngine,
  scanCallbackUrl,
} from "@/server/codex-security-client.server";

const admin = supabaseAdmin;

export type ScanKind =
  | "manual"
  | "nightly_full"
  | "pr_open"
  | "targeted_path"
  | "post_merge_revalidate";

export type EnqueueOpts = {
  kind: ScanKind;
  targetKind: "prime" | "clone";
  cloneId?: string | null;
  repoFullName: string;
  ref?: string | null;
  pathGlobs?: string[] | null;
  requestPayload?: Record<string, unknown>;
  dedupWindowHours?: number;
  requestedBy?: string | null;
  /** Only scan files changed against this ref (PR scans). */
  diffBase?: string | null;
  /** Opt out of the Codex CLI reasoning pass for cheap/fast scans. */
  deepScan?: boolean;
};

export type EnqueueResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      jobId: string;
      engine: string;
      /** Set when the first dispatch attempt failed and a retry is pending. */
      dispatchError?: string;
    };

/** How long a dispatched scan may run before the sweeper gives up on it. */
const RUNNING_TIMEOUT_MINUTES = 75;
/** How long a job may sit undispatched before the sweeper retries it. */
const QUEUED_STALL_MINUTES = 10;
/** Dispatch attempts (initial + sweeper retries) before a job is failed. */
const MAX_DISPATCH_ATTEMPTS = 3;
/** Parallel dispatches during a fleet-wide nightly run. */
const NIGHTLY_CONCURRENCY = 5;

/**
 * HMAC secret shared with the scanner. Prefers the deployment env var, then
 * falls back to the auto-generated secret on the built-in `codex` intake
 * source — so a fresh deployment authenticates its own scanners with no
 * manual secret provisioning at all.
 */
export async function resolveScanWebhookSecret(): Promise<string> {
  const fromEnv = process.env.CODEX_SECURITY_WEBHOOK_SECRET;
  if (fromEnv) return fromEnv;
  try {
    const { data } = await admin
      .from("security_intake_sources")
      .select("hmac_secret")
      .eq("slug", "codex")
      .maybeSingle();
    return data?.hmac_secret || "";
  } catch {
    return "";
  }
}

/**
 * HMAC secret shared with the remediation workflow. Same fallback chain as
 * the scan secret so the two halves of the pipeline can never disagree about
 * which key is in play.
 */
export async function resolveRemediationWebhookSecret(): Promise<string> {
  const fromEnv = process.env.CODEX_REMEDIATION_WEBHOOK_SECRET;
  if (fromEnv) return fromEnv;
  return resolveScanWebhookSecret();
}

async function recordEvent(
  jobId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  try {
    await admin.from("codex_scan_events").insert({ job_id: jobId, event_type: eventType, payload });
  } catch {
    // The event log is an audit convenience — never let it break a scan.
  }
}

/**
 * Skip if the same target already has a queued/running/completed scan of the
 * same kind within the dedup window. Prevents webhook floods (rapid PR
 * pushes) and cron overlap from stacking duplicate scans.
 */
async function recentDuplicate(opts: EnqueueOpts): Promise<boolean> {
  const window = opts.dedupWindowHours ?? 0;
  if (window <= 0) return false;
  const since = new Date(Date.now() - window * 60 * 60 * 1000).toISOString();
  const query = admin
    .from("codex_scan_jobs")
    .select("id")
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

export type DispatchTarget = {
  owner: string;
  repo: string;
  installationId: string | null;
  defaultBranch: string;
};

/**
 * Resolve the GitHub coordinates a scan must be dispatched against. The
 * workflow lives on a branch, so `defaultBranch` is what we dispatch on even
 * when the scan itself targets a PR head SHA.
 */
export async function resolveDispatchTarget(opts: {
  targetKind: "prime" | "clone";
  cloneId?: string | null;
  repoFullName: string;
}): Promise<DispatchTarget> {
  const [fallbackOwner, fallbackRepo] = (opts.repoFullName || "").split("/");

  if (opts.targetKind === "prime") {
    const { data: p } = await admin
      .from("prime_config")
      .select("github_owner, github_repo, default_branch, github_app_installation_id")
      .limit(1)
      .maybeSingle();
    return {
      owner: p?.github_owner || fallbackOwner || "",
      repo: p?.github_repo || fallbackRepo || "",
      installationId: p?.github_app_installation_id ?? null,
      defaultBranch: p?.default_branch || "main",
    };
  }

  if (!opts.cloneId) {
    return {
      owner: fallbackOwner || "",
      repo: fallbackRepo || "",
      installationId: null,
      defaultBranch: "main",
    };
  }

  // The installation id is fetched separately: it is an optional column, and
  // naming an unknown column fails the entire PostgREST select, which would
  // take owner/repo/branch down with it.
  const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
  const [{ data: c }, installationId] = await Promise.all([
    admin
      .from("clones")
      .select("github_owner, github_repo, default_branch")
      .eq("id", opts.cloneId)
      .maybeSingle(),
    loadCloneInstallationId(admin, opts.cloneId),
  ]);
  return {
    owner: c?.github_owner || fallbackOwner || "",
    repo: c?.github_repo || fallbackRepo || "",
    installationId,
    defaultBranch: c?.default_branch || "main",
  };
}

/**
 * Send an already-inserted job to the scan engine and record the outcome.
 * Shared by the initial enqueue and by the sweeper's retry path.
 */
async function dispatchJob(job: {
  id: string;
  kind: ScanKind;
  target_kind: "prime" | "clone";
  clone_id: string | null;
  repo_full_name: string;
  ref: string | null;
  path_globs: string[] | null;
  failure_count?: number | null;
  request_payload?: Record<string, unknown> | null;
}): Promise<{ ok: true } | { ok: false; error: string; terminal: boolean }> {
  const attempt = (job.failure_count ?? 0) + 1;
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;

  try {
    const target = await resolveDispatchTarget({
      targetKind: job.target_kind,
      cloneId: job.clone_id,
      repoFullName: job.repo_full_name,
    });

    const res = await dispatchCodexScan({
      jobId: job.id,
      repoFullName: job.repo_full_name,
      ref: job.ref ?? null,
      pathGlobs: job.path_globs ?? null,
      kind: job.kind,
      callbackUrl: scanCallbackUrl(),
      callbackSecret: await resolveScanWebhookSecret(),
      owner: target.owner,
      repo: target.repo,
      installationId: target.installationId,
      dispatchRef: target.defaultBranch,
      diffBase: (payload.diffBase as string) ?? null,
      deepScan: payload.deepScan !== false,
      metadata: payload,
    });

    await admin
      .from("codex_scan_jobs")
      .update({
        external_scan_id: res.externalScanId,
        status: "running",
        started_at: new Date().toISOString(),
        next_attempt_at: null,
        last_error: null,
      })
      .eq("id", job.id);

    await recordEvent(job.id, "dispatched", {
      engine: res.engine,
      externalScanId: res.externalScanId,
      kind: job.kind,
      attempt,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const terminal = attempt >= MAX_DISPATCH_ATTEMPTS;

    await admin
      .from("codex_scan_jobs")
      .update({
        status: terminal ? "failed" : "queued",
        failure_count: attempt,
        last_error: message,
        // Exponential-ish backoff before the sweeper tries again.
        next_attempt_at: terminal
          ? null
          : new Date(Date.now() + attempt * 5 * 60 * 1000).toISOString(),
        completed_at: terminal ? new Date().toISOString() : null,
      })
      .eq("id", job.id);

    await recordEvent(job.id, terminal ? "dispatch_failed" : "dispatch_retry_scheduled", {
      error: message,
      kind: job.kind,
      attempt,
    });
    return { ok: false, error: message, terminal };
  }
}

export async function enqueueScanNoAuth(opts: EnqueueOpts): Promise<EnqueueResult> {
  if (!opts.repoFullName) return { skipped: true, reason: "missing_repo" };
  if (await recentDuplicate(opts)) {
    return { skipped: true, reason: "duplicate_within_window" };
  }

  const requestPayload = {
    source: opts.kind,
    ...(opts.requestPayload ?? {}),
    ...(opts.diffBase ? { diffBase: opts.diffBase } : {}),
    ...(opts.deepScan === false ? { deepScan: false } : {}),
  };

  const { data: job, error } = await admin
    .from("codex_scan_jobs")
    .insert({
      kind: opts.kind,
      target_kind: opts.targetKind,
      clone_id: opts.cloneId ?? null,
      repo_full_name: opts.repoFullName,
      ref: opts.ref ?? null,
      path_globs: opts.pathGlobs ?? null,
      requested_by: opts.requestedBy ?? null,
      request_payload: requestPayload,
      engine: resolveScanEngine(),
    })
    .select(
      "id, kind, target_kind, clone_id, repo_full_name, ref, path_globs, failure_count, request_payload",
    )
    .single();
  if (error) throw error;

  // Awaited on purpose — see the module header.
  const result = await dispatchJob(job);
  if (!result.ok && result.terminal) {
    return { skipped: true, reason: result.error };
  }

  return {
    skipped: false,
    jobId: job.id,
    engine: resolveScanEngine(),
    // Surfaced so an operator clicking "Scan now" learns immediately that
    // the dispatch bounced, rather than watching a job sit at `queued`.
    ...(result.ok ? {} : { dispatchError: result.error }),
  };
}

/** Run `worker` over `items` with a bounded number of in-flight promises. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export type NightlyResult = {
  enqueued: Array<{ target: string; jobId: string; kind: string }>;
  skipped: Array<{ target: string; reason: string }>;
};

/**
 * Enqueue nightly scans across Prime + every clone that has
 * `codex_nightly_enabled = true` and a resolvable repo. Prime is skipped
 * when `prime_config.codex_nightly_enabled` is false.
 */
export async function runNightlyScans(): Promise<NightlyResult> {
  const enqueued: NightlyResult["enqueued"] = [];
  const skipped: NightlyResult["skipped"] = [];

  const { data: prime } = await admin
    .from("prime_config")
    .select(
      "github_owner, github_repo, default_branch, codex_nightly_enabled, codex_scan_dedup_hours",
    )
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

  // owner/repo only — `repo_full_name` is a generated convenience column and
  // naming it here would fail the whole select on an unmigrated deployment,
  // silently yielding an empty fleet.
  const { data: clones } = await admin
    .from("clones")
    .select("id, name, github_owner, github_repo, default_branch, codex_nightly_enabled")
    .eq("codex_nightly_enabled", true);

  // Fan out across the fleet instead of dispatching one clone at a time —
  // a 40-clone fleet used to serialize 40 round-trips to GitHub.
  const outcomes = await mapWithConcurrency(clones ?? [], NIGHTLY_CONCURRENCY, async (c) => {
    const label = `clone:${c.name ?? c.id}`;
    const repo = c.github_owner && c.github_repo ? `${c.github_owner}/${c.github_repo}` : "";
    if (!repo) return { label, skipped: true, reason: "no_repo" } as const;
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
      return r.skipped
        ? ({ label, skipped: true, reason: r.reason } as const)
        : ({ label, skipped: false, jobId: r.jobId } as const);
    } catch (err) {
      return { label, skipped: true, reason: (err as Error).message } as const;
    }
  });

  for (const o of outcomes) {
    if (o.skipped) skipped.push({ target: o.label, reason: o.reason });
    else enqueued.push({ target: o.label, jobId: o.jobId, kind: "nightly_full" });
  }

  return { enqueued, skipped };
}

export type SweepResult = {
  retried: string[];
  failed: Array<{ jobId: string; reason: string }>;
  timedOut: string[];
};

/**
 * Reconcile jobs the happy path lost track of:
 *
 *  - `queued` past the stall window → the dispatch never landed (isolate
 *    reclaimed mid-flight, GitHub outage, missing workflow). Re-dispatch,
 *    then fail once the attempt budget is spent.
 *  - `running` past the timeout → the workflow died without ever posting a
 *    terminal callback. Fail it so the UI stops showing a phantom scan.
 *
 * Without this, a single lost dispatch left a job "queued" forever and the
 * dedup window then suppressed every subsequent scan of that target.
 */
export async function sweepStalledScans(options?: {
  queuedStallMinutes?: number;
  runningTimeoutMinutes?: number;
  limit?: number;
}): Promise<SweepResult> {
  const queuedStall = options?.queuedStallMinutes ?? QUEUED_STALL_MINUTES;
  const runningTimeout = options?.runningTimeoutMinutes ?? RUNNING_TIMEOUT_MINUTES;
  const limit = options?.limit ?? 50;
  const now = Date.now();

  const retried: string[] = [];
  const failed: SweepResult["failed"] = [];
  const timedOut: string[] = [];

  // 1) Stranded queued jobs — re-dispatch or retire.
  const { data: stranded } = await admin
    .from("codex_scan_jobs")
    .select(
      "id, kind, target_kind, clone_id, repo_full_name, ref, path_globs, failure_count, request_payload, next_attempt_at, last_error",
    )
    .eq("status", "queued")
    .lte("created_at", new Date(now - queuedStall * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  for (const job of stranded ?? []) {
    // Respect the backoff window set by the previous failed attempt.
    if (job.next_attempt_at && new Date(job.next_attempt_at).getTime() > now) continue;

    if ((job.failure_count ?? 0) >= MAX_DISPATCH_ATTEMPTS) {
      await admin
        .from("codex_scan_jobs")
        .update({
          status: "failed",
          last_error: job.last_error || "dispatch_attempts_exhausted",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      await recordEvent(job.id, "sweep_failed", { reason: "dispatch_attempts_exhausted" });
      failed.push({ jobId: job.id, reason: "dispatch_attempts_exhausted" });
      continue;
    }

    await recordEvent(job.id, "sweep_retry", { failureCount: job.failure_count ?? 0 });
    const r = await dispatchJob(job);
    if (r.ok) retried.push(job.id);
    else if (r.terminal) failed.push({ jobId: job.id, reason: r.error });
  }

  // 2) Runs that never reported a terminal callback.
  const { data: hung } = await admin
    .from("codex_scan_jobs")
    .select("id")
    .eq("status", "running")
    .lte("started_at", new Date(now - runningTimeout * 60 * 1000).toISOString())
    .limit(limit);

  for (const job of hung ?? []) {
    await admin
      .from("codex_scan_jobs")
      .update({
        status: "failed",
        last_error: `Scan timed out after ${runningTimeout} minutes with no completion callback.`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    await recordEvent(job.id, "sweep_timeout", { runningTimeoutMinutes: runningTimeout });
    timedOut.push(job.id);
  }

  return { retried, failed, timedOut };
}

/**
 * Resolve a repo full-name to (targetKind, cloneId) so webhook-driven scans
 * are stored against the right owner. Returns null if the repo is neither
 * Prime nor a known clone (the webhook is still verified, there is just
 * nothing to do).
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

  // Matched on owner/repo rather than the generated `repo_full_name` column:
  // those two always exist, whereas an `.or()` naming a column a deployment
  // has not migrated yet fails the whole query — which silently disabled
  // PR-driven scans for every clone.
  const { data: clone } = await admin
    .from("clones")
    .select("id")
    .ilike("github_owner", owner)
    .ilike("github_repo", repo)
    .limit(1)
    .maybeSingle();
  if (clone?.id) return { targetKind: "clone", cloneId: clone.id };
  return null;
}
