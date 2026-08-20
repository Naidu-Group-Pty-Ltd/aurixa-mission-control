import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { triageCascadeFailures, type TriageResult } from "./cascade-triage.server";

export type { TriageProposal, TriageResult } from "./cascade-triage.server";

export const triageCascade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cascadeEventId: string }) => {
    if (!data?.cascadeEventId) throw new Error("cascadeEventId required");
    return data;
  })
  .handler(async ({ data, context }): Promise<TriageResult> => {
    return triageCascadeFailures(context.supabase, data.cascadeEventId);
  });
