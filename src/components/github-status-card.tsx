import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Github,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getGitHubStatus,
  type GitHubStatus,
  type RepoReachability,
} from "@/server/github-status.functions";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

export function GitHubStatusCard() {
  const fn = useServerFn(getGitHubStatus);
  const { session, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fn();
      setStatus(res);
    } catch (e) {
      let message = "Unknown error";
      if (e instanceof Response) {
        try {
          message = (await e.text()) || `HTTP ${e.status}`;
        } catch {
          message = `HTTP ${e.status}`;
        }
      } else if (e instanceof Error) {
        message = e.message;
      }
      setStatus({ ok: false, configured: false, error: message, repos: [] });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      setStatus({
        ok: false,
        configured: false,
        error: "Sign in to view GitHub App status",
        repos: [],
      });
      setLoading(false);
      return;
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, session]);

  const reachableCount = status?.repos.filter((r) => r.ok).length ?? 0;
  const totalCount = status?.repos.length ?? 0;
  const allReachable = totalCount > 0 && reachableCount === totalCount;
  const failedRepos = status?.repos.filter((r) => !r.ok) ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Github className="h-4 w-4" /> GitHub App connection
            </CardTitle>
            <CardDescription>
              Live status of the Aurixa GitHub App — installation, accessible repos, and per-clone
              reachability.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} />
            {loading ? "Checking…" : "Re-check"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status ? (
          <div className="text-sm text-muted-foreground">Checking GitHub App…</div>
        ) : !status.configured ? (
          <div className="flex items-start gap-3 border border-destructive/40 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="space-y-1 text-sm">
              <div className="font-medium text-destructive">Not configured</div>
              <div className="text-muted-foreground">{status.error}</div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  Set <strong>GITHUB_APP_ID</strong>, <strong>GITHUB_APP_PRIVATE_KEY</strong>, and{" "}
                  <strong>GITHUB_APP_INSTALLATION_ID</strong> secrets.
                </p>
                <p className="text-[11px] italic text-muted-foreground/70">
                  <strong>App ID</strong> — found in your GitHub App's General settings (numeric,
                  e.g. 123456). <strong>Installation ID</strong> — the number at the end of the URL
                  when you click <em>Configure</em> on the installed app (
                  <code className="bg-muted px-1">
                    github.com/settings/installations/<strong>{"<ID>"}</strong>
                  </code>
                  ).
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Tile
                label="App"
                value={status.app?.name ?? "—"}
                sub={status.app ? `id ${status.app.app_id}` : undefined}
              />
              <Tile
                label="Installation"
                value={status.installation?.account ?? "—"}
                sub={
                  status.installation
                    ? `${status.installation.visible_repo_count} repo${status.installation.visible_repo_count === 1 ? "" : "s"} accessible`
                    : undefined
                }
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  reachability
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] uppercase",
                    allReachable
                      ? "border-success/40 text-success"
                      : "border-warning/40 text-warning",
                  )}
                >
                  {reachableCount}/{totalCount} reachable
                </Badge>
              </div>

              {/* Failed repos summary */}
              {failedRepos.length > 0 && (
                <div className="border border-destructive/30 bg-destructive/5 p-3 space-y-2">
                  <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {failedRepos.length} repo{failedRepos.length > 1 ? "s" : ""} failed
                    authorization
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Click on a failed repo below to see the exact GitHub API error and remediation
                    steps.
                  </div>
                </div>
              )}

              {status.repos.length === 0 ? (
                <div className="border border-border bg-surface p-3 text-sm text-muted-foreground">
                  No prime or clones configured yet.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {status.repos.map((r) => (
                    <RepoRow
                      key={r.id}
                      repo={r}
                      expanded={expandedRepoId === r.id}
                      onToggle={() => setExpandedRepoId(expandedRepoId === r.id ? null : r.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RepoRow({
  repo: r,
  expanded,
  onToggle,
}: {
  repo: RepoReachability;
  expanded: boolean;
  onToggle: () => void;
}) {
  const copyError = () => {
    if (r.error) {
      navigator.clipboard.writeText(r.error);
      toast.success("Error copied to clipboard");
    }
  };

  return (
    <li className="border border-border bg-surface text-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/30"
      >
        {r.ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        )}
        <div className="flex-1 truncate">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">
              {r.owner}/{r.repo}
            </span>
            <Badge variant="outline" className="text-[9px] uppercase">
              {r.role}
            </Badge>
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">
            {r.branch}
            {r.ok && r.default_branch_sha && <> · {r.default_branch_sha}</>}
            {!r.ok && r.error && <> · {r.error}</>}
          </div>
        </div>
        {!r.ok &&
          (expanded ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ))}
      </button>

      {/* Drilldown panel */}
      {expanded && !r.ok && (
        <div className="border-t border-border bg-muted/10 px-3 py-3 space-y-3">
          <div className="space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-destructive">
              GitHub API Error
            </div>
            <pre className="whitespace-pre-wrap break-words border border-destructive/20 bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
              {r.error || "Unknown error"}
            </pre>
            <Button variant="ghost" size="sm" onClick={copyError} className="h-6 text-[10px]">
              <Copy className="mr-1 h-3 w-3" /> Copy error
            </Button>
          </div>

          <div className="space-y-1.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Possible causes
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {r.error?.includes("404") || r.error?.includes("Not installed") ? (
                <>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-warning">•</span>
                    GitHub App is not installed on the{" "}
                    <code className="bg-muted px-1">{r.owner}</code> organization/account.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-warning">•</span>
                    Repository <code className="bg-muted px-1">{r.repo}</code> is not included in
                    the app's repository access list.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-warning">•</span>
                    Branch <code className="bg-muted px-1">{r.branch}</code> does not exist in the
                    repository.
                  </li>
                </>
              ) : r.error?.includes("401") || r.error?.includes("Bad credentials") ? (
                <>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-destructive">•</span>
                    Private key does not match the GitHub App ID — regenerate the key in app
                    settings.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-destructive">•</span>
                    Installation ID is incorrect or belongs to a different app.
                  </li>
                </>
              ) : r.error?.includes("403") ? (
                <>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-destructive">•</span>
                    Insufficient permissions — check the app's permission scopes in GitHub settings.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-destructive">•</span>
                    Repository may be archived or restricted.
                  </li>
                </>
              ) : (
                <>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-warning">•</span>
                    Network timeout or GitHub API rate limit exceeded.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 text-warning">•</span>
                    Try re-checking in a few seconds.
                  </li>
                </>
              )}
            </ul>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={`https://github.com/${r.owner}/${r.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 border border-border bg-surface px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" /> View on GitHub
            </a>
            <a
              href={`https://github.com/settings/installations`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 border border-border bg-surface px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" /> GitHub App settings
            </a>
          </div>
        </div>
      )}
    </li>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border bg-surface p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm font-medium">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
