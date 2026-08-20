/**
 * Take the prime out of a freshly created clone repository.
 *
 * A clone repo is a `createFork` / `createUsingTemplate` byte copy, so three
 * artefacts arrive still naming the PRIME's Supabase project:
 *
 *   - `supabase/config.toml`'s `project_id`, which `rotate-internal-edge-secret`
 *     and the daily `aml-sanctions-refresh` both read to resolve their target;
 *   - `${{ vars.SUPABASE_PROJECT_REF || '<prime ref>' }}` in the deploy and
 *     apply-migration workflows — and the deploy workflow runs on every push
 *     to `main`;
 *   - `supabase/.temp/linked-project.json`, checked in, from which any bare
 *     `supabase …` command resolves whatever `config.toml` says.
 *
 * Nothing rewrote any of them. What stopped a clone acting on the prime was
 * that `SUPABASE_ACCESS_TOKEN` is never pushed to a clone repo — protection by
 * absent credential, not by correct configuration. Adding that token, which is
 * the obvious step to let a clone deploy its own functions, was by itself
 * enough to point its deploys and migrations at the prime's production.
 *
 * There is no safe default for "which project": an unset variable is a
 * question, not a licence to guess. So the workflows are rewritten to fail
 * closed and the ref is supplied as a repository VARIABLE instead.
 */

import { getAppOctokit } from "./github-app.server";

export const CONFIG_TOML_PATH = "supabase/config.toml";
export const LINKED_PROJECT_PATH = "supabase/.temp/linked-project.json";
export const RETARGET_WORKFLOWS = [
  ".github/workflows/deploy-supabase-functions.yml",
  ".github/workflows/apply-migration.yml",
] as const;

// ─── Pure rewrites (unit-tested) ─────────────────────────────────────

/**
 * Point `project_id` at the clone. Only the first assignment is touched —
 * `config.toml` also carries a `[functions.*]` block per edge function, and a
 * blanket replace would corrupt them.
 */
export function rewriteConfigTomlProjectId(toml: string, cloneRef: string): string {
  return toml.replace(/^(\s*project_id\s*=\s*)"[^"]*"/m, `$1"${cloneRef}"`);
}

/** Whether the file still names a project other than the clone's. */
export function configTomlNamesForeignProject(toml: string, cloneRef: string): boolean {
  const m = /^\s*project_id\s*=\s*"([^"]*)"/m.exec(toml);
  return !!m && m[1] !== cloneRef;
}

/**
 * Strip the hard-coded fallback so an unset variable stops the job.
 *
 * Matches `${{ vars.SUPABASE_PROJECT_REF || 'anything' }}` and leaves
 * `${{ vars.SUPABASE_PROJECT_REF }}`. Deliberately does NOT substitute the
 * clone's ref: the ref belongs in a repository variable, where it can be
 * changed without a commit, and a second hard-coded default is the same bug
 * with a different value.
 */
export function stripWorkflowProjectRefDefault(yaml: string): string {
  return yaml.replace(
    /\$\{\{\s*vars\.SUPABASE_PROJECT_REF\s*\|\|\s*'[^']*'\s*\}\}/g,
    "${{ vars.SUPABASE_PROJECT_REF }}",
  );
}

/** True when a workflow would still fall back to a hard-coded project. */
export function workflowHasProjectRefDefault(yaml: string): boolean {
  return /\$\{\{\s*vars\.SUPABASE_PROJECT_REF\s*\|\|\s*'[^']*'\s*\}\}/.test(yaml);
}

// ─── Applying it ─────────────────────────────────────────────────────

export type RetargetAction = {
  target: string;
  status: "rewritten" | "deleted" | "unchanged" | "absent" | "failed";
  detail?: string;
};

export type RetargetResult = {
  ok: boolean;
  actions: RetargetAction[];
};

type RepoRef = { owner: string; repo: string; branch?: string };

/**
 * Re-point a clone repository at its own backend.
 *
 * Every step is independent and non-fatal: a repository that lacks one of
 * these files is not broken, and a partial result is more useful than an
 * abort. The caller decides what an incomplete retarget means.
 */
export async function retargetCloneRepo(
  ref: RepoRef,
  cloneProjectRef: string,
): Promise<RetargetResult> {
  const octokit = getAppOctokit();
  const actions: RetargetAction[] = [];
  const branch = ref.branch;

  const readFile = async (path: string): Promise<{ text: string; sha: string } | null> => {
    try {
      const res = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ...(branch ? { ref: branch } : {}),
      });
      const data = res.data as { type?: string; sha?: string; content?: string };
      if (data.type !== "file" || !data.sha || typeof data.content !== "string") return null;
      return { text: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    } catch (e) {
      if ((e as { status?: number })?.status === 404) return null;
      throw e;
    }
  };

  const writeFile = async (path: string, text: string, sha: string, message: string) => {
    await octokit.repos.createOrUpdateFileContents({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ...(branch ? { branch } : {}),
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      sha,
    });
  };

  // 1. The repository variable. Done FIRST: with the fallbacks stripped and no
  //    variable set, the workflows would fail — correct, but noisier than
  //    necessary if the variable arrives moments later.
  try {
    await octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
      owner: ref.owner,
      repo: ref.repo,
      name: "SUPABASE_PROJECT_REF",
      value: cloneProjectRef,
    });
    actions.push({
      target: "vars.SUPABASE_PROJECT_REF",
      status: "rewritten",
      detail: cloneProjectRef,
    });
  } catch (e) {
    // 409 = already exists; update it instead.
    if ((e as { status?: number })?.status === 409) {
      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
          owner: ref.owner,
          repo: ref.repo,
          name: "SUPABASE_PROJECT_REF",
          value: cloneProjectRef,
        });
        actions.push({
          target: "vars.SUPABASE_PROJECT_REF",
          status: "rewritten",
          detail: cloneProjectRef,
        });
      } catch (e2) {
        actions.push({
          target: "vars.SUPABASE_PROJECT_REF",
          status: "failed",
          detail: e2 instanceof Error ? e2.message : String(e2),
        });
      }
    } else {
      actions.push({
        target: "vars.SUPABASE_PROJECT_REF",
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2. config.toml
  try {
    const f = await readFile(CONFIG_TOML_PATH);
    if (!f) {
      actions.push({ target: CONFIG_TOML_PATH, status: "absent" });
    } else if (!configTomlNamesForeignProject(f.text, cloneProjectRef)) {
      actions.push({ target: CONFIG_TOML_PATH, status: "unchanged" });
    } else {
      await writeFile(
        CONFIG_TOML_PATH,
        rewriteConfigTomlProjectId(f.text, cloneProjectRef),
        f.sha,
        "chore(aurixa): point supabase/config.toml at this deployment's own project",
      );
      actions.push({ target: CONFIG_TOML_PATH, status: "rewritten", detail: cloneProjectRef });
    }
  } catch (e) {
    actions.push({
      target: CONFIG_TOML_PATH,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. The workflows' hard-coded fallbacks
  for (const path of RETARGET_WORKFLOWS) {
    try {
      const f = await readFile(path);
      if (!f) {
        actions.push({ target: path, status: "absent" });
        continue;
      }
      if (!workflowHasProjectRefDefault(f.text)) {
        actions.push({ target: path, status: "unchanged" });
        continue;
      }
      await writeFile(
        path,
        stripWorkflowProjectRefDefault(f.text),
        f.sha,
        "chore(aurixa): fail closed when SUPABASE_PROJECT_REF is unset",
      );
      actions.push({ target: path, status: "rewritten" });
    } catch (e) {
      actions.push({
        target: path,
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. The CLI's own link file, which outranks config.toml for a bare
  //    `supabase` command and is checked in naming the prime.
  try {
    const f = await readFile(LINKED_PROJECT_PATH);
    if (!f) {
      actions.push({ target: LINKED_PROJECT_PATH, status: "absent" });
    } else {
      await octokit.repos.deleteFile({
        owner: ref.owner,
        repo: ref.repo,
        path: LINKED_PROJECT_PATH,
        ...(branch ? { branch } : {}),
        message: "chore(aurixa): drop the checked-in CLI link to another project",
        sha: f.sha,
      });
      actions.push({ target: LINKED_PROJECT_PATH, status: "deleted" });
    }
  } catch (e) {
    actions.push({
      target: LINKED_PROJECT_PATH,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return { ok: actions.every((a) => a.status !== "failed"), actions };
}
