// Operator entry point for moving the seat-plan tiers onto the signed-off
// price list. Preview is free and touches nothing; applying creates live
// Stripe prices and repoints the catalog, so it is gated to super admins —
// a tier above the admins who manage day-to-day catalog entries, matching the
// report cost index.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperAdmin } from "@/integrations/supabase/role-middleware";
import {
  applyCatalogSync,
  loadPlanRows,
  planCatalogSync,
} from "@/server/stripe-catalog-sync.server";

export const previewCatalogSync = createServerFn({ method: "GET" })
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      const plan = planCatalogSync(await loadPlanRows());
      return { ok: true as const, ...plan };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const runCatalogSync = createServerFn({ method: "POST" })
  .inputValidator((i) => z.object({ confirm: z.literal(true) }).parse(i))
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      const rows = await loadPlanRows();
      const plan = planCatalogSync(rows);
      if (plan.warnings.length) {
        return { ok: false as const, error: plan.warnings.join(" ") };
      }
      const result = await applyCatalogSync(plan, rows);
      return {
        ok: result.errors.length === 0,
        // Surface the reason. Without this the card could only say "Sync
        // failed" and an operator had no way to see what Stripe or Postgres
        // actually objected to.
        error: result.errors.length ? result.errors.join(" · ") : undefined,
        ...result,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
