import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runDriftRefresh, type DriftRefreshResult } from "./drift-refresh.server";

export type { DriftRefreshResult } from "./drift-refresh.server";

export const refreshFleetDrift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DriftRefreshResult> => {
    return runDriftRefresh(context.supabase);
  });
