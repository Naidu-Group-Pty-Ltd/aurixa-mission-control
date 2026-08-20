// Per-clone override editor. Loads the inherited bundle, lets operator
// override individual fields (color, contact, URLs), and shows a live
// side-by-side preview of "before" vs "after" using BrandPreviewFrame.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useConfirm } from "@/components/confirm-dialog";
import {
  upsertCloneOverrides,
  clearCloneOverrides,
  getCloneEffectiveBundle,
} from "@/server/branding-extensions.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Save, Eraser, Layers, Eye, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BrandPreviewFrame, type PreviewBundle } from "./brand-preview-frame";

type EffectiveAssignment = {
  overrides: Record<string, unknown>;
  override_keys: string[];
  profile_id: string;
  clone_brand_profiles: {
    brand_config: Record<string, unknown>;
    report_contact: Record<string, unknown>;
    asset_manifest: unknown[];
    version: number;
    name: string;
    slug: string;
  } | null;
};

type Field = {
  key: string;
  label: string;
  group: "brand_config" | "report_contact";
  type: "color" | "text" | "textarea" | "url";
};

const OVERRIDABLE_FIELDS: Field[] = [
  { key: "brand_name", label: "Brand name", group: "brand_config", type: "text" },
  { key: "tagline", label: "Tagline", group: "brand_config", type: "text" },
  { key: "primary_color", label: "Primary", group: "brand_config", type: "color" },
  { key: "secondary_color", label: "Secondary", group: "brand_config", type: "color" },
  { key: "accent_color", label: "Accent", group: "brand_config", type: "color" },
  { key: "background_color", label: "Background", group: "brand_config", type: "color" },
  { key: "foreground_color", label: "Foreground", group: "brand_config", type: "color" },
  { key: "logo_light_url", label: "Logo (light)", group: "brand_config", type: "url" },
  { key: "logo_dark_url", label: "Logo (dark)", group: "brand_config", type: "url" },
  { key: "favicon_url", label: "Favicon", group: "brand_config", type: "url" },
  { key: "support_url", label: "Support URL", group: "brand_config", type: "url" },
  { key: "contact_name", label: "Contact name", group: "report_contact", type: "text" },
  { key: "contact_email", label: "Contact email", group: "report_contact", type: "text" },
  { key: "contact_phone", label: "Contact phone", group: "report_contact", type: "text" },
  { key: "contact_website", label: "Contact website", group: "report_contact", type: "text" },
  { key: "contact_address", label: "Contact address", group: "report_contact", type: "textarea" },
];

export function CloneOverrideEditorDialog({
  open,
  onClose,
  cloneId,
  cloneName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  cloneId: string;
  cloneName: string;
  onSaved: () => void;
}) {
  const fetchFn = useServerFn(getCloneEffectiveBundle);
  const upsertFn = useServerFn(upsertCloneOverrides);
  const clearFn = useServerFn(clearCloneOverrides);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assignment, setAssignment] = useState<EffectiveAssignment | null>(null);
  const [overrides, setOverrides] = useState<{
    brand_config: Record<string, string>;
    report_contact: Record<string, string>;
  }>({ brand_config: {}, report_contact: {} });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchFn({ data: { cloneId } })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          toast.error(r.error ?? "Failed to load assignment");
          setLoading(false);
          return;
        }
        const a = r.assignment as EffectiveAssignment;
        setAssignment(a);
        const ov = (a.overrides ?? {}) as {
          brand_config?: Record<string, string>;
          report_contact?: Record<string, string>;
        };
        setOverrides({
          brand_config: ov.brand_config ?? {},
          report_contact: ov.report_contact ?? {},
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : "Failed to load assignment");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cloneId, fetchFn]);

  const baseBundle = useMemo<PreviewBundle>(() => {
    const profile = assignment?.clone_brand_profiles;
    return {
      brand_config: (profile?.brand_config ?? {}) as Record<string, string>,
      report_contact: (profile?.report_contact ?? {}) as Record<string, string>,
    };
  }, [assignment]);

  const mergedBundle = useMemo<PreviewBundle>(() => {
    return {
      brand_config: { ...baseBundle.brand_config, ...overrides.brand_config },
      report_contact: {
        ...baseBundle.report_contact,
        ...overrides.report_contact,
      },
    };
  }, [baseBundle, overrides]);

  const overrideCount =
    Object.keys(overrides.brand_config).length + Object.keys(overrides.report_contact).length;

  const setField = (group: Field["group"], key: string, value: string) => {
    setOverrides((prev) => {
      const next = { ...prev[group] };
      if (value.trim() === "") delete next[key];
      else next[key] = value;
      return { ...prev, [group]: next };
    });
  };

  const resetField = (group: Field["group"], key: string) => {
    setOverrides((prev) => {
      const next = { ...prev[group] };
      delete next[key];
      return { ...prev, [group]: next };
    });
  };

  const handleSave = async () => {
    if (!assignment?.profile_id) return;
    setSaving(true);
    const r = await upsertFn({
      data: {
        cloneId,
        profileId: assignment.profile_id,
        overrides,
      },
    });
    setSaving(false);
    if (r.ok) {
      toast.success(`Overrides saved · ${overrideCount} field(s). Run apply to push.`);
      onSaved();
      onClose();
    } else {
      toast.error(r.error ?? "Save failed");
    }
  };

  const confirm = useConfirm();
  const handleClearAll = async () => {
    const ok = await confirm({
      title: "Clear all overrides for this clone?",
      description: "Every brand and report-contact override on this clone will be removed.",
      confirmText: "Clear all",
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    const r = await clearFn({ data: { cloneId } });
    setSaving(false);
    if (r.ok) {
      toast.success("Overrides cleared");
      setOverrides({ brand_config: {}, report_contact: {} });
      onSaved();
      onClose();
    } else {
      toast.error(r.error ?? "Clear failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            Clone overrides · {cloneName}
          </DialogTitle>
          <DialogDescription>
            Layer per-clone tweaks on top of the inherited brand profile. Empty fields fall through
            to the profile defaults.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {!loading && !assignment && (
          <div className="text-center py-10 text-sm text-muted-foreground">
            This clone has no brand assignment yet.
          </div>
        )}

        {!loading && assignment && (
          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            {/* Editor */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  Inherited from{" "}
                  <span className="font-mono text-foreground">
                    {assignment.clone_brand_profiles?.name}
                  </span>{" "}
                  v{assignment.clone_brand_profiles?.version}
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    overrideCount > 0 ? "bg-amber-500/10 text-amber-300 border-amber-500/30" : "",
                  )}
                >
                  {overrideCount} override{overrideCount === 1 ? "" : "s"}
                </Badge>
              </div>

              <Tabs defaultValue="brand_config">
                <TabsList>
                  <TabsTrigger value="brand_config">Brand config</TabsTrigger>
                  <TabsTrigger value="report_contact">Contact</TabsTrigger>
                </TabsList>

                {(["brand_config", "report_contact"] as const).map((group) => (
                  <TabsContent key={group} value={group} className="mt-3 space-y-2">
                    {OVERRIDABLE_FIELDS.filter((f) => f.group === group).map((f) => {
                      const baseValue = (baseBundle[group] as Record<string, string>)[f.key] ?? "";
                      const overrideValue = overrides[group][f.key];
                      const isOverridden = overrideValue !== undefined;
                      return (
                        <div
                          key={f.key}
                          className={cn(
                            "rounded-md border p-2.5 space-y-1.5",
                            isOverridden
                              ? "border-amber-500/40 bg-amber-500/5"
                              : "border-border bg-card",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              {f.label}
                              {isOverridden && (
                                <span className="ml-2 normal-case tracking-normal text-amber-300">
                                  overridden
                                </span>
                              )}
                            </Label>
                            {isOverridden && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5 text-[10px]"
                                onClick={() => resetField(group, f.key)}
                              >
                                <RotateCcw className="h-3 w-3 mr-1" />
                                Reset
                              </Button>
                            )}
                          </div>
                          {f.type === "color" ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={overrideValue ?? baseValue ?? "#000000"}
                                onChange={(e) => setField(group, f.key, e.target.value)}
                                className="h-9 w-14 cursor-pointer border border-input bg-background"
                              />
                              <Input
                                value={overrideValue ?? ""}
                                placeholder={baseValue || "Inherit default"}
                                onChange={(e) => setField(group, f.key, e.target.value)}
                                className="font-mono text-sm"
                              />
                            </div>
                          ) : f.type === "textarea" ? (
                            <Textarea
                              rows={2}
                              value={overrideValue ?? ""}
                              placeholder={baseValue || "Inherit default"}
                              onChange={(e) => setField(group, f.key, e.target.value)}
                            />
                          ) : (
                            <Input
                              value={overrideValue ?? ""}
                              placeholder={baseValue || "Inherit default"}
                              onChange={(e) => setField(group, f.key, e.target.value)}
                              className={cn(f.type === "url" && "font-mono text-xs")}
                            />
                          )}
                        </div>
                      );
                    })}
                  </TabsContent>
                ))}
              </Tabs>
            </div>

            {/* Preview */}
            <div className="space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> Live preview
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wider">
                  Inherited
                </div>
                <BrandPreviewFrame bundle={baseBundle} variant="light" />
              </div>
              <div>
                <div className="text-[10px] text-amber-300 mb-1.5 uppercase tracking-wider font-medium">
                  With overrides
                </div>
                <BrandPreviewFrame bundle={mergedBundle} variant="light" />
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {assignment && overrideCount > 0 && (
            <Button
              variant="outline"
              onClick={handleClearAll}
              disabled={saving}
              className="sm:mr-auto"
            >
              <Eraser className="mr-2 h-4 w-4" />
              Clear all
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !assignment}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving…" : "Save overrides"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
