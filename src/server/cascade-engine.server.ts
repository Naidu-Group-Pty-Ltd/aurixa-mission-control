// Server-only core of the cascade engine. The user-facing server function in
// cascade-engine.functions.ts wraps this with auth middleware; the GitHub
// webhook receiver invokes it directly with the admin client.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  getAppOctokit,
  listFilesMatchingGlobs,
  getFileContent,
  type RepoRef,
} from "./github-app.server";
import { isBlockedByApproval } from "./cascade-approvals.server";
import { validateClonePinsServer } from "./library-validation.server";
import { validateModuleGlobs } from "@/lib/module-globs";

type CascadeResultUpdate = Database["public"]["Tables"]["cascade_results"]["Update"];
type SupabaseLike = SupabaseClient<Database>;

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

function branchName(sourceSha: string) {
  return `aurixa/cascade-${shortSha(sourceSha)}-${Date.now().toString(36)}`;
}

export type CascadeRunResult =
  | {
      ok: true;
      status: "completed" | "failed" | "partial";
      counts: { succeeded: number; opened: number; failed: number; skipped: number; total: number };
    }
  | { ok: false; error: string };

export async function executeCascade(
  supabase: SupabaseLike,
  cascadeEventId: string,
): Promise<CascadeRunResult> {
  const [eventRes, primeRes, queuedRes] = await Promise.all([
    supabase.from("cascade_events").select("*").eq("id", cascadeEventId).single(),
    supabase.from("prime_config").select("*").limit(1).maybeSingle(),
    supabase
      .from("cascade_results")
      .select("*, clones(*)")
      .eq("cascade_event_id", cascadeEventId)
      .eq("status", "queued"),
  ]);

  const event = eventRes.data;
  if (eventRes.error || !event) {
    return { ok: false, error: "Cascade event not found" };
  }
  if (event.status === "completed" || event.status === "failed") {
    return { ok: false, error: `Already ${event.status}` };
  }
  // Blast-radius gate — block engine if a second-operator approval is required
  // and not yet recorded. Engine will re-run via approveCascade.
  const gate = await isBlockedByApproval(supabase, cascadeEventId);
  if (gate.blocked) {
    return { ok: false, error: gate.reason ?? "Awaiting approval" };
  }
  const prime = primeRes.data;
  if (!prime) {
    return { ok: false, error: "Prime not configured — set it up in Settings first" };
  }

  let octokit;
  try {
    octokit = getAppOctokit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GitHub App not configured";
    await supabase
      .from("cascade_events")
      .update({ status: "failed", completed_at: new Date().toISOString(), summary: msg })
      .eq("id", event.id);
    return { ok: false, error: msg };
  }

  const primeRef: RepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    branch: event.source_branch || prime.default_branch || "main",
  };
  let sourceSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: primeRef.owner,
      repo: primeRef.repo,
      branch: primeRef.branch,
    });
    sourceSha = br.commit.sha;
  } catch (e) {
    const msg = `Cannot read prime ${primeRef.owner}/${primeRef.repo}@${primeRef.branch}: ${e instanceof Error ? e.message : "unknown"}`;
    await supabase
      .from("cascade_events")
      .update({ status: "failed", completed_at: new Date().toISOString(), summary: msg })
      .eq("id", event.id);
    return { ok: false, error: msg };
  }

  await supabase
    .from("cascade_events")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      source_sha: sourceSha,
      source_branch: primeRef.branch,
    })
    .eq("id", event.id);

  let succeeded = 0;
  let failed = 0;
  let opened = 0;
  let skipped = 0;

  // Pre-flight: validate clone library pins. If any pin references a missing,
  // unapproved, or empty library entry, fail that clone's queued result early
  // so the cascade can't push partial/wrong file sets.
  const queuedRows = queuedRes.data ?? [];
  const cloneIds = queuedRows
    .map((r) => (r as { clones: { id: string } | null }).clones?.id)
    .filter((v): v is string => Boolean(v));
  const pinCheck = await validateClonePinsServer(supabase, cloneIds);
  const blockedClones = new Map<string, string[]>();
  if (pinCheck.ok && pinCheck.issues.length > 0) {
    for (const issue of pinCheck.issues) {
      if (issue.severity !== "error") continue;
      const list = blockedClones.get(issue.cloneId) ?? [];
      list.push(`${issue.slug}@v${issue.version}: ${issue.reason}`);
      blockedClones.set(issue.cloneId, list);
    }
  }

  for (const r of queuedRows) {
    const clone = (r as { clones: unknown }).clones as {
      id: string;
      name: string;
      github_owner: string;
      github_repo: string;
      default_branch: string;
    } | null;

    if (!clone) {
      await supabase
        .from("cascade_results")
        .update({
          status: "skipped",
          error_message: "Clone not found",
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      skipped++;
      continue;
    }

    const pinErrors = blockedClones.get(clone.id);
    if (pinErrors && pinErrors.length > 0) {
      await supabase
        .from("cascade_results")
        .update({
          status: "failed",
          error_message: `Pin validation failed: ${pinErrors.join("; ")}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
      failed++;
      continue;
    }

    await supabase
      .from("cascade_results")
      .update({ status: "pushing", started_at: new Date().toISOString() })
      .eq("id", r.id);

    try {
      const patch = await processClone({
        octokit,
        primeRef,
        sourceSha,
        mode: event.mode,
        clone,
        supabase,
        scopeFilter: event.scope_filter as Record<string, unknown> | null,
      });

      await supabase.from("cascade_results").update(patch).eq("id", r.id);

      if (patch.status === "succeeded") succeeded++;
      else if (patch.status === "pr_opened") opened++;
      else if (patch.status === "failed") failed++;
      else if (patch.status === "skipped") skipped++;

      if (patch.status === "succeeded" || patch.status === "pr_opened") {
        await supabase
          .from("clones")
          .update({
            sync_status: patch.status === "succeeded" ? "in_sync" : "cascading",
            last_synced_sha: patch.status === "succeeded" ? sourceSha : undefined,
            last_cascade_at: new Date().toISOString(),
            commits_behind: patch.status === "succeeded" ? 0 : undefined,
          })
          .eq("id", clone.id);

        // Code reached the clone's default branch — rebuild what serves it.
        //
        // `succeeded` only, never `pr_opened`: a pull request is a proposal, and
        // the branch the deployment builds from does not have the change on it
        // yet. Rebuilding here would produce an identical artefact and tell an
        // operator the change had shipped.
        //
        // Vercel rebuilds on push by itself ONLY where its GitHub App is
        // installed on the repository. Mission Control forks clones through its
        // own App and never installs Vercel's, so on this fleet nothing else
        // asks. `requestRedeployAfterPush` decides whether the clone's state
        // makes a rebuild appropriate and never throws — a cascade that pushed
        // correctly must not report as failed because a hosting row could not be
        // updated.
        if (patch.status === "succeeded") {
          try {
            const { requestRedeployAfterPush } = await import("@/server/hosting/redeploy.server");
            await requestRedeployAfterPush({
              cloneId: clone.id,
              reason: `cascade ${event.id}`,
              sha: sourceSha,
            });
          } catch (e) {
            console.error("[cascade] redeploy request failed:", e);
          }
        }
      } else if (patch.status === "failed") {
        await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
      }
    } catch (e) {
      failed++;
      await supabase
        .from("cascade_results")
        .update({
          status: "failed",
          error_message: e instanceof Error ? e.message : String(e),
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
    }
  }

  const totalQueued = (queuedRes.data ?? []).length;
  const finalStatus =
    failed > 0 && succeeded + opened === 0
      ? ("failed" as const)
      : failed > 0
        ? ("partial" as const)
        : ("completed" as const);
  const summary = `${succeeded} merged · ${opened} PRs · ${failed} failed · ${skipped} skipped (of ${totalQueued})`;

  await supabase
    .from("cascade_events")
    .update({ status: finalStatus, completed_at: new Date().toISOString(), summary })
    .eq("id", event.id);

  await supabase.from("audit_log").insert({
    action: "cascade.executed",
    entity_type: "cascade_event",
    entity_id: event.id,
    metadata: { mode: event.mode, succeeded, opened, failed, skipped },
  });

  const kind =
    finalStatus === "completed"
      ? "cascade_completed"
      : finalStatus === "failed"
        ? "cascade_failed"
        : "cascade_partial";
  const severity =
    finalStatus === "completed" ? "success" : finalStatus === "failed" ? "error" : "warning";

  await supabase.from("notifications").insert({
    kind,
    severity,
    title: `Cascade ${finalStatus} (${event.mode})`,
    body: summary,
    cascade_event_id: event.id,
    url: `/cascades/${event.id}`,
    metadata: { mode: event.mode, succeeded, opened, failed, skipped },
  });

  type NotifInsert = Database["public"]["Tables"]["notifications"]["Insert"];
  const cloneNotifs: NotifInsert[] = [];
  for (const r of queuedRes.data ?? []) {
    const clone = (r as { clones: { id: string; name: string } | null }).clones;
    if (!clone) continue;
    cloneNotifs.push({
      kind,
      severity,
      title: `${clone.name} · ${event.mode.replace("_", " ")}`,
      body: summary,
      clone_id: clone.id,
      cascade_event_id: event.id,
      url: `/cascades/${event.id}`,
      metadata: { mode: event.mode },
    });
  }
  if (cloneNotifs.length > 0) {
    await supabase.from("notifications").insert(cloneNotifs);
  }

  return {
    ok: true,
    status: finalStatus,
    counts: { succeeded, opened, failed, skipped, total: totalQueued },
  };
}

async function processClone(args: {
  octokit: ReturnType<typeof getAppOctokit>;
  primeRef: RepoRef;
  sourceSha: string;
  mode: Database["public"]["Enums"]["cascade_mode"];
  clone: {
    id: string;
    name: string;
    github_owner: string;
    github_repo: string;
    default_branch: string;
  };
  supabase: SupabaseLike;
  scopeFilter: Record<string, unknown> | null;
}): Promise<CascadeResultUpdate> {
  const { octokit, primeRef, sourceSha, mode, clone, supabase, scopeFilter } = args;

  // Module-sync cascades pin the file_globs to a single module so the push
  // only touches that module's files, not every installed module on the clone.
  // Always run overrides through validateModuleGlobs — the pinning caller
  // could hand us anything (module row, dry-run payload, webhook body).
  const rawOverride = Array.isArray(scopeFilter?.module_globs)
    ? (scopeFilter!.module_globs as unknown[]).filter((g): g is string => typeof g === "string")
    : null;
  const overrideGlobs = rawOverride ? validateModuleGlobs(rawOverride).valid : null;
  if (rawOverride && overrideGlobs && overrideGlobs.length !== rawOverride.length) {
    console.warn(
      `[cascade] dropped ${rawOverride.length - overrideGlobs.length} unsafe override glob(s) for clone ${clone.id}`,
    );
  }

  let installedGlobs: string[];
  let pinSummary: string | null = null;
  if (overrideGlobs && overrideGlobs.length > 0) {
    installedGlobs = overrideGlobs;
  } else {
    const { data: cmods } = await supabase
      .from("clone_modules")
      .select("modules(slug, file_globs)")
      .eq("clone_id", clone.id);

    // Library pins: when a clone pins a specific library version for a module
    // slug, swap that module's live globs for the pinned entry's file_paths.
    // This lets a fork stay on v3 of "checkout" while the prime is on v5.
    const { data: pins } = await supabase
      .from("clone_library_pins")
      .select("slug, version, library_entry_id")
      .eq("clone_id", clone.id);

    const pinRows = (pins ?? []) as Array<{
      slug: string;
      version: number;
      library_entry_id: string;
    }>;

    const pinMap = new Map<string, { version: number; files: string[] }>();
    if (pinRows.length > 0) {
      const entryIds = pinRows.map((p) => p.library_entry_id);
      const { data: entries } = await supabase
        .from("module_library")
        .select("id, file_paths")
        .in("id", entryIds);
      const fileMap = new Map<string, string[]>();
      for (const e of (entries ?? []) as Array<{ id: string; file_paths: string[] | null }>) {
        fileMap.set(e.id, e.file_paths ?? []);
      }
      for (const p of pinRows) {
        const files = fileMap.get(p.library_entry_id) ?? [];
        if (files.length > 0) pinMap.set(p.slug, { version: p.version, files });
      }
    }

    const honored: string[] = [];
    installedGlobs = (cmods ?? []).flatMap(
      (cm: { modules: { slug: string | null; file_globs: string[] | null } | null }) => {
        const slug = cm.modules?.slug ?? null;
        if (slug && pinMap.has(slug)) {
          const pin = pinMap.get(slug)!;
          honored.push(`${slug}@v${pin.version}`);
          return pin.files;
        }
        return cm.modules?.file_globs ?? [];
      },
    );
    if (honored.length > 0) {
      pinSummary = `pins: ${honored.join(", ")}`;
    }
  }

  if (installedGlobs.length === 0) {
    return {
      status: "skipped",
      diff_summary: "No installed modules — nothing to cascade",
      completed_at: new Date().toISOString(),
    };
  }

  const cloneRef: RepoRef = {
    owner: clone.github_owner,
    repo: clone.github_repo,
    branch: clone.default_branch || "main",
  };

  let cloneBranchSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      branch: cloneRef.branch,
    });
    cloneBranchSha = br.commit.sha;
  } catch (e) {
    throw new Error(
      `Clone ${cloneRef.owner}/${cloneRef.repo}@${cloneRef.branch} unreachable: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  const primeFiles = await listFilesMatchingGlobs(octokit, primeRef, installedGlobs);

  if (mode === "notify") {
    const body =
      `### Aurixa cascade — drift notice\n\n` +
      `Prime \`${primeRef.owner}/${primeRef.repo}@${shortSha(sourceSha)}\` ` +
      `has **${primeFiles.length}** file(s) in your installed modules that may be behind.\n\n` +
      `_No commits were made. This is notify-only mode._\n\n` +
      `Files in scope:\n${primeFiles
        .slice(0, 20)
        .map((p) => `- \`${p}\``)
        .join("\n")}` +
      (primeFiles.length > 20 ? `\n\n…and ${primeFiles.length - 20} more.` : "");
    const { data: issue } = await octokit.issues.create({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      title: `Aurixa drift notice · prime@${shortSha(sourceSha)} (${primeFiles.length} files)`,
      body,
      labels: ["aurixa", "drift-notice"],
    });
    return {
      status: "succeeded",
      diff_summary: `Drift issue #${issue.number} opened (${primeFiles.length} files in scope)`,
      pr_url: issue.html_url,
      files_changed: primeFiles.length,
      completed_at: new Date().toISOString(),
    };
  }

  const treeEntries: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = [];

  for (const path of primeFiles) {
    const [primeFile, cloneFile] = await Promise.all([
      getFileContent(octokit, primeRef, path),
      getFileContent(octokit, cloneRef, path),
    ]);
    if (!primeFile) continue;
    if (cloneFile && cloneFile.content === primeFile.content) continue;

    const { data: blob } = await octokit.git.createBlob({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      content: Buffer.from(primeFile.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  if (treeEntries.length === 0) {
    return {
      status: "skipped",
      diff_summary: `Already in sync with prime@${shortSha(sourceSha)}`,
      completed_at: new Date().toISOString(),
    };
  }

  // Build the "diff_summary" — first 5 file paths + count of remainder.
  // If any library pins were honored, surface that in the summary too.
  const summaryFiles = treeEntries.slice(0, 5).map((t) => t.path);
  const summarySuffix = treeEntries.length > 5 ? ` (+${treeEntries.length - 5} more)` : "";
  const pinSuffix = pinSummary ? ` · ${pinSummary}` : "";
  const fileSummary = `${summaryFiles.join(", ")}${summarySuffix}${pinSuffix}`;

  const { data: cloneCommit } = await octokit.git.getCommit({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    commit_sha: cloneBranchSha,
  });
  const { data: newTree } = await octokit.git.createTree({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    base_tree: cloneCommit.tree.sha,
    tree: treeEntries,
  });

  const message =
    `chore(aurixa): cascade ${treeEntries.length} file(s) from prime@${shortSha(sourceSha)}\n\n` +
    treeEntries.map((t) => `- ${t.path}`).join("\n");

  const { data: newCommit } = await octokit.git.createCommit({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    message,
    tree: newTree.sha,
    parents: [cloneBranchSha],
  });

  // === auto_merge: try direct fast-forward push to default branch first ===
  if (mode === "auto_merge") {
    try {
      await octokit.git.updateRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: `heads/${cloneRef.branch}`,
        sha: newCommit.sha,
        force: false,
      });
      return {
        status: "succeeded",
        commit_sha: newCommit.sha.slice(0, 7),
        diff_summary: `Pushed ${treeEntries.length} files directly to ${cloneRef.branch}: ${fileSummary}`,
        files_changed: treeEntries.length,
        completed_at: new Date().toISOString(),
      };
    } catch (directPushErr) {
      // Fall back to branch + PR + merge (handles protected branches)
      const branch = branchName(sourceSha);
      try {
        await octokit.git.createRef({
          owner: cloneRef.owner,
          repo: cloneRef.repo,
          ref: `refs/heads/${branch}`,
          sha: newCommit.sha,
        });
        const { data: pr } = await octokit.pulls.create({
          owner: cloneRef.owner,
          repo: cloneRef.repo,
          title: `Aurixa cascade · prime@${shortSha(sourceSha)} → ${treeEntries.length} file(s)`,
          head: branch,
          base: cloneRef.branch,
          body:
            `Direct push to \`${cloneRef.branch}\` was blocked — falling back to PR + merge.\n\n` +
            `Files synchronized:\n\n` +
            treeEntries.map((t) => `- \`${t.path}\``).join("\n"),
        });
        const { data: merged } = await octokit.pulls.merge({
          owner: cloneRef.owner,
          repo: cloneRef.repo,
          pull_number: pr.number,
          merge_method: "squash",
          commit_title: `Aurixa cascade prime@${shortSha(sourceSha)} (#${pr.number})`,
        });
        return {
          status: "succeeded",
          commit_sha: merged.sha?.slice(0, 7) ?? null,
          pr_url: pr.html_url,
          diff_summary: `Auto-merged via PR (direct push blocked): ${fileSummary}`,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
        };
      } catch (prErr) {
        return {
          status: "failed",
          diff_summary: `Auto-merge failed: ${fileSummary}`,
          files_changed: treeEntries.length,
          error_message: `Direct push: ${directPushErr instanceof Error ? directPushErr.message : "unknown"}; PR fallback: ${prErr instanceof Error ? prErr.message : "unknown"}`,
          completed_at: new Date().toISOString(),
        };
      }
    }
  }

  // === pr mode: branch + open PR (do not merge) ===
  const branch = branchName(sourceSha);
  await octokit.git.createRef({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    ref: `refs/heads/${branch}`,
    sha: newCommit.sha,
  });
  const { data: pr } = await octokit.pulls.create({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    title: `Aurixa cascade · prime@${shortSha(sourceSha)} → ${treeEntries.length} file(s)`,
    head: branch,
    base: cloneRef.branch,
    body:
      `Automated cascade from **${primeRef.owner}/${primeRef.repo}@${shortSha(sourceSha)}**.\n\n` +
      `Files synchronized (scoped to installed modules):\n\n` +
      treeEntries.map((t) => `- \`${t.path}\``).join("\n"),
  });

  return {
    status: "pr_opened",
    pr_url: pr.html_url,
    commit_sha: newCommit.sha.slice(0, 7),
    diff_summary: `PR #${pr.number} opened: ${fileSummary}`,
    files_changed: treeEntries.length,
    completed_at: new Date().toISOString(),
  };
}
