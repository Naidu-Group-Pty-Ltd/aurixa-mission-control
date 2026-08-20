import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type DriftSeverity = "low" | "medium" | "high";
type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

export type DriftPolicyInput = {
  cloneId: string;
  enabled: boolean;
  auto_apply_severity: DriftSeverity;
  max_per_run: number;
  cascade_mode: CascadeMode;
  muted_kinds?: string[];
};

export const upsertDriftPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: DriftPolicyInput) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!["low", "medium", "high"].includes(data.auto_apply_severity)) {
      throw new Error("auto_apply_severity invalid");
    }
    if (!["pr", "auto_merge", "notify"].includes(data.cascade_mode)) {
      throw new Error("cascade_mode invalid");
    }
    if (typeof data.max_per_run !== "number" || data.max_per_run < 1 || data.max_per_run > 25) {
      throw new Error("max_per_run must be 1-25");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("clone_drift_policies").upsert(
      {
        clone_id: data.cloneId,
        enabled: data.enabled,
        auto_apply_severity: data.auto_apply_severity,
        max_per_run: data.max_per_run,
        cascade_mode: data.cascade_mode,
        muted_kinds: data.muted_kinds ?? [],
      },
      { onConflict: "clone_id" },
    );
    if (error) return { ok: false as const, error: error.message as string };
    await context.supabase.from("audit_log").insert({
      action: "drift_policy.updated",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        enabled: data.enabled,
        auto_apply_severity: data.auto_apply_severity,
        cascade_mode: data.cascade_mode,
        max_per_run: data.max_per_run,
      },
    });
    return { ok: true as const };
  });
