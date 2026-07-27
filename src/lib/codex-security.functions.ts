// @ts-nocheck
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const SchedulingInput = z.object({
  codex_nightly_enabled: z.boolean().optional(),
  codex_nightly_cron: z.string().min(9).max(64).optional(),
  codex_pr_scan_enabled: z.boolean().optional(),
  codex_post_merge_revalidate: z.boolean().optional(),
  codex_scan_dedup_hours: z.number().int().min(0).max(168).optional(),
});

export const getSchedulingConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("prime_config")
      .select(
        "id, codex_nightly_enabled, codex_nightly_cron, codex_pr_scan_enabled, codex_post_merge_revalidate, codex_scan_dedup_hours",
      )
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return { config: data };
  });

export const updateSchedulingConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => SchedulingInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { data: existing } = await supabase
      .from("prime_config")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!existing) throw new Error("prime_config not initialized");
    const { error } = await supabase.from("prime_config").update(data).eq("id", existing.id);
    if (error) throw error;
    return { ok: true };
  });

export const runNightlyNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { runNightlyScans } = await import("@/server/codex-scheduling.server");
    return await runNightlyScans();
  });

const EnqueueInput = z.object({
  kind: z
    .enum(["manual", "nightly_full", "pr_open", "targeted_path", "post_merge_revalidate"])
    .default("manual"),
  targetKind: z.enum(["prime", "clone"]).default("prime"),
  cloneId: z.string().uuid().optional(),
  repoFullName: z.string().optional(),
  ref: z.string().optional(),
  pathGlobs: z.array(z.string()).optional(),
});

/**
 * Queue a scan as an authenticated admin.
 *
 * The insert-and-dispatch mechanics live in `enqueueScanNoAuth` so there is
 * exactly one implementation; this fn only adds the auth gate and repo
 * resolution. (The two used to be separate copies and had already drifted —
 * only one of them recorded dispatch failures.)
 */
export const enqueueScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => EnqueueInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Admin-only gate (RLS also enforces, but fail fast).
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    let repoFullName = data.repoFullName || "";
    if (!repoFullName) {
      if (data.targetKind === "prime") {
        const { data: p } = await supabase
          .from("prime_config")
          .select("github_owner, github_repo")
          .limit(1)
          .maybeSingle();
        if (!p) throw new Error("prime_config not set");
        repoFullName = `${p.github_owner}/${p.github_repo}`;
      } else {
        if (!data.cloneId) throw new Error("cloneId required for clone scans");
        const { data: c } = await supabase
          .from("clones")
          .select("github_owner, github_repo")
          .eq("id", data.cloneId)
          .maybeSingle();
        if (!c) throw new Error("clone not found");
        repoFullName = `${c.github_owner}/${c.github_repo}`;
      }
    }

    const { enqueueScanNoAuth } = await import("@/server/codex-scheduling.server");
    const result = await enqueueScanNoAuth({
      kind: data.kind,
      targetKind: data.targetKind,
      cloneId: data.cloneId ?? null,
      repoFullName,
      ref: data.ref ?? null,
      pathGlobs: data.pathGlobs ?? null,
      requestedBy: userId,
      // Manual scans are explicit operator intent — never dedup them away.
      dedupWindowHours: 0,
      requestPayload: { source: "manual", requestedBy: userId },
    });

    if (result.skipped) throw new Error(result.reason);
    return {
      jobId: result.jobId,
      engine: result.engine,
      dispatchError: result.dispatchError ?? null,
    };
  });

export const listScanJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("codex_scan_jobs")
      .select(
        "id, kind, target_kind, clone_id, repo_full_name, ref, status, failure_count, last_error, started_at, completed_at, created_at, result_summary",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { jobs: data ?? [] };
  });

const JobIdInput = z.object({ jobId: z.string().uuid() });

export const getScanDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => JobIdInput.parse(d))
  .handler(async ({ data, context }) => {
    const [job, findings, events] = await Promise.all([
      context.supabase.from("codex_scan_jobs").select("*").eq("id", data.jobId).maybeSingle(),
      context.supabase
        .from("codex_findings")
        .select("*")
        .eq("scan_job_id", data.jobId)
        .order("severity", { ascending: true })
        .order("created_at", { ascending: false }),
      context.supabase
        .from("codex_scan_events")
        .select("*")
        .eq("job_id", data.jobId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (job.error) throw job.error;
    return { job: job.data, findings: findings.data ?? [], events: events.data ?? [] };
  });

// -------- Phase 5: fleet views + per-clone controls --------

/**
 * Fleet overview, aggregated in Postgres.
 *
 * This used to pull the last 500 clone scan jobs and *every* open finding
 * across the fleet into the server function on each 30s poll, then group
 * them in JavaScript. `codex_fleet_overview()` does the DISTINCT ON and the
 * severity roll-up in one indexed query and returns one row per clone.
 */
export const listCloneCodexOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("codex_fleet_overview");
    if (error) throw error;

    const clones = (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      repo_full_name: row.repo_full_name,
      github_owner: row.github_owner,
      github_repo: row.github_repo,
      codex_nightly_enabled: row.codex_nightly_enabled,
      sync_status: row.sync_status,
      lastScan: row.last_scan,
      openFindings: row.open_findings ?? {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    }));

    return { clones };
  });

const CloneNightlyInput = z.object({
  cloneId: z.string().uuid(),
  enabled: z.boolean(),
});

export const setCloneNightly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => CloneNightlyInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { error } = await context.supabase
      .from("clones")
      .update({ codex_nightly_enabled: data.enabled })
      .eq("id", data.cloneId);
    if (error) throw error;
    return { ok: true };
  });

const ScanCloneInput = z.object({ cloneId: z.string().uuid() });

export const runCloneScanNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ScanCloneInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { enqueueScanNoAuth } = await import("@/server/codex-scheduling.server");
    const { data: clone } = await context.supabase
      .from("clones")
      .select("github_owner, github_repo")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (!clone) throw new Error("clone not found");
    const repo = `${clone.github_owner}/${clone.github_repo}`;
    const r = await enqueueScanNoAuth({
      kind: "manual",
      targetKind: "clone",
      cloneId: data.cloneId,
      repoFullName: repo,
      dedupWindowHours: 0,
      requestPayload: { source: "manual_clone", requestedBy: context.userId },
    });
    return r;
  });

export const listCloneScanJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: jobs, error } = await context.supabase
      .from("codex_scan_jobs")
      .select(
        "id, kind, status, started_at, completed_at, created_at, result_summary, last_error, ref",
      )
      .eq("clone_id", data.cloneId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    return { jobs: jobs ?? [] };
  });

export const listCloneOpenFindings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: findings, error } = await context.supabase
      .from("codex_findings")
      .select("id, title, severity, state, category, file_path, created_at, scan_job_id")
      .eq("clone_id", data.cloneId)
      .eq("state", "open")
      .order("severity", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { findings: findings ?? [] };
  });
