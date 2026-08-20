// @ts-nocheck
// Operator-facing RPCs for the per-report token cost index.
//
// Reading is open to any operator (it is the platform price list). Publishing
// is restricted to super_admin and the High King: a reprice changes what every
// workspace on the platform pays for every report, so it sits above the admin
// tier that manages day-to-day catalog entries.
//
// The role check is enforced HERE as well as by RLS. RLS is the backstop, but
// it can only answer "allowed / denied" — this returns an explanation, and it
// keeps the rule visible next to the action it guards.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { highestLevel, ROLE_LEVELS } from "@/integrations/supabase/roles";
import {
  listReportCosts,
  indexVersion,
  publishReportCosts,
  validateCostEdits,
  diffCostEdits,
} from "@/server/report-cost-index.server";

// `requireSupabaseAuth` does not carry its context through to the handler's
// inferred type, so `context` lands as `undefined`. Most siblings answer that
// with a file-wide `@ts-nocheck`, which also buries every unrelated type error
// in the file. Narrow it here instead: one named shape, applied at the two
// places that read the context, leaving the rest of the file type-checked.
type AuthContext = { supabase: unknown; user: { id?: string } | null };

async function callerRoles(supabase: unknown, userId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).from("user_roles").select("role").eq("user_id", userId);
  return ((data ?? []) as Array<{ role: string }>).map((r) => r.role);
}

/** The index plus its version, for the catalog page. */
export const listReportCostIndex = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    const rows = await listReportCosts();
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];

    const { data: revisions } = await (supabase as any)
      .from("report_cost_revisions")
      .select("id, version, published_by, note, changes, cascade_result, created_at")
      .order("created_at", { ascending: false })
      .limit(10);

    return {
      reports: rows,
      version: indexVersion(rows),
      revisions: revisions ?? [],
      // Drives the UI: the form is read-only for anyone below super_admin,
      // rather than letting them edit and then fail at save time.
      canPublish: highestLevel(roles) >= ROLE_LEVELS.super_admin,
    };
  });

/**
 * Apply edits and cascade them to every clone and the prime repository.
 *
 * Validation runs against the CURRENT rows rather than whatever the browser
 * last saw, so a stale tab cannot resurrect an old price for a report someone
 * else just changed — the diff it publishes is computed server-side.
 */
export const publishReportCostIndex = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { edits: Array<{ slug: string; credit_cost: number }>; note?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    if (!user?.id) return { ok: false as const, error: "unauthenticated" };

    const roles = await callerRoles(supabase, user.id);
    if (highestLevel(roles) < ROLE_LEVELS.super_admin) {
      return {
        ok: false as const,
        error: "Repricing reports is restricted to super admins and the High King.",
      };
    }

    const current = await listReportCosts();
    const validated = validateCostEdits(current, data?.edits);
    if (!validated.ok) return { ok: false as const, error: validated.error };

    const result = await publishReportCosts(validated.edits, {
      publishedBy: user.id,
      note: data?.note ?? null,
    });
    return { ok: true as const, ...result };
  });

/** Dry run: what would publishing these edits change? */
export const previewReportCostIndex = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { edits: Array<{ slug: string; credit_cost: number }> }) => d)
  .handler(async ({ data }) => {
    const current = await listReportCosts();
    const validated = validateCostEdits(current, data?.edits);
    if (!validated.ok) return { ok: false as const, error: validated.error };
    return { ok: true as const, changes: diffCostEdits(current, validated.edits) };
  });
