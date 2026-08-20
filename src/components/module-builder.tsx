import { useState, useCallback, useEffect, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Boxes,
  GripVertical,
  Plus,
  X,
  Loader2,
  Save,
  History,
  RotateCcw,
  AlertTriangle,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClones, useModules, useFleetModules, type Module } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatDistanceToNow } from "@/lib/format";

type DragItem = {
  moduleId: string;
  moduleName: string;
  moduleSlug: string;
  source: "available" | "attached";
};

type Snapshot = {
  id: string;
  clone_id: string;
  module_ids: string[];
  label: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
};

type ValidationIssue = {
  type: "missing_dependency" | "incompatibility";
  module: string;
  target: string;
  message: string;
};

export function ModuleBuilder() {
  const { data: clones, loading: clonesLoading } = useClones();
  const { data: modules, loading: modulesLoading } = useModules();
  const { byClone, loading: fleetLoading, refresh: refreshFleet } = useFleetModules();

  const [selectedCloneId, setSelectedCloneId] = useState<string>("");
  const [attachedModuleIds, setAttachedModuleIds] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState<"available" | "attached" | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);

  const approvedModules = modules.filter((m) => m.status === "approved");

  // Build slug→id map for dependency resolution
  const slugToModule = useMemo(() => {
    const map = new Map<string, Module>();
    for (const m of modules) map.set(m.slug, m);
    return map;
  }, [modules]);

  // Validation: check dependencies & incompatibilities
  const validationIssues = useMemo((): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const attachedSlugs = new Set(
      approvedModules.filter((m) => attachedModuleIds.has(m.id)).map((m) => m.slug),
    );

    for (const m of approvedModules) {
      if (!attachedModuleIds.has(m.id)) continue;

      // Check requires
      const requires = (m as Module & { requires?: string[] }).requires ?? [];
      for (const req of requires) {
        if (!attachedSlugs.has(req)) {
          issues.push({
            type: "missing_dependency",
            module: m.name,
            target: req,
            message: `"${m.name}" requires "${req}" which is not attached.`,
          });
        }
      }

      // Check incompatible_with
      const incompatible = (m as Module & { incompatible_with?: string[] }).incompatible_with ?? [];
      for (const inc of incompatible) {
        if (attachedSlugs.has(inc)) {
          issues.push({
            type: "incompatibility",
            module: m.name,
            target: inc,
            message: `"${m.name}" is incompatible with "${inc}".`,
          });
        }
      }
    }
    return issues;
  }, [approvedModules, attachedModuleIds]);

  const hasBlockingIssues = validationIssues.length > 0;

  // Fetch snapshots when clone changes
  const loadSnapshots = useCallback(async (cloneId: string) => {
    if (!cloneId) return;
    setSnapshotsLoading(true);
    const { data } = await supabase
      .from("module_config_snapshots")
      .select("*")
      .eq("clone_id", cloneId)
      .order("created_at", { ascending: false })
      .limit(20);
    setSnapshots((data as Snapshot[] | null) ?? []);
    setSnapshotsLoading(false);
  }, []);

  // Sync from fleet data when clone changes
  useEffect(() => {
    if (!selectedCloneId) {
      setAttachedModuleIds(new Set());
      setDirty(false);
      setSnapshots([]);
      return;
    }
    const existing = (byClone[selectedCloneId] ?? []).map((cm) => cm.module_id);
    setAttachedModuleIds(new Set(existing));
    setDirty(false);
    loadSnapshots(selectedCloneId);
  }, [selectedCloneId, byClone, loadSnapshots]);

  const selectedClone = clones.find((c) => c.id === selectedCloneId);
  const attached = approvedModules.filter((m) => attachedModuleIds.has(m.id));
  const available = approvedModules.filter((m) => !attachedModuleIds.has(m.id));

  const attachModule = useCallback((moduleId: string) => {
    setAttachedModuleIds((prev) => new Set(prev).add(moduleId));
    setDirty(true);
  }, []);

  const detachModule = useCallback((moduleId: string) => {
    setAttachedModuleIds((prev) => {
      const next = new Set(prev);
      next.delete(moduleId);
      return next;
    });
    setDirty(true);
  }, []);

  const handleDragStart = (e: React.DragEvent, item: DragItem) => {
    e.dataTransfer.setData("application/json", JSON.stringify(item));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = (e: React.DragEvent, target: "available" | "attached") => {
    e.preventDefault();
    setDragOver(null);
    try {
      const item: DragItem = JSON.parse(e.dataTransfer.getData("application/json"));
      if (target === "attached" && item.source === "available") attachModule(item.moduleId);
      else if (target === "available" && item.source === "attached") detachModule(item.moduleId);
    } catch {
      /* ignore */
    }
  };

  const handleDragOver = (e: React.DragEvent, zone: "available" | "attached") => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(zone);
  };

  const handleDragLeave = () => setDragOver(null);

  const save = async () => {
    if (!selectedCloneId || hasBlockingIssues) return;
    setSaving(true);
    try {
      // Snapshot the current config before overwriting
      const {
        data: { user },
      } = await supabase.auth.getUser();

      await supabase.from("module_config_snapshots").insert({
        clone_id: selectedCloneId,
        module_ids: Array.from(attachedModuleIds),
        label: `v${snapshots.length + 1}`,
        is_active: true,
        created_by: user?.id,
      });

      // Remove all existing clone_modules for this clone
      const { error: delError } = await supabase
        .from("clone_modules")
        .delete()
        .eq("clone_id", selectedCloneId);
      if (delError) throw delError;

      // Insert the new set
      if (attachedModuleIds.size > 0) {
        const rows = Array.from(attachedModuleIds).map((module_id) => ({
          clone_id: selectedCloneId,
          module_id,
        }));
        const { error: insError } = await supabase.from("clone_modules").insert(rows);
        if (insError) throw insError;
      }

      // Audit log
      await supabase.from("audit_log").insert({
        action: "module_config.saved",
        entity_type: "clone",
        entity_id: selectedCloneId,
        actor_user_id: user?.id,
        metadata: {
          module_count: attachedModuleIds.size,
          module_ids: Array.from(attachedModuleIds),
        },
      });

      toast.success(`Saved ${attachedModuleIds.size} module(s) for ${selectedClone?.name}`);
      setDirty(false);
      refreshFleet();
      loadSnapshots(selectedCloneId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const revertToSnapshot = async (snap: Snapshot) => {
    setAttachedModuleIds(new Set(snap.module_ids));
    setDirty(true);
    toast.info(`Reverted to "${snap.label}" — click Save to apply.`);
  };

  const loading = clonesLoading || modulesLoading || fleetLoading;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" /> Module builder
            </CardTitle>
            <CardDescription>
              Drag and drop modules to attach or detach them from a clone. Changes are versioned.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {selectedCloneId && (
              <Button variant="ghost" size="sm" onClick={() => setShowHistory(!showHistory)}>
                <History className="mr-2 h-3.5 w-3.5" />
                {showHistory ? "Hide history" : "History"}
              </Button>
            )}
            {dirty && (
              <Button onClick={save} disabled={saving || hasBlockingIssues} size="sm">
                {saving ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-2 h-3.5 w-3.5" />
                )}
                Save
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Clone selector */}
        <div className="space-y-1.5">
          <label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Select clone
          </label>
          <Select value={selectedCloneId} onValueChange={setSelectedCloneId}>
            <SelectTrigger>
              <SelectValue placeholder={loading ? "Loading…" : "Choose a clone"} />
            </SelectTrigger>
            <SelectContent>
              {clones.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}{" "}
                  <span className="text-muted-foreground">
                    ({c.github_owner}/{c.github_repo})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Validation issues */}
        {selectedCloneId && validationIssues.length > 0 && (
          <div className="space-y-1.5">
            {validationIssues.map((issue, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded-md border p-2.5 text-xs",
                  issue.type === "incompatibility"
                    ? "border-destructive/30 bg-destructive/5 text-destructive"
                    : "border-warning/30 bg-warning/5 text-warning",
                )}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{issue.message}</span>
              </div>
            ))}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3 w-3" />
              Resolve all issues before saving.
            </div>
          </div>
        )}

        {selectedCloneId && (
          <div className="grid gap-4 md:grid-cols-2">
            {/* Available modules */}
            <div
              className={cn(
                "space-y-2 rounded-lg border-2 border-dashed p-3 transition-colors",
                dragOver === "available" ? "border-primary/60 bg-primary/5" : "border-border/60",
              )}
              onDrop={(e) => handleDrop(e, "available")}
              onDragOver={(e) => handleDragOver(e, "available")}
              onDragLeave={handleDragLeave}
            >
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Available ({available.length})
              </span>
              {available.length === 0 ? (
                <div className="border border-border bg-surface/50 p-4 text-center text-xs text-muted-foreground">
                  All modules attached
                </div>
              ) : (
                <div className="space-y-1.5">
                  {available.map((m) => (
                    <ModuleChip
                      key={m.id}
                      module={m}
                      source="available"
                      onDragStart={handleDragStart}
                      onAction={() => attachModule(m.id)}
                      actionIcon={<Plus className="h-3 w-3" />}
                      actionLabel="Attach"
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Attached modules */}
            <div
              className={cn(
                "space-y-2 rounded-lg border-2 border-dashed p-3 transition-colors",
                dragOver === "attached"
                  ? "border-success/60 bg-success/5"
                  : "border-success/20 bg-success/5",
              )}
              onDrop={(e) => handleDrop(e, "attached")}
              onDragOver={(e) => handleDragOver(e, "attached")}
              onDragLeave={handleDragLeave}
            >
              <span className="font-mono text-[11px] uppercase tracking-wider text-success">
                Attached ({attached.length})
              </span>
              {attached.length === 0 ? (
                <div className="border border-success/20 bg-surface/50 p-4 text-center text-xs text-muted-foreground">
                  Drag modules here to attach
                </div>
              ) : (
                <div className="space-y-1.5">
                  {attached.map((m) => (
                    <ModuleChip
                      key={m.id}
                      module={m}
                      source="attached"
                      onDragStart={handleDragStart}
                      onAction={() => detachModule(m.id)}
                      actionIcon={<X className="h-3 w-3" />}
                      actionLabel="Detach"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Version history */}
        {showHistory && selectedCloneId && (
          <div className="space-y-2">
            <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Version history
            </div>
            {snapshotsLoading ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : snapshots.length === 0 ? (
              <div className="border border-border bg-surface/50 p-3 text-center text-xs text-muted-foreground">
                No saved versions yet.
              </div>
            ) : (
              <div className="space-y-1">
                {snapshots.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium">{s.label}</span>
                        <Badge variant="outline" className="text-[9px]">
                          {s.module_ids.length} modules
                        </Badge>
                        {s.is_active && (
                          <Badge
                            variant="outline"
                            className="border-success/40 text-success text-[9px]"
                          >
                            active
                          </Badge>
                        )}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {formatDistanceToNow(s.created_at)}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => revertToSnapshot(s)}>
                      <RotateCcw className="mr-1 h-3 w-3" /> Revert
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!selectedCloneId && !loading && (
          <div className="border border-border bg-surface/50 p-6 text-center text-sm text-muted-foreground">
            Select a clone above to manage its module configuration.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ModuleChip({
  module: m,
  source,
  onDragStart,
  onAction,
  actionIcon,
  actionLabel,
}: {
  module: Module;
  source: "available" | "attached";
  onDragStart: (e: React.DragEvent, item: DragItem) => void;
  onAction: () => void;
  actionIcon: React.ReactNode;
  actionLabel: string;
}) {
  const requires = (m as Module & { requires?: string[] }).requires ?? [];
  const incompatible = (m as Module & { incompatible_with?: string[] }).incompatible_with ?? [];
  const hasDeps = requires.length > 0 || incompatible.length > 0;

  return (
    <div
      draggable
      onDragStart={(e) =>
        onDragStart(e, { moduleId: m.id, moduleName: m.name, moduleSlug: m.slug, source })
      }
      className="group flex cursor-grab items-center gap-2 border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/40 active:cursor-grabbing"
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs font-medium truncate">{m.name}</div>
        <div className="font-mono text-[10px] text-muted-foreground truncate">
          {m.slug}
          {hasDeps && (
            <span className="ml-1.5 text-warning">
              {requires.length > 0 && `needs: ${requires.join(", ")}`}
              {requires.length > 0 && incompatible.length > 0 && " · "}
              {incompatible.length > 0 && `conflicts: ${incompatible.join(", ")}`}
            </span>
          )}
        </div>
      </div>
      {m.ai_confidence != null && (
        <Badge variant="outline" className="shrink-0 font-mono text-[9px]">
          {Math.round(Number(m.ai_confidence) * 100)}%
        </Badge>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        className={cn(
          "shrink-0 rounded-sm p-1 opacity-0 transition-opacity group-hover:opacity-100",
          source === "available"
            ? "hover:bg-success/20 hover:text-success"
            : "hover:bg-destructive/20 hover:text-destructive",
        )}
        title={actionLabel}
      >
        {actionIcon}
      </button>
    </div>
  );
}
