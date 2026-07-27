// Operator-facing diagnostics for the Codex Security scan engine.
//
// The failure mode this exists to kill: the pipeline stops running and the
// UI shows nothing but an empty job table, so there is no way to tell a
// missing GitHub App permission from an unconfigured webhook secret from a
// workflow file that was never copied into the target repo. Every check
// below reports a boolean plus the exact remediation step.
//
// Only presence/absence of secrets is ever reported — never their values.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type HealthCheck = {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What an operator should do about it, when it is not ok. */
  fix?: string;
};

export const getCodexEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  // `context` is typed by the auth middleware at runtime; the project's
  // non-strict tsconfig cannot infer it through createServerFn's builder.
  .handler(async ({ context }: { context: any }) => {
    const { supabase, userId } = context;
    const { data: isOperator } = await supabase.rpc("is_operator", { _user_id: userId });
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isOperator && !isAdmin) throw new Error("Forbidden: operator or admin only");

    const {
      resolveScanEngine,
      scanWorkflowFile,
      scanCallbackUrl,
      appPublicOrigin,
      checkScanWorkflowPresent,
    } = await import("@/server/codex-security-client.server");
    const { resolveScanWebhookSecret } = await import("@/server/codex-scheduling.server");

    const engine = resolveScanEngine();
    const checks: HealthCheck[] = [];

    checks.push({
      key: "engine",
      label: "Scan engine",
      status: "ok",
      detail:
        engine === "github_actions"
          ? `GitHub Actions — dispatches .github/workflows/${scanWorkflowFile()} in each target repo`
          : `Hosted HTTP API — ${process.env.CODEX_SECURITY_BASE_URL || "(default base URL)"}`,
    });

    // ── Callback plumbing ────────────────────────────────────────────────
    const origin = appPublicOrigin();
    const originExplicit = !!(process.env.APP_PUBLIC_URL || process.env.PUBLIC_APP_URL);
    checks.push({
      key: "callback_url",
      label: "Callback URL",
      status: originExplicit ? "ok" : "warn",
      detail: scanCallbackUrl(),
      fix: originExplicit
        ? undefined
        : `Neither APP_PUBLIC_URL nor PUBLIC_APP_URL is set — falling back to ${origin}. Scanners post results to this URL, so set it if that host is wrong.`,
    });

    const webhookSecret = await resolveScanWebhookSecret();
    checks.push({
      key: "webhook_secret",
      label: "Webhook HMAC secret",
      status: webhookSecret ? "ok" : "fail",
      detail: webhookSecret
        ? process.env.CODEX_SECURITY_WEBHOOK_SECRET
          ? "Configured via CODEX_SECURITY_WEBHOOK_SECRET"
          : "Using the auto-generated secret on the built-in `codex` intake source"
        : "No signing secret available — scans are refused before dispatch",
      fix: webhookSecret
        ? undefined
        : "Set CODEX_SECURITY_WEBHOOK_SECRET, or ensure the built-in `codex` row in security_intake_sources has an hmac_secret.",
    });

    checks.push({
      key: "cron_secret",
      label: "Cron shared secret",
      status: process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN ? "ok" : "fail",
      detail:
        process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN
          ? "Configured — scheduled nightly scans and the sweeper can authenticate"
          : "Missing — every pg_cron call to /hooks/* is rejected with 401",
      fix:
        process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN
          ? undefined
          : "Set CRON_SECRET, and mirror it into Postgres so pg_cron can send it: ALTER DATABASE postgres SET app.settings.cron_secret = '<value>';",
    });

    // ── GitHub App ───────────────────────────────────────────────────────
    if (engine === "github_actions") {
      const appConfigured =
        !!process.env.GITHUB_APP_ID &&
        !!process.env.GITHUB_APP_PRIVATE_KEY &&
        !!process.env.GITHUB_APP_INSTALLATION_ID;
      checks.push({
        key: "github_app",
        label: "GitHub App credentials",
        status: appConfigured ? "ok" : "fail",
        detail: appConfigured
          ? "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID are set"
          : "Incomplete — scan dispatch cannot authenticate to GitHub",
        fix: appConfigured
          ? undefined
          : "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID. The App installation needs Actions: read & write.",
      });
    } else {
      checks.push({
        key: "api_key",
        label: "Codex API key",
        status: process.env.CODEX_SECURITY_API_KEY ? "ok" : "fail",
        detail: process.env.CODEX_SECURITY_API_KEY
          ? "CODEX_SECURITY_API_KEY is set"
          : "CODEX_SECURITY_API_KEY is not set — every HTTP-engine dispatch throws",
        fix: process.env.CODEX_SECURITY_API_KEY
          ? undefined
          : "Set CODEX_SECURITY_API_KEY, or switch back to the GitHub Actions engine by unsetting CODEX_SECURITY_ENGINE.",
      });
    }

    checks.push({
      key: "deep_scan",
      label: "Codex reasoning pass",
      status: process.env.OPENAI_API_KEY ? "ok" : "warn",
      detail: process.env.OPENAI_API_KEY
        ? "OPENAI_API_KEY available to sync into repo Actions secrets"
        : "No OPENAI_API_KEY in Mission Control — scans still run gitleaks, semgrep and osv-scanner",
      fix: process.env.OPENAI_API_KEY
        ? undefined
        : "Optional. Set OPENAI_API_KEY and re-run the Actions secret sync to enable the Codex CLI reasoning pass in scan workflows.",
    });

    // ── Prime repo + workflow presence ───────────────────────────────────
    const { data: prime } = await supabase
      .from("prime_config")
      .select(
        "github_owner, github_repo, default_branch, github_app_installation_id, codex_nightly_enabled, codex_pr_scan_enabled",
      )
      .limit(1)
      .maybeSingle();

    const primeRepo = prime ? `${prime.github_owner}/${prime.github_repo}` : null;
    checks.push({
      key: "prime_repo",
      label: "Prime repository",
      status: primeRepo ? "ok" : "fail",
      detail: primeRepo ?? "prime_config has no GitHub repo configured",
      fix: primeRepo ? undefined : "Set github_owner / github_repo in prime_config.",
    });

    if (engine === "github_actions" && prime?.github_owner && prime?.github_repo) {
      // Network call — the single most common cause of a silently dead
      // pipeline is the workflow file never having been copied to the repo.
      const present = await checkScanWorkflowPresent({
        owner: prime.github_owner,
        repo: prime.github_repo,
        ref: prime.default_branch || undefined,
        installationId: prime.github_app_installation_id ?? null,
      }).catch((err) => ({ present: false, detail: (err as Error).message }));

      checks.push({
        key: "workflow_file",
        label: "Scan workflow in Prime repo",
        status: present.present ? "ok" : "fail",
        detail: present.detail,
        fix: present.present
          ? undefined
          : `Commit .github/workflows/${scanWorkflowFile()} to ${primeRepo} on branch ${prime.default_branch || "main"} (a reference copy lives in this repo).`,
      });
    }

    // ── Recent activity ──────────────────────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [recentRes, lastCompletedRes, stalledRes] = await Promise.all([
      supabase.from("codex_scan_jobs").select("status").gte("created_at", since),
      supabase
        .from("codex_scan_jobs")
        .select("id, repo_full_name, completed_at, result_summary")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1),
      supabase
        .from("codex_scan_jobs")
        .select("id")
        .in("status", ["queued", "running"])
        .lte("created_at", new Date(Date.now() - 75 * 60 * 1000).toISOString()),
    ]);

    const byStatus: Record<string, number> = {};
    for (const j of recentRes.data ?? []) {
      byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    }

    const lastCompleted = lastCompletedRes.data?.[0] ?? null;
    checks.push({
      key: "last_completed",
      label: "Last completed scan",
      status: lastCompleted ? "ok" : "warn",
      detail: lastCompleted
        ? `${lastCompleted.repo_full_name} at ${lastCompleted.completed_at}`
        : "No scan has ever completed",
      fix: lastCompleted
        ? undefined
        : "Fix any failing check above, then use “Scan Prime Now” to verify the pipeline end to end.",
    });

    const stalledCount = (stalledRes.data ?? []).length;
    checks.push({
      key: "stalled",
      label: "Stalled jobs",
      status: stalledCount === 0 ? "ok" : "warn",
      detail:
        stalledCount === 0
          ? "No jobs stuck in queued/running"
          : `${stalledCount} job(s) stuck for over 75 minutes`,
      fix:
        stalledCount === 0
          ? undefined
          : "The sweeper (/hooks/codex-sweep, every 10 minutes) retries or retires these. Check that the pg_cron job exists and CRON_SECRET matches.",
    });

    const failedCount = (byStatus.failed ?? 0) + 0;
    const summary = {
      engine,
      last24h: byStatus,
      healthy: checks.every((c) => c.status !== "fail"),
      failing: checks.filter((c) => c.status === "fail").length,
      warnings: checks.filter((c) => c.status === "warn").length,
      nightlyEnabled: prime?.codex_nightly_enabled ?? null,
      prScanEnabled: prime?.codex_pr_scan_enabled ?? null,
      recentFailures: failedCount,
    };

    return { checks, summary };
  });
