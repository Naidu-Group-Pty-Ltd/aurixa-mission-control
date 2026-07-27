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
      .select("id, codex_nightly_enabled, codex_nightly_cron, codex_pr_scan_enabled, codex_post_merge_revalidate, codex_scan_dedup_hours")
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
    const { data: existing } = await supabase.from("prime_config").select("id").limit(1).maybeSingle();
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

export const enqueueScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => EnqueueInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Admin-only gate (RLS also enforces, but fail fast).
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    // Resolve repo. Prime uses prime_config; clone rows have repo_full_name.
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
          .select("repo_full_name, github_owner, github_repo")
          .eq("id", data.cloneId)
          .maybeSingle();
        if (!c) throw new Error("clone not found");
        repoFullName = c.repo_full_name || `${c.github_owner}/${c.github_repo}`;
      }
    }

    const { data: job, error } = await supabase
      .from("codex_scan_jobs")
      .insert({
        kind: data.kind,
        target_kind: data.targetKind,
        clone_id: data.cloneId ?? null,
        repo_full_name: repoFullName,
        ref: data.ref ?? null,
        path_globs: data.pathGlobs ?? null,
        requested_by: userId,
        request_payload: { source: "manual", ref: data.ref, globs: data.pathGlobs },
      })
      .select()
      .single();
    if (error) throw error;

    // Fire-and-forget dispatch to Codex.
    (async () => {
      try {
        const { enqueueCodexScan } = await import("@/server/codex-security-client.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const origin =
          process.env.APP_PUBLIC_URL || "https://mission-control.aurixasystems.com.au";
        const callbackSecret = process.env.CODEX_SECURITY_WEBHOOK_SECRET || "";
        const res = await enqueueCodexScan({
          jobId: job.id,
          repoFullName,
          ref: data.ref ?? null,
          pathGlobs: data.pathGlobs ?? null,
          kind: data.kind,
          callbackUrl: `${origin}/api/public/hooks/codex-security`,
          callbackSecret,
        });
        await supabaseAdmin
          .from("codex_scan_jobs")
          .update({ external_scan_id: res.externalScanId, status: "running", started_at: new Date().toISOString() })
          .eq("id", job.id);
        await supabaseAdmin
          .from("codex_scan_events")
          .insert({ job_id: job.id, event_type: "dispatched", payload: { externalScanId: res.externalScanId } });
      } catch (err) {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin
          .from("codex_scan_jobs")
          .update({
            status: "failed",
            failure_count: 1,
            last_error: (err as Error).message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        await supabaseAdmin
          .from("codex_scan_events")
          .insert({ job_id: job.id, event_type: "dispatch_failed", payload: { error: (err as Error).message } });
      }
    })();

    return { jobId: job.id };
  });

export const listScanJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("codex_scan_jobs")
      .select("id, kind, target_kind, clone_id, repo_full_name, ref, status, failure_count, last_error, started_at, completed_at, created_at, result_summary")
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
