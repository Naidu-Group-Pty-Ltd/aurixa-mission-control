// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
/**
 * G9 — GitHub App access verification for clone repositories.
 *
 * The clone-wizard preflight (github-preflight.functions.ts) checks that the
 * Aurixa App is installed on the target *owner* before we create the repo.
 * G9 closes the loop after the repo exists (fork/template/manual) and on any
 * follow-up: verify the specific `owner/repo` is reachable by the App's
 * installation and that its permissions still cover writes.
 *
 * Exposes:
 *   - verifyCloneRepoGithubAccess({ cloneId })   — one clone, live check
 *   - auditFleetGithubAccess()                   — every non-archived clone
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { checkGithubAppPreflight, type GithubPreflightResult } from "./github-preflight.functions";
import { asJson } from "@/lib/json-cast";

const OneInput = z.object({ cloneId: z.string().uuid() });

export type CloneGithubAccessRow = {
  clone_id: string;
  clone_name: string;
  github_owner: string;
  github_repo: string;
  ok: boolean;
  installation_found: boolean;
  repo_accessible: boolean | null;
  repository_selection: "all" | "selected" | null;
  contents_write: boolean | null;
  message?: string;
  hint?: string;
};

async function fetchClone(supabase: any, cloneId: string) {
  const { data, error } = await supabase
    .from("clones")
    .select("id, name, github_owner, github_repo, status")
    .eq("id", cloneId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Clone not found");
  return data;
}

function toRow(
  clone: { id: string; name: string; github_owner: string; github_repo: string },
  r: GithubPreflightResult,
): CloneGithubAccessRow {
  return {
    clone_id: clone.id,
    clone_name: clone.name,
    github_owner: clone.github_owner,
    github_repo: clone.github_repo,
    ok: r.ok,
    installation_found: r.installationFound,
    repo_accessible: r.targetRepoAccessible ?? null,
    repository_selection: r.repositorySelection ?? null,
    contents_write: r.contentsWritePermission ?? null,
    message: r.message,
    hint: r.hint,
  };
}

export const verifyCloneRepoGithubAccess = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) => OneInput.parse(i))
  .handler(async ({ data, context }): Promise<CloneGithubAccessRow> => {
    const clone = await fetchClone(context.supabase, data.cloneId);
    const r = await checkGithubAppPreflight({
      data: {
        targetOwner: clone.github_owner,
        targetRepo: clone.github_repo,
      },
    });
    const row = toRow(clone, r);
    // Persist a lightweight audit trace for the fleet ops log.
    try {
      await context.supabase.from("audit_log").insert({
        actor_user_id: context.userId,
        action: "github_app_access_check",
        entity_type: "clone",
        entity_id: clone.id,
        metadata: asJson({
          ok: row.ok,
          repo_accessible: row.repo_accessible,
          repository_selection: row.repository_selection,
          contents_write: row.contents_write,
          message: row.message,
        }),
      });
    } catch {
      /* best-effort */
    }
    return row;
  });

export const auditFleetGithubAccess = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(
    async ({
      context,
    }): Promise<{
      checked: number;
      ok: number;
      failing: CloneGithubAccessRow[];
      generated_at: string;
    }> => {
      // `clones` has no `status` column and no archived concept of any kind —
      // the `.not("status", "eq", "archived")` this replaces was copied from
      // `modules`, which does have one. PostgREST answered 42703 to the whole
      // select and the error is thrown two lines down, so this sweep has never
      // completed a single run.
      const { data: clones, error } = await context.supabase
        .from("clones")
        .select("id, name, github_owner, github_repo");
      if (error) throw new Error(error.message);

      const rows: CloneGithubAccessRow[] = [];
      // Sequential to stay under GitHub App rate-limit budget; there are rarely
      // more than a few dozen clones per fleet.
      for (const c of clones ?? []) {
        if (!c.github_owner || !c.github_repo) continue;
        try {
          const r = await checkGithubAppPreflight({
            data: { targetOwner: c.github_owner, targetRepo: c.github_repo },
          });
          rows.push(toRow(c, r));
        } catch (e) {
          rows.push({
            clone_id: c.id,
            clone_name: c.name,
            github_owner: c.github_owner,
            github_repo: c.github_repo,
            ok: false,
            installation_found: false,
            repo_accessible: null,
            repository_selection: null,
            contents_write: null,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const failing = rows.filter((r) => !r.ok);
      // Emit a notification when the fleet has any failures — actionable signal
      // for operators to reinstall / re-grant the App before the next cascade.
      if (failing.length > 0) {
        try {
          await context.supabase.from("notifications").insert({
            kind: "github_app_access_drift",
            title: `GitHub App access drift on ${failing.length} clone(s)`,
            body: failing
              .slice(0, 5)
              .map((f) => `${f.github_owner}/${f.github_repo}: ${f.message ?? "no access"}`)
              .join("\n"),
            severity: "warning",
          });
        } catch {
          /* best-effort */
        }
      }

      return {
        checked: rows.length,
        ok: rows.filter((r) => r.ok).length,
        failing,
        generated_at: new Date().toISOString(),
      };
    },
  );
