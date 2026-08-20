import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runCascadeDryRun, type DryRunResult } from "./cascade-dryrun.server";

export type { DryRunResult, CloneImpact, ImpactLevel } from "./cascade-dryrun.server";

export const cascadeDryRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneIds?: string[] }) => data ?? {})
  .handler(async ({ data, context }): Promise<DryRunResult> => {
    return runCascadeDryRun(context.supabase, { cloneIds: data?.cloneIds });
  });
