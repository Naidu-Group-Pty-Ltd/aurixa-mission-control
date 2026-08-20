import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getModuleDependencyGraph } from "@/server/library-admin.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { GitFork, Loader2, FileCode, ArrowRight, Layers } from "lucide-react";

type GraphData = {
  module: { id: string; name: string; slug: string };
  ownFiles: string[];
  edges: Array<{ source_file: string; target_file: string; import_type: string }>;
  externalTargets: string[];
  moduleDependencies: Array<{
    module_id: string;
    module_name: string;
    module_slug: string;
    shared_files: string[];
  }>;
};

export function ModuleDependencyGraphButton({
  moduleId,
  variant = "ghost",
  size = "sm",
}: {
  moduleId: string;
  variant?: "ghost" | "outline";
  size?: "sm" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const fn = useServerFn(getModuleDependencyGraph);

  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    setLoading(true);
    void fn({ data: { moduleId } })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setData(res as GraphData);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, data, fn, moduleId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={variant} title="View dependency graph">
          <GitFork className="h-3.5 w-3.5" />
          {size !== "icon" && (
            <span className="ml-1 font-mono text-[10px] uppercase tracking-wider">deps</span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono">
            <GitFork className="h-4 w-4" /> Dependency graph
            {data && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {data.module.name}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Files this module owns, files it imports from elsewhere, and which other modules it
            depends on. Review this before syncing to clones to understand the blast radius.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && data && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Stat
                label="own files"
                value={data.ownFiles.length}
                icon={<FileCode className="h-3 w-3" />}
              />
              <Stat
                label="external imports"
                value={data.externalTargets.length}
                icon={<ArrowRight className="h-3 w-3" />}
              />
              <Stat
                label="module deps"
                value={data.moduleDependencies.length}
                icon={<Layers className="h-3 w-3" />}
              />
            </div>

            {data.moduleDependencies.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Cross-module dependencies
                </div>
                <div className="space-y-1.5">
                  {data.moduleDependencies.map((d) => (
                    <Card key={d.module_id} className="border-primary/20 bg-primary/5">
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <div className="font-mono text-sm">
                            {d.module_name}
                            <span className="ml-2 text-[11px] text-muted-foreground">
                              {d.module_slug}
                            </span>
                          </div>
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {d.shared_files.length} file{d.shared_files.length === 1 ? "" : "s"}
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {d.shared_files.slice(0, 6).map((f) => (
                            <code key={f} className="bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                              {f}
                            </code>
                          ))}
                          {d.shared_files.length > 6 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{d.shared_files.length - 6} more
                            </span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {data.externalTargets.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  External imports ({data.externalTargets.length})
                </div>
                <div className="max-h-32 overflow-y-auto border border-border bg-muted/30 p-2 space-y-0.5">
                  {data.externalTargets.map((f) => (
                    <code key={f} className="block font-mono text-[10px] text-muted-foreground">
                      {f}
                    </code>
                  ))}
                </div>
              </div>
            )}

            <details className="text-xs">
              <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
                Owned files ({data.ownFiles.length})
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto border border-border bg-muted/30 p-2 space-y-0.5">
                {data.ownFiles.map((f) => (
                  <code key={f} className="block font-mono text-[10px] text-muted-foreground">
                    {f}
                  </code>
                ))}
              </div>
            </details>

            {data.edges.length === 0 && (
              <p className="text-xs text-muted-foreground italic">
                No import-edge data found. Run a fresh detection with “Analyze imports” enabled to
                populate the graph.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-1 font-mono text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
