// Backend architecture panel for a module.
//
// Module detection used to describe only the frontend, so this view had
// nothing to show: the edge functions a page invokes, the tables behind them,
// the secrets they need and the migrations that create their schema were never
// recorded. These are exactly the things that have to travel with a module for
// a clone to actually work, so they are surfaced next to the file globs.

import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Cloud,
  Database,
  KeyRound,
  Layers,
  FileCode2,
  Clock,
  HardDrive,
  Globe,
  TriangleAlert,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ModuleBackendFields = {
  layer?: string | null;
  edge_functions?: string[] | null;
  database_tables?: string[] | null;
  database_rpcs?: string[] | null;
  storage_buckets?: string[] | null;
  cron_jobs?: string[] | null;
  required_secrets?: string[] | null;
  required_migrations?: string[] | null;
  backend_file_globs?: string[] | null;
  external_hosts?: string[] | null;
  backend_manifest?: unknown;
};

type SectionProps = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  items: string[];
  /** Collapse past this many chips. */
  limit?: number;
  emptyHint?: string;
  tone?: "default" | "warning";
};

function ArtifactSection({
  icon: Icon,
  label,
  items,
  limit = 12,
  emptyHint,
  tone = "default",
}: SectionProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  const hidden = items.length - shown.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint ?? "None detected."}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((item) => (
            <Badge
              key={item}
              variant="outline"
              className={cn(
                "font-mono text-[10px]",
                tone === "warning" && "border-warning/50 text-warning",
              )}
            >
              {item}
            </Badge>
          ))}
          {hidden > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-2 font-mono text-[10px]"
              onClick={() => setExpanded(true)}
            >
              +{hidden} more
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip the directory prefix so a migration list stays readable. */
function migrationName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function ModuleBackendCard({ module }: { module: ModuleBackendFields }) {
  const edgeFunctions = module.edge_functions ?? [];
  const tables = module.database_tables ?? [];
  const rpcs = module.database_rpcs ?? [];
  const secrets = module.required_secrets ?? [];
  const migrations = module.required_migrations ?? [];
  const buckets = module.storage_buckets ?? [];
  const cronJobs = module.cron_jobs ?? [];
  const hosts = module.external_hosts ?? [];
  const backendGlobs = module.backend_file_globs ?? [];
  const layer = module.layer ?? "fullstack";

  const hasBackend = edgeFunctions.length > 0 || tables.length > 0 || migrations.length > 0;

  // A module whose edge functions ship but whose globs don't cover them would
  // cascade broken. Surface that rather than letting it fail silently on a clone.
  const globsMissing = edgeFunctions.length > 0 && backendGlobs.length === 0;

  const indirectLinks = useMemo(() => {
    const manifest = module.backend_manifest as
      | { links?: Array<{ kind?: string; identifier?: string; via?: string }> }
      | null
      | undefined;
    return (manifest?.links ?? []).filter((l) => l.kind === "edge_function_indirect");
  }, [module.backend_manifest]);

  const sharedMigrations = useMemo(() => {
    const manifest = module.backend_manifest as
      | { shared_migrations?: Array<{ path: string; claimed_by: number }> }
      | null
      | undefined;
    return manifest?.shared_migrations ?? [];
  }, [module.backend_manifest]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Backend architecture</CardTitle>
            <CardDescription>
              Edge functions, schema, secrets and migrations this module needs in order to run on a
              clone.
            </CardDescription>
          </div>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">
            <Layers className="mr-1 h-3 w-3" />
            {layer}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!hasBackend && (
          <p className="text-sm text-muted-foreground">
            No backend dependencies detected. This module is frontend-only, or the prime repo has
            not been rescanned since backend detection was enabled.
          </p>
        )}

        {globsMissing && (
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription>
              This module needs {edgeFunctions.length} edge function(s) but has no backend globs — a
              cascade would push the UI without its backend. Re-run detection with backend globs
              enabled.
            </AlertDescription>
          </Alert>
        )}

        {hasBackend && (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              <ArtifactSection
                icon={Cloud}
                label="edge functions"
                items={edgeFunctions}
                emptyHint="No edge functions invoked."
              />
              <ArtifactSection
                icon={KeyRound}
                label="required secrets"
                items={secrets}
                tone="warning"
                emptyHint="No operator-supplied secrets."
              />
              <ArtifactSection icon={Database} label="tables" items={tables} />
              <ArtifactSection icon={Database} label="rpc functions" items={rpcs} />
              {buckets.length > 0 && (
                <ArtifactSection icon={HardDrive} label="storage buckets" items={buckets} />
              )}
              {cronJobs.length > 0 && (
                <ArtifactSection icon={Clock} label="cron jobs" items={cronJobs} />
              )}
              {hosts.length > 0 && (
                <ArtifactSection icon={Globe} label="external hosts" items={hosts} />
              )}
            </div>

            <div className="border-t border-border pt-4">
              <ArtifactSection
                icon={FileCode2}
                label="migrations"
                items={migrations.map(migrationName)}
                limit={8}
                emptyHint="No migrations resolved for this module's tables."
              />
              {sharedMigrations.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {sharedMigrations.length} of these are shared with other modules — they carry
                  repo-wide infrastructure, not this module&apos;s private schema.
                </p>
              )}
            </div>

            {backendGlobs.length > 0 && (
              <div className="border-t border-border pt-4">
                <ArtifactSection
                  icon={Layers}
                  label="backend globs pushed by cascade"
                  items={backendGlobs}
                  limit={10}
                />
              </div>
            )}

            {indirectLinks.length > 0 && (
              <div className="border-t border-border pt-4">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  lower-confidence links · {indirectLinks.length}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Matched by slug literal rather than a direct call site — the prime routes these
                  through a helper, so the function name is the only evidence.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {indirectLinks.slice(0, 20).map((l) => (
                    <Badge
                      key={l.identifier}
                      variant="secondary"
                      className="font-mono text-[10px]"
                      title={l.via}
                    >
                      {l.identifier}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
