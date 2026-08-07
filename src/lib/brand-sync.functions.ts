// Operator entry point for putting the Aurixa brand onto the Stripe account.
//
// Preview reads the live account and touches nothing. Applying uploads two
// images to Stripe and rewrites `account.settings.branding`, which changes what
// every customer sees on their next receipt, invoice and checkout — so it is
// gated to super admins, like the catalog cutovers, rather than to the admins
// who manage day-to-day catalog entries.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperAdmin } from "@/integrations/supabase/role-middleware";
import { applyBrandSync, planBrandSync } from "@/server/stripe-branding.server";

export const previewBrandSync = createServerFn({ method: "GET" })
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      return { ok: true as const, ...(await planBrandSync()) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const runBrandSync = createServerFn({ method: "POST" })
  .inputValidator((i) => z.object({ confirm: z.literal(true) }).parse(i))
  .middleware([requireSuperAdmin])
  .handler(async () => {
    try {
      // Re-plan rather than trusting the plan the browser last saw: the only
      // blocking condition is an unreachable brand asset, and that can change
      // between the operator pressing Preview and pressing Apply.
      const plan = await planBrandSync();
      if (plan.warnings.length) {
        return { ok: false as const, error: plan.warnings.join(" · ") };
      }
      const result = await applyBrandSync();
      return {
        ok: result.ok,
        error: result.errors.length ? result.errors.join(" · ") : undefined,
        ...result,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
