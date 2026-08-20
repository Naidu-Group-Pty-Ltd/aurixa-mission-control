import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAppOctokit, clearAppOctokitCache } from "./github-app.server";

// Diagnostics for the Aurixa GitHub App installation. Used by the
// "GitHub App connection" card on /settings to surface whether the
// app is configured, which repos it can see, and whether prime + each
// clone is reachable through the app's token.

export type RepoReachability = {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  ok: boolean;
  error?: string;
  role: "prime" | "clone";
  default_branch_sha?: string | null;
};

export type GitHubStatus = {
  ok: boolean;
  configured: boolean;
  error?: string;
  app?: {
    name: string;
    slug: string;
    app_id: number;
  };
  installation?: {
    id: number;
    account: string;
    target_type: string;
    repository_selection: string;
    visible_repo_count: number;
  };
  repos: RepoReachability[];
};

export const getGitHubStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GitHubStatus> => {
    const { supabase } = context;
    // Clear cache so re-checks pick up rotated secrets / converted keys
    clearAppOctokitCache();
    let octokit;
    try {
      octokit = getAppOctokit();
    } catch (e) {
      return {
        ok: false,
        configured: false,
        error: e instanceof Error ? e.message : "GitHub App not configured",
        repos: [],
      };
    }

    // Load app metadata + accessible repos in parallel.
    // We are authenticated as the installation, so listReposAccessibleToInstallation
    // returns exactly the repos this installation can see.
    const [appRes, reposRes, primeRes, clonesRes] = await Promise.all([
      octokit.apps.getAuthenticated().catch((e) => ({ error: e })),
      octokit.apps
        .listReposAccessibleToInstallation({ per_page: 100 })
        .catch((e) => ({ error: e })),
      supabase.from("prime_config").select("*").limit(1).maybeSingle(),
      supabase
        .from("clones")
        .select("id,name,github_owner,github_repo,default_branch")
        .order("created_at", { ascending: true }),
    ]);

    const status: GitHubStatus = {
      ok: true,
      configured: true,
      repos: [],
    };

    if ("data" in appRes && appRes.data) {
      const a = appRes.data as { name?: string; slug?: string; id?: number };
      status.app = {
        name: a.name ?? "Unknown",
        slug: a.slug ?? "unknown",
        app_id: a.id ?? 0,
      };
    }

    let visibleCount = 0;
    if ("data" in reposRes && reposRes.data) {
      const d = reposRes.data as {
        total_count?: number;
        repositories?: Array<{ owner?: { login?: string } }>;
      };
      visibleCount = d.total_count ?? d.repositories?.length ?? 0;
      const firstRepo = d.repositories?.[0];
      if (firstRepo?.owner?.login) {
        status.installation = {
          id: 0, // populated below if listInstallationRepos succeeded
          account: firstRepo.owner.login,
          target_type: "Unknown",
          repository_selection: "selected",
          visible_repo_count: visibleCount,
        };
      }
    }
    if (!status.installation) {
      status.installation = {
        id: 0,
        account: "Unknown",
        target_type: "Unknown",
        repository_selection: "selected",
        visible_repo_count: visibleCount,
      };
    }

    // Build the reachability list: prime first, then each clone
    const targets: Array<Omit<RepoReachability, "ok" | "error" | "default_branch_sha">> = [];
    const prime = primeRes.data;
    if (prime) {
      targets.push({
        id: `prime:${prime.id}`,
        name: `${prime.github_owner}/${prime.github_repo} (prime)`,
        owner: prime.github_owner,
        repo: prime.github_repo,
        branch: prime.default_branch || "main",
        role: "prime",
      });
    }
    for (const c of clonesRes.data ?? []) {
      targets.push({
        id: c.id,
        name: c.name,
        owner: c.github_owner,
        repo: c.github_repo,
        branch: c.default_branch || "main",
        role: "clone",
      });
    }

    // Clones may live under their own GitHub App installation. Probing them
    // all with the default installation reported false "not installed"
    // failures for any clone outside it.
    const { loadCloneInstallationIds } = await import("@/server/clone-installation.server");
    const cloneInstallations = await loadCloneInstallationIds(
      supabase,
      targets.filter((t) => t.role === "clone").map((t) => t.id),
    );

    status.repos = await Promise.all(
      targets.map(async (t) => {
        const installationId =
          t.role === "prime"
            ? (primeRes.data?.github_app_installation_id ?? null)
            : (cloneInstallations.get(t.id) ?? null);
        try {
          // Inside the try: resolving a per-clone installation can itself
          // throw, and one bad row must not reject the whole probe.
          const client = installationId ? getAppOctokit(installationId) : octokit;
          const { data: br } = await client.repos.getBranch({
            owner: t.owner,
            repo: t.repo,
            branch: t.branch,
          });
          return { ...t, ok: true, default_branch_sha: br.commit.sha.slice(0, 7) };
        } catch (e: unknown) {
          const err = e as { status?: number; message?: string };
          const msg =
            err.status === 404
              ? `Not installed on ${t.owner}/${t.repo} (or branch "${t.branch}" missing)`
              : err.message || "Unreachable";
          return { ...t, ok: false, error: msg };
        }
      }),
    );

    return status;
  });
