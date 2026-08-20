import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Database, Loader2, CheckCircle2, AlertTriangle, ArrowUpCircle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { fleetMigrationSync, getMigrationRegistry } from "@/server/migration-sync.functions";
import { useEffect } from "react";

type Registry = Awaited<ReturnType<typeof getMigrationRegistry>>;
type FleetResult = Extract<Awaited<ReturnType<typeof fleetMigrationSync>>, { ok: true }>;

export function FleetMigrationSyncCard() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<FleetResult["results"] | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRegistry = useServerFn(getMigrationRegistry);
  const syncFleet = useServerFn(fleetMigrationSync);

  const load = async () => {
    setLoading(true);
    try {
      const reg = await fetchRegistry();
      setRegistry(reg);
    } catch {
      // silent
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleFleetSync = async () => {
    setSyncing(true);
    try {
      const result = await syncFleet();
      if ("ok" in result && result.ok) {
        setLastResult(result.results);
        const totalApplied = result.results.reduce((s, r) => s + r.applied, 0);
        const totalFailed = result.results.reduce((s, r) => s + r.failures.length, 0);
        if (totalFailed > 0) {
          toast.warning(`Applied ${totalApplied} migrations across fleet, ${totalFailed} failures`);
        } else if (totalApplied > 0) {
          toast.success(
            `Applied ${totalApplied} migration(s) across ${result.results.length} clone(s)`,
          );
        } else {
          toast.info("All clone backends are already up to date");
        }
      } else if ("error" in result) {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fleet sync failed");
    }
    setSyncing(false);
    load();
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" /> Schema Migration Registry
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading registry...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4 text-primary" /> Schema Migration Registry
        </CardTitle>
        <CardDescription>Track and sync database schema across all clone backends.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {registry && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="border p-3 text-center">
                <div className="text-2xl font-semibold">{registry.totalMigrations}</div>
                <div className="text-[11px] text-muted-foreground">Total migrations</div>
              </div>
              <div className="border p-3 text-center">
                <div className="text-2xl font-semibold text-primary">
                  {registry.cloneApplicable}
                </div>
                <div className="text-[11px] text-muted-foreground">Clone-applicable</div>
              </div>
              <div className="border p-3 text-center">
                <div className="font-mono text-sm font-semibold truncate">
                  {registry.latestCloneVersion}
                </div>
                <div className="text-[11px] text-muted-foreground">Latest version</div>
              </div>
            </div>

            {/* Migration list */}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground">
                View all migrations ({registry.migrations.length})
              </summary>
              <div className="mt-2 max-h-60 overflow-y-auto space-y-1">
                {registry.migrations.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 border p-2 text-xs">
                    {m.cloneApplicable ? (
                      <ArrowUpCircle className="mt-0.5 h-3 w-3 text-primary shrink-0" />
                    ) : (
                      <div className="mt-0.5 h-3 w-3 rounded-full border border-border shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">{m.id}</span>
                        {m.cloneApplicable && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0">
                            clone
                          </Badge>
                        )}
                      </div>
                      <p className="text-foreground truncate">{m.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}

        <Button onClick={handleFleetSync} disabled={syncing} className="w-full">
          {syncing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing fleet...
            </>
          ) : (
            <>
              <ArrowUpCircle className="mr-2 h-4 w-4" /> Sync all clone backends
            </>
          )}
        </Button>

        {/* Last sync results */}
        {lastResult && lastResult.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Last sync results
            </span>
            {lastResult.map((r) => (
              <div key={r.cloneId} className="flex items-center justify-between border p-2 text-xs">
                <span className="font-mono">{r.cloneName}</span>
                <div className="flex items-center gap-2">
                  {r.applied > 0 && (
                    <Badge variant="outline" className="bg-success/10 text-success text-[10px]">
                      <CheckCircle2 className="mr-1 h-3 w-3" /> {r.applied} applied
                    </Badge>
                  )}
                  {r.failures.length > 0 && (
                    <Badge
                      variant="outline"
                      className="bg-destructive/10 text-destructive text-[10px]"
                    >
                      <AlertTriangle className="mr-1 h-3 w-3" /> {r.failures.length} failed
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
