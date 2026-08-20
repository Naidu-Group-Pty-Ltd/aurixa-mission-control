import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Bot, Save } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";
import { formatDistanceToNow } from "@/lib/format";

type Severity = Database["public"]["Enums"]["drift_severity"];
type Mode = Database["public"]["Enums"]["cascade_mode"];

type Policy = {
  id: string;
  clone_id: string;
  enabled: boolean;
  auto_apply_severity: Severity;
  max_per_run: number;
  cascade_mode: Mode;
  muted_kinds: string[];
  last_applied_at: string | null;
  last_applied_count: number;
};

const SEVERITIES: Severity[] = ["low", "medium", "high"];
const MODES: Mode[] = ["pr", "auto_merge", "notify"];

export function CloneDriftPolicyCard({ cloneId }: { cloneId: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("clone_drift_policies")
      .select("*")
      .eq("clone_id", cloneId)
      .maybeSingle();
    setPolicy(data ?? null);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [cloneId]);

  const save = async (patch: Partial<Policy>) => {
    setSaving(true);
    const next: Policy = {
      id: policy?.id ?? crypto.randomUUID(),
      clone_id: cloneId,
      enabled: policy?.enabled ?? false,
      auto_apply_severity: policy?.auto_apply_severity ?? "low",
      max_per_run: policy?.max_per_run ?? 3,
      cascade_mode: policy?.cascade_mode ?? "pr",
      muted_kinds: policy?.muted_kinds ?? [],
      last_applied_at: policy?.last_applied_at ?? null,
      last_applied_count: policy?.last_applied_count ?? 0,
      ...patch,
    };
    const { error } = await supabase.from("clone_drift_policies").upsert(
      {
        clone_id: cloneId,
        enabled: next.enabled,
        auto_apply_severity: next.auto_apply_severity,
        max_per_run: next.max_per_run,
        cascade_mode: next.cascade_mode,
        muted_kinds: next.muted_kinds,
      },
      { onConflict: "clone_id" },
    );
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setPolicy(next);
    toast.success("Auto-apply policy saved");
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-accent" /> AI auto-apply policy
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="font-mono text-xs text-muted-foreground">loading…</div>
        </CardContent>
      </Card>
    );
  }

  const enabled = policy?.enabled ?? false;
  const severity = policy?.auto_apply_severity ?? "low";
  const mode = policy?.cascade_mode ?? "pr";
  const maxPerRun = policy?.max_per_run ?? 3;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-accent" /> AI auto-apply policy
          </CardTitle>
          <CardDescription>
            Drift suggestions matching these rules fire scoped cascades automatically after each
            analyze.
          </CardDescription>
        </div>
        <Switch checked={enabled} disabled={saving} onCheckedChange={(v) => save({ enabled: v })} />
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            max severity to auto-apply
          </div>
          <div className="flex flex-wrap gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={!enabled || saving}
                onClick={() => save({ auto_apply_severity: s })}
                className={cn(
                  "rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                  severity === s
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40",
                  (!enabled || saving) && "opacity-50",
                )}
              >
                ≤ {s}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            cascade mode
          </div>
          <div className="flex flex-wrap gap-2">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                disabled={!enabled || saving}
                onClick={() => save({ cascade_mode: m })}
                className={cn(
                  "rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                  mode === m
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40",
                  (!enabled || saving) && "opacity-50",
                )}
              >
                {m.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            max per run
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={20}
              value={maxPerRun}
              disabled={!enabled || saving}
              onChange={(e) =>
                setPolicy((p) => (p ? { ...p, max_per_run: Number(e.target.value) } : p))
              }
              className="w-24 font-mono"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!enabled || saving}
              onClick={() => save({ max_per_run: maxPerRun })}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>

        {policy?.last_applied_at && (
          <div className="flex items-center gap-2 border-t pt-3 font-mono text-xs text-muted-foreground">
            last fired {formatDistanceToNow(policy.last_applied_at)} ·
            <Badge variant="outline" className="text-[10px] uppercase">
              {policy.last_applied_count} applied
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
