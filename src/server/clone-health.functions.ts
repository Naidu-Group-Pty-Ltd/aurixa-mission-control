import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getCloneHealth, type CloneHealth } from "./clone-health.server";

export type { CloneHealth } from "./clone-health.server";

export const fetchCloneHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; force?: boolean }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }): Promise<CloneHealth> => {
    return getCloneHealth(context.supabase, data.cloneId, { skipCache: !!data.force });
  });
