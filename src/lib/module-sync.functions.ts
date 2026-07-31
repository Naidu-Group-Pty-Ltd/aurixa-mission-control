// Operator entry point for putting the add-on modules on sale. Preview is free
// and touches nothing; applying creates live Stripe products and recurring
// prices and links the catalog rows to them — so, like the seat-plan and
// top-up cutovers, it is gated to super admins rather than to the admins who
// manage day-to-day catalog entries.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperAdmin } from "@/integrations/supabase/role-middleware";
import {
  applyModuleSync,
  loadModuleRows,
  planModuleSync,
} from "@/server/stripe-module-sync.server";

export const previewModuleSync = createServerFn({ method: "GET" })
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      const plan = planModuleSync(await loadModuleRows());
      return { ok: true as const, ...plan };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const runModuleSync = createServerFn({ method: "POST" })
  .inputValidator((i) => z.object({ confirm: z.literal(true) }).parse(i))
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      const rows = await loadModuleRows();
      const plan = planModuleSync(rows);
      // The only warning the planner raises is a missing catalog row, which
      // means the price-list migration has not run. Applying anyway would put
      // a subset of the modules on sale and silently drop the rest.
      if (plan.warnings.length) {
        return { ok: false as const, error: plan.warnings.join(" ") };
      }
      const result = await applyModuleSync(plan, rows);
      return {
        ok: result.errors.length === 0,
        // Surface what Stripe or Postgres actually objected to. Without it the
        // card can only say "failed", which is no use to an operator.
        error: result.errors.length ? result.errors.join(" · ") : undefined,
        ...result,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
