// Operator entry point for putting the top-up ladder on sale. Preview is free
// and touches nothing; applying creates live Stripe prices, flips the packs
// active and takes the superseded ones off sale — so, like the seat-plan
// cutover, it is gated to super admins rather than to the admins who manage
// day-to-day catalog entries.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperAdmin } from "@/integrations/supabase/role-middleware";
import { applyPackSync, loadPackRows, planPackSync } from "@/server/stripe-pack-sync.server";

export const previewPackSync = createServerFn({ method: "GET" })
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      const plan = planPackSync(await loadPackRows());
      return { ok: true as const, ...plan };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const runPackSync = createServerFn({ method: "POST" })
  .inputValidator((i) => z.object({ confirm: z.literal(true) }).parse(i))
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      const rows = await loadPackRows();
      const plan = planPackSync(rows);
      // The only warning the planner raises is a missing catalog row, which
      // means the migration has not run. Applying anyway would put a subset of
      // the ladder on sale and silently drop the rest.
      if (plan.warnings.length) {
        return { ok: false as const, error: plan.warnings.join(" ") };
      }
      const result = await applyPackSync(plan, rows);
      return {
        ok: result.errors.length === 0,
        // Surface what Stripe or Postgres actually objected to. Without it the
        // card can only say "failed", which is what made the last cutover
        // failure so hard to act on.
        error: result.errors.length ? result.errors.join(" · ") : undefined,
        ...result,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
