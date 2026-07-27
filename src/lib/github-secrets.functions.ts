// @ts-nocheck
// Admin-facing server functions to push GitHub Actions repository
// secrets from Mission Control into the Prime repo or any clone repo.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(supabase: any, userId: string) {
  const { data } = await supabase.rpc("is_admin", { _user_id: userId });
  if (!data) throw new Error("Forbidden: admin only");
}

async function recordSync(
  supabase: any,
  row: {
    target_kind: "prime" | "clone";
    clone_id: string | null;
    owner: string;
    repo: string;
    result: { ok: boolean; written: string[]; skipped: any[]; failed: any[] };
    trigger_source: string;
    triggered_by: string | null;
  },
) {
  await supabase.from("github_secret_syncs").insert({
    target_kind: row.target_kind,
    clone_id: row.clone_id,
    owner: row.owner,
    repo: row.repo,
    written: row.result.written,
    skipped: row.result.skipped,
    failed: row.result.failed,
    ok: row.result.ok,
    trigger_source: row.trigger_source,
    triggered_by: row.triggered_by,
  });
}

/** Push Codex Actions secrets to the Prime repo. Admin only. */
export const syncPrimeActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { data: prime } = await supabase
      .from("prime_config")
      .select("github_owner, github_repo, github_app_installation_id")
      .limit(1)
      .maybeSingle();
    if (!prime?.github_owner || !prime?.github_repo) {
      return { ok: false, error: "Prime repo not configured" };
    }

    const { syncRepoSecrets, buildCodexRepoSecrets } = await import(
      "@/server/github-secrets.server"
    );
    const result = await syncRepoSecrets({
      owner: prime.github_owner,
      repo: prime.github_repo,
      installationId: prime.github_app_installation_id ?? null,
      secrets: await buildCodexRepoSecrets(),
    });

    await recordSync(supabase, {
      target_kind: "prime",
      clone_id: null,
      owner: prime.github_owner,
      repo: prime.github_repo,
      result,
      trigger_source: "manual",
      triggered_by: userId,
    });

    return { ok: result.ok, ...result };
  });

const CloneInput = z.object({ cloneId: z.string().uuid() });

/** Push Codex Actions secrets to a specific clone repo. Admin only. */
export const syncCloneActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => CloneInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { data: clone } = await supabase
      .from("clones")
      .select("id, github_owner, github_repo, github_app_installation_id")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (!clone?.github_owner || !clone?.github_repo) {
      return { ok: false, error: "Clone has no GitHub repo attached" };
    }

    const { syncRepoSecrets, buildCodexRepoSecrets } = await import(
      "@/server/github-secrets.server"
    );
    const result = await syncRepoSecrets({
      owner: clone.github_owner,
      repo: clone.github_repo,
      installationId: clone.github_app_installation_id ?? null,
      secrets: await buildCodexRepoSecrets(),
    });

    await recordSync(supabase, {
      target_kind: "clone",
      clone_id: clone.id,
      owner: clone.github_owner,
      repo: clone.github_repo,
      result,
      trigger_source: "manual",
      triggered_by: userId,
    });

    return { ok: result.ok, ...result };
  });

/** Fan out to every clone that has a GitHub repo. Admin only. */
export const syncAllCloneActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { data: clones } = await supabase
      .from("clones")
      .select("id, github_owner, github_repo, github_app_installation_id")
      .not("github_owner", "is", null)
      .not("github_repo", "is", null);

    const { syncRepoSecrets, buildCodexRepoSecrets } = await import(
      "@/server/github-secrets.server"
    );
    const secrets = await buildCodexRepoSecrets();

    const summary = { attempted: 0, ok: 0, failed: 0 as number };
    for (const c of clones ?? []) {
      summary.attempted += 1;
      const result = await syncRepoSecrets({
        owner: c.github_owner,
        repo: c.github_repo,
        installationId: c.github_app_installation_id ?? null,
        secrets,
      });
      if (result.ok) summary.ok += 1;
      else summary.failed += 1;
      await recordSync(supabase, {
        target_kind: "clone",
        clone_id: c.id,
        owner: c.github_owner,
        repo: c.github_repo,
        result,
        trigger_source: "fleet-rotation",
        triggered_by: userId,
      });
    }

    return { ok: summary.failed === 0, ...summary };
  });

const ListInput = z.object({
  cloneId: z.string().uuid().optional(),
  targetKind: z.enum(["prime", "clone"]).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const listGithubSecretSyncs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from("github_secret_syncs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    if (data.targetKind) q = q.eq("target_kind", data.targetKind);
    const { data: rows, error } = await q;
    if (error) throw error;
    return { ok: true, rows: rows ?? [] };
  });
