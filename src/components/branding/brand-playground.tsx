// Live theme playground. Pick a published profile, tweak colors / typography
// in real-time, see preview render in light + dark, and side-by-side diff
// vs the currently published version.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles, Eye, RotateCcw, Sun, Moon, Loader2, ShieldCheck } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { aiBrandValidate } from "@/server/ai-features.functions";
import { cn } from "@/lib/utils";
import { BrandPreviewFrame, type PreviewBundle } from "./brand-preview-frame";

type Profile = {
  id: string;
  name: string;
  brand_config: Record<string, unknown>;
  report_contact: Record<string, unknown>;
};

type DraftCfg = Record<string, string>;

const COLOR_FIELDS: Array<[string, string]> = [
  ["primary_color", "Primary"],
  ["secondary_color", "Secondary"],
  ["accent_color", "Accent"],
  ["background_color", "Background"],
  ["foreground_color", "Foreground"],
];

const TEXT_FIELDS: Array<[string, string]> = [
  ["brand_name", "Brand name"],
  ["tagline", "Tagline"],
  ["font_family", "Font family"],
];

export function BrandPlaygroundDialog({
  open,
  onClose,
  profiles,
  initialProfileId,
}: {
  open: boolean;
  onClose: () => void;
  profiles: Profile[];
  initialProfileId?: string | null;
}) {
  const [profileId, setProfileId] = useState<string>(initialProfileId ?? profiles[0]?.id ?? "");
  const [draft, setDraft] = useState<DraftCfg>({});
  const [previewVariant, setPreviewVariant] = useState<"both" | "light" | "dark">("both");

  const profile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId],
  );

  const baseBundle = useMemo<PreviewBundle>(() => {
    return {
      brand_config: (profile?.brand_config ?? {}) as Record<string, string>,
      report_contact: (profile?.report_contact ?? {}) as Record<string, string>,
    };
  }, [profile]);

  // Reset draft when switching profiles
  useEffect(() => {
    setDraft({});
  }, [profileId]);

  useEffect(() => {
    if (!profileId && profiles[0]?.id) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  const draftBundle = useMemo<PreviewBundle>(
    () => ({
      brand_config: { ...baseBundle.brand_config, ...draft },
      report_contact: baseBundle.report_contact,
    }),
    [baseBundle, draft],
  );

  const draftCount = Object.keys(draft).length;

  const setField = (k: string, v: string) =>
    setDraft((prev) => {
      const next = { ...prev };
      const baseValue = (baseBundle.brand_config as Record<string, string>)[k] ?? "";
      if (v === baseValue || v === "") delete next[k];
      else next[k] = v;
      return next;
    });

  const resetField = (k: string) =>
    setDraft((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Theme playground
          </DialogTitle>
          <DialogDescription>
            Experiment with brand variations in real time. Changes are local — this playground does
            not persist or cascade anything.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <div className="flex-1 min-w-[200px]">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Profile
            </Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Render mode
            </Label>
            <div className="flex gap-1 mt-1">
              {(["both", "light", "dark"] as const).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={previewVariant === v ? "default" : "outline"}
                  onClick={() => setPreviewVariant(v)}
                >
                  {v === "light" && <Sun className="h-3.5 w-3.5 mr-1" />}
                  {v === "dark" && <Moon className="h-3.5 w-3.5 mr-1" />}
                  {v === "both" && <Eye className="h-3.5 w-3.5 mr-1" />}
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </Button>
              ))}
            </div>
          </div>
          {draftCount > 0 && (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-300 border-amber-500/30">
              {draftCount} unsaved tweak{draftCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>

        {!profile && (
          <div className="text-center py-12 text-sm text-muted-foreground">
            No profiles available. Create one to start tinkering.
          </div>
        )}

        {profile && (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr] mt-4">
            {/* Controls */}
            <div className="space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Colors
              </div>
              {COLOR_FIELDS.map(([key, label]) => {
                const baseValue =
                  (baseBundle.brand_config as Record<string, string>)[key] ?? "#000000";
                const draftValue = draft[key];
                const isOverridden = draftValue !== undefined;
                return (
                  <div
                    key={key}
                    className={cn(
                      "rounded-md border p-2 space-y-1.5",
                      isOverridden ? "border-amber-500/40 bg-amber-500/5" : "border-border",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {label}
                      </Label>
                      {isOverridden && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-[10px]"
                          onClick={() => resetField(key)}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={draftValue ?? baseValue}
                        onChange={(e) => setField(key, e.target.value)}
                        className="h-8 w-12 cursor-pointer border border-input"
                      />
                      <Input
                        value={draftValue ?? baseValue}
                        onChange={(e) => setField(key, e.target.value)}
                        className="font-mono text-xs h-8"
                      />
                    </div>
                  </div>
                );
              })}

              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium pt-2">
                Identity
              </div>
              {TEXT_FIELDS.map(([key, label]) => {
                const baseValue = (baseBundle.brand_config as Record<string, string>)[key] ?? "";
                const draftValue = draft[key];
                const isOverridden = draftValue !== undefined;
                return (
                  <div
                    key={key}
                    className={cn(
                      "rounded-md border p-2 space-y-1.5",
                      isOverridden ? "border-amber-500/40 bg-amber-500/5" : "border-border",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {label}
                      </Label>
                      {isOverridden && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-[10px]"
                          onClick={() => resetField(key)}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    <Input
                      value={draftValue ?? baseValue}
                      onChange={(e) => setField(key, e.target.value)}
                      className="text-xs h-8"
                      placeholder={baseValue}
                    />
                  </div>
                );
              })}
            </div>

            {/* Previews */}
            <div className="space-y-4">
              <BrandAiValidator brandConfig={draftBundle.brand_config as Record<string, unknown>} />
              {previewVariant !== "dark" && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2 flex items-center gap-1">
                    <Sun className="h-3 w-3" /> Light variant
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-1">Published</div>
                      <BrandPreviewFrame bundle={baseBundle} variant="light" />
                    </div>
                    <div>
                      <div className="text-[10px] text-amber-300 mb-1 font-medium">Draft</div>
                      <BrandPreviewFrame bundle={draftBundle} variant="light" />
                    </div>
                  </div>
                </div>
              )}
              {previewVariant !== "light" && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2 flex items-center gap-1">
                    <Moon className="h-3 w-3" /> Dark variant
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-1">Published</div>
                      <BrandPreviewFrame bundle={baseBundle} variant="dark" />
                    </div>
                    <div>
                      <div className="text-[10px] text-amber-300 mb-1 font-medium">Draft</div>
                      <BrandPreviewFrame bundle={draftBundle} variant="dark" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {draftCount > 0 && (
            <Button variant="outline" onClick={() => setDraft({})} className="sm:mr-auto">
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset all tweaks
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BrandAiValidator({ brandConfig }: { brandConfig: Record<string, unknown> }) {
  const fn = useServerFn(aiBrandValidate);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    contrast_issues?: Array<{ pair: string; ratio?: number; min?: number; fix?: string }>;
    tone_notes?: string[];
    color_harmony?: string;
    recommendations?: string[];
    raw?: string;
  } | null>(null);
  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await fn({ data: { brandConfig } });
      setResult(r.result);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="border bg-surface/50 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" /> AI accessibility & tone audit
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={run}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Audit"}
        </Button>
      </div>
      {result && (
        <div className="mt-2 space-y-2 text-xs">
          {result.color_harmony && (
            <div className="font-mono text-[11px]">
              harmony: <span className="text-foreground">{result.color_harmony}</span>
            </div>
          )}
          {(result.contrast_issues ?? []).length > 0 && (
            <div>
              <div className="font-mono text-[10px] uppercase text-muted-foreground">
                Contrast issues
              </div>
              {result.contrast_issues!.map((c, i) => (
                <div key={i} className="ml-2 text-[11px] text-amber-300">
                  • {c.pair} — {c.ratio} (min {c.min}). Fix: {c.fix}
                </div>
              ))}
            </div>
          )}
          {(result.recommendations ?? []).length > 0 && (
            <div>
              <div className="font-mono text-[10px] uppercase text-muted-foreground">
                Recommendations
              </div>
              {result.recommendations!.map((r, i) => (
                <div key={i} className="ml-2 text-[11px]">
                  • {r}
                </div>
              ))}
            </div>
          )}
          {result.raw && (
            <pre className="whitespace-pre-wrap font-mono text-[10px]">{result.raw}</pre>
          )}
        </div>
      )}
    </div>
  );
}
