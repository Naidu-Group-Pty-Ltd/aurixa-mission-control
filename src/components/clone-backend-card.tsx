import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Database,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ArrowUpCircle,
  GitBranch,
  Zap,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { getCloneBackendStatus } from "@/lib/backend-provisioning.functions";
import { getCloneMigrationStatus, syncCloneMigrations } from "@/server/migration-sync.functions";
import { cn } from "@/lib/utils";

type BackendStatus = Awaited<ReturnType<typeof getCloneBackendStatus>>["backend"];
type MigrationStatus = Awaited<ReturnType<typeof getCloneMigrationStatus>>;

type MigrationReport = { id: string; name: string; success: boolean; skipped?: boolean };
type FunctionReport = { slug: string; success: boolean; error?: string };
type SecretReport = { name: string; success: boolean; error?: string };

function asReportArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  ready: { label: "Healthy", color: "text-success", icon: CheckCircle2 },
  provisioning: { label: "Provisioning", color: "text-warning", icon: Loader2 },
  migrating: { label: "Migrating", color: "text-info", icon: Loader2 },
  seeding_admin: { label: "Seeding Admin", color: "text-info", icon: Loader2 },
  pending: { label: "Pending", color: "text-muted-foreground", icon: Loader2 },
  failed: { label: "Failed", color: "text-destructive", icon: AlertTriangle },
  suspended: { label: "Suspended", color: "text-muted-foreground", icon: AlertTriangle },
};

export function CloneBackendCard({ cloneId }: { cloneId: string }) {
  const [backend, setBackend] = useState<BackendStatus>(null);
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchBackendStatus = useServerFn(getCloneBackendStatus);
  const fetchMigrationStatus = useServerFn(getCloneMigrationStatus);
  const syncMigrations = useServerFn(syncCloneMigrations);

  const load = async () => {
    setLoading(true);
    try {
      const [bRes, mRes] = await Promise.all([
        fetchBackendStatus({ data: { cloneId } }),
        fetchMigrationStatus({ data: { cloneId } }),
      ]);
      setBackend(bRes.backend);
      setMigration(mRes);
    } catch {
      // silent
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [cloneId]);

  // Auto-refresh while provisioning
  useEffect(() => {
    if (!backend) return;
    const inProgress = ["pending", "provisioning", "migrating", "seeding_admin"].includes(
      backend.status,
    );
    if (!inProgress) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [backend?.status]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncMigrations({ data: { cloneId } });
      if ("ok" in result && result.ok) {
        toast.success(`Applied ${result.applied} migration(s)`);
        if (result.failures.length > 0) {
          toast.warning(`${result.failures.length} migration(s) failed`);
        }
      } else if ("error" in result) {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
    setSyncing(false);
    load();
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" /> Backend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!backend) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-muted-foreground" /> Backend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No dedicated backend provisioned for this clone.
          </p>
        </CardContent>
      </Card>
    );
  }

  const statusCfg = STATUS_CONFIG[backend.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = statusCfg.icon;
  const isActive = ["pending", "provisioning", "migrating", "seeding_admin"].includes(
    backend.status,
  );
  const hasPending = migration?.hasBackend && !migration.isUpToDate;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-primary" /> Dedicated Backend
          </CardTitle>
          <CardDescription className="mt-1">
            {backend.supabase_project_ref
              ? `Project: ${backend.supabase_project_ref}`
              : "Provisioning in progress..."}
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusIcon className={cn("h-4 w-4", statusCfg.color, isActive && "animate-spin")} />
            <span className={cn("text-sm font-medium", statusCfg.color)}>{statusCfg.label}</span>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">
            {backend.region}
          </Badge>
        </div>

        {/* Status detail */}
        {backend.status_detail && (
          <p className="text-xs text-muted-foreground">{backend.status_detail}</p>
        )}

        {/* Error message */}
        {backend.error_message && (
          <div className="border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">{backend.error_message}</p>
          </div>
        )}

        {/* Admin info */}
        {backend.admin_email && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Admin:</span>{" "}
              <span className="font-mono">{backend.admin_email}</span>
            </div>
            {backend.supabase_url && (
              <div>
                <span className="text-muted-foreground">URL:</span>{" "}
                <span className="font-mono truncate">
                  {backend.supabase_url.replace("https://", "")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Prime replication report */}
        {backend.source_repo && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Replicated Architecture
              </span>
              <Badge variant="outline" className="font-mono text-[10px]">
                <GitBranch className="mr-1 h-3 w-3" />
                {backend.source_repo}
                {backend.source_sha ? `@${backend.source_sha.slice(0, 7)}` : ""}
              </Badge>
            </div>
            {(() => {
              const migrations = asReportArray<MigrationReport>(backend.migrations_applied);
              const functions = asReportArray<FunctionReport>(backend.edge_functions);
              const secrets = asReportArray<SecretReport>(backend.secret_shells);
              const failedFns = functions.filter((f) => !f.success);
              const failedSecrets = secrets.filter((s) => !s.success);
              return (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="border p-2 text-center">
                      <div className="text-lg font-semibold">
                        {migrations.filter((m) => m.success).length}
                      </div>
                      <div className="text-[10px] text-muted-foreground">Migrations</div>
                    </div>
                    <div
                      className={cn(
                        "rounded-md border p-2 text-center",
                        failedFns.length > 0 && "border-warning/50",
                      )}
                    >
                      <div className="text-lg font-semibold">
                        {functions.filter((f) => f.success).length}
                        <span className="text-xs text-muted-foreground">/{functions.length}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        <Zap className="mr-0.5 inline h-2.5 w-2.5" />
                        Edge functions
                      </div>
                    </div>
                    <div
                      className={cn(
                        "rounded-md border p-2 text-center",
                        failedSecrets.length > 0 && "border-warning/50",
                      )}
                    >
                      <div className="text-lg font-semibold">
                        {secrets.filter((s) => s.success).length}
                        <span className="text-xs text-muted-foreground">/{secrets.length}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        <KeyRound className="mr-0.5 inline h-2.5 w-2.5" />
                        Secret shells
                      </div>
                    </div>
                  </div>

                  {failedFns.length > 0 && (
                    <div className="space-y-1">
                      {failedFns.map((f) => (
                        <div
                          key={f.slug}
                          className="border border-warning/40 bg-warning/5 p-2 text-xs"
                        >
                          <span className="font-mono font-medium">{f.slug}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            — {f.error ?? "deploy failed"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {secrets.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                        Secret sync ({secrets.length})
                      </summary>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {secrets.map((s) => {
                          const status = (s as any).status as string | undefined;
                          const isMissing = status === "missing" || (!status && !s.success);
                          const isFailed = status === "failed";
                          return (
                            <Badge
                              key={s.name}
                              variant="outline"
                              className={cn(
                                "font-mono text-[10px]",
                                isMissing && "border-warning/60 text-warning",
                                isFailed && "border-destructive/60 text-destructive",
                              )}
                            >
                              {s.name}
                            </Badge>
                          );
                        })}
                      </div>
                      <a
                        href={`/clones/${cloneId}/secrets`}
                        className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
                      >
                        Manage secret values →
                      </a>
                    </details>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Migration status */}
        {migration?.hasBackend && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Schema Migrations
              </span>
              {migration.isUpToDate ? (
                <Badge variant="outline" className="bg-success/10 text-success text-[10px]">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Up to date
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-warning/10 text-warning text-[10px]">
                  <ArrowUpCircle className="mr-1 h-3 w-3" /> {migration.pendingCount} pending
                </Badge>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Version:{" "}
                <span className="font-mono">{migration.currentVersion ?? "bootstrap"}</span>
              </span>
              <span>
                Latest: <span className="font-mono">{migration.latestVersion}</span>
              </span>
            </div>

            {/* Pending migration list */}
            {hasPending && migration.pendingMigrations.length > 0 && (
              <div className="space-y-1">
                {migration.pendingMigrations.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 border p-2 text-xs">
                    <ArrowUpCircle className="mt-0.5 h-3 w-3 text-warning shrink-0" />
                    <div>
                      <span className="font-mono text-[10px] text-muted-foreground">{m.id}</span>
                      <p className="text-foreground">{m.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {hasPending && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleSync}
                disabled={syncing}
                className="w-full"
              >
                {syncing ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Applying migrations...
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="mr-2 h-3 w-3" /> Apply {migration.pendingCount}{" "}
                    pending migration{migration.pendingCount !== 1 ? "s" : ""}
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
