import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getFleetHealth, type FleetHealth } from "./fleet-health.server";

export type { FleetHealth, FleetHealthRow } from "./fleet-health.server";

export const fetchFleetHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { force?: boolean } = {}) => data ?? {})
  .handler(async ({ data, context }): Promise<FleetHealth> => {
    return getFleetHealth(context.supabase, { force: !!data?.force });
  });
