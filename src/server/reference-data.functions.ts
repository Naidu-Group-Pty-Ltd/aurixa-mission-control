import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { runReferenceDataSync } from "./reference-data.server";
import { REFERENCE_TABLES } from "./referenceTables.pure";

/**
 * Operator-triggered reference-data seeding.
 *
 * The same engine the hourly job runs, called with a shorter budget because a
 * person is watching a spinner rather than a cron waiting on a 120 s timeout.
 * It is deliberately not a second implementation: a button and a schedule that
 * disagree about what a clone is owed is the failure this repo has already had
 * once, in the fleet migration sync.
 *
 * There is no `tables` parameter and there will not be one. The set that may be
 * copied is the allow-list in `referenceTables.pure.ts`; letting a request name
 * a table would make the allow-list advisory, and the whole point is that it is
 * not.
 */
export const syncCloneReferenceData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId?: string } | undefined) => ({ cloneId: d?.cloneId }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    try {
      const result = await runReferenceDataSync(supabase, {
        ...(data.cloneId ? { cloneId: data.cloneId } : {}),
        // Under the browser's patience and under the server function timeout.
        // A run that stops early is resumed by the next press or the next tick,
        // so a short budget costs a round trip and never costs progress.
        budgetMs: 45_000,
        actorUserId: userId,
      });
      return { ok: true as const, ...result };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Reference data sync failed",
      };
    }
  });

/**
 * What the allow-list says, for a surface that wants to show it.
 *
 * Read-only and derived from the same module the copier uses, so an operator
 * looking at "which tables can travel" is reading the actual rule rather than a
 * description of it that can drift.
 */
export const getReferenceTableCatalogue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => ({
    tables: REFERENCE_TABLES.map((t) => ({
      table: t.table,
      reason: t.reason,
      nulled: Object.entries(t.columns)
        .filter(([, c]) => c.policy === "null_on_copy")
        .map(([name]) => name),
      kept: Object.entries(t.columns)
        .filter(([, c]) => c.policy === "keep")
        .map(([name]) => name),
    })),
  }));
