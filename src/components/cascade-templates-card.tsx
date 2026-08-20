import { useEffect, useState, useCallback } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Bookmark, Trash2, Save, Play, Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";

type Template = Database["public"]["Tables"]["cascade_templates"]["Row"];
type Mode = Database["public"]["Enums"]["cascade_mode"];

export type CascadeTemplateValue = {
  mode: Mode;
  scope: "all" | "tagged" | "selected";
  tags: string[];
  cloneIds: string[];
};

/**
 * Saved cascade templates panel — lives next to the new-cascade form.
 *
 *  - Lists all saved presets, sorted by most-recently used
 *  - Apply restores mode/scope/tags into the parent form
 *  - Save-as-template captures the current form state
 *  - Delete removes the preset
 */
export function CascadeTemplatesCard({
  current,
  onApply,
}: {
  current: CascadeTemplateValue;
  onApply: (v: CascadeTemplateValue) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const confirm = useConfirm();
  const bulkDelete = async () => {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Delete ${selected.size} template(s)?`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const { error } = await supabase
      .from("cascade_templates")
      .delete()
      .in("id", Array.from(selected));
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Deleted ${selected.size}`);
    setSelected(new Set());
    refresh();
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("cascade_templates")
      .select("*")
      .order("last_used_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(20);
    setTemplates(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Template needs a name");
      return;
    }
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from("cascade_templates").insert({
      name: trimmed,
      description: description.trim() || null,
      mode: current.mode,
      scope: current.scope,
      tags: current.tags,
      clone_ids: current.cloneIds,
      created_by: user?.id ?? null,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Saved template "${trimmed}"`);
    setName("");
    setDescription("");
    setSaveOpen(false);
    refresh();
  };

  const apply = async (t: Template) => {
    onApply({
      mode: t.mode,
      scope: (t.scope as "all" | "tagged" | "selected") ?? "all",
      tags: t.tags ?? [],
      cloneIds: t.clone_ids ?? [],
    });
    toast.success(`Applied "${t.name}"`);
    // Bump usage stats — fire-and-forget
    void supabase
      .from("cascade_templates")
      .update({
        use_count: (t.use_count ?? 0) + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", t.id)
      .then(() => refresh());
  };

  const remove = async (t: Template) => {
    const { error } = await supabase.from("cascade_templates").delete().eq("id", t.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Deleted "${t.name}"`);
    refresh();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bookmark className="h-4 w-4 text-primary" /> Saved templates
          </CardTitle>
          <CardDescription>Reuse common scope + mode combos in one click.</CardDescription>
        </div>
        <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Save className="mr-1.5 h-3.5 w-3.5" />
              Save current
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save cascade template</DialogTitle>
              <DialogDescription>
                Snapshots <strong>{current.mode.replace("_", " ")}</strong> mode and{" "}
                <strong>{current.scope}</strong> scope
                {current.scope === "tagged" && current.tags.length > 0
                  ? ` (tags: ${current.tags.join(", ")})`
                  : ""}
                {current.scope === "selected" && current.cloneIds.length > 0
                  ? ` (${current.cloneIds.length} clones)`
                  : ""}
                .
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  Name
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Stage all client-* clones (PR)"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  Description (optional)
                </label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this template is for…"
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setSaveOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {saving ? "Saving…" : "Save template"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-2">
        {selected.size > 0 && (
          <div className="flex items-center justify-between border border-primary/40 bg-primary/5 p-2">
            <span className="font-mono text-xs text-muted-foreground">
              {selected.size} selected
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" variant="destructive" onClick={bulkDelete}>
                <Trash2 className="mr-1 h-3 w-3" /> Delete
              </Button>
            </div>
          </div>
        )}
        {loading ? (
          <div className="font-mono text-xs text-muted-foreground">loading…</div>
        ) : templates.length === 0 ? (
          <div className="border border-dashed p-4 text-center font-mono text-[11px] text-muted-foreground">
            No templates saved yet — configure mode + scope above and click{" "}
            <span className="text-foreground">Save current</span>.
          </div>
        ) : (
          templates.map((t) => (
            <div key={t.id} className="flex items-center gap-3 border bg-surface p-2.5">
              <input
                type="checkbox"
                checked={selected.has(t.id)}
                onChange={() => toggleSel(t.id)}
                className="h-4 w-4 cursor-pointer accent-primary"
                aria-label="Select template"
              />
              <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-primary/10 text-primary">
                <Bookmark className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] uppercase", modeTone(t.mode))}
                  >
                    {t.mode.replace("_", " ")}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {t.scope}
                    {t.scope === "tagged" && t.tags.length > 0
                      ? ` · ${t.tags.length} tag${t.tags.length === 1 ? "" : "s"}`
                      : ""}
                    {t.scope === "selected" && t.clone_ids.length > 0
                      ? ` · ${t.clone_ids.length}`
                      : ""}
                  </Badge>
                  {t.use_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground">
                      <Star className="h-3 w-3" /> {t.use_count}
                    </span>
                  )}
                </div>
                {t.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t.description}
                  </div>
                )}
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {t.last_used_at
                    ? `last used ${formatDistanceToNow(t.last_used_at)}`
                    : `created ${formatDistanceToNow(t.created_at)}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => apply(t)}
                  title="Apply to form above"
                >
                  <Play className="mr-1 h-3 w-3" /> Apply
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      title="Delete template"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete "{t.name}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Removes this template. Cascades fired from it stay in history.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => remove(t)}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function modeTone(m: Mode) {
  switch (m) {
    case "auto_merge":
      return "border-warning/40 text-warning";
    case "notify":
      return "border-muted text-muted-foreground";
    case "pr":
    default:
      return "border-info/40 text-info";
  }
}
