import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getTenantUsageSummaryFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ tenantId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: summary, error } = await context.supabase.rpc("tenant_usage_summary", {
      _tenant_id: data.tenantId,
    });
    if (error) throw new Error(error.message);
    return { summary: summary as Record<string, number | string | null> };
  });
