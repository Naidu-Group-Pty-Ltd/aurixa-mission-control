// @ts-nocheck
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  reconcileCloneEntitlements,
  drainPlanChangeReconciliations,
  seedPricingModuleMap,
  resolveClonePlan,
  classifyChange,
} from "./entitlement-modules.server";
import { resolveEntitledModules, buildFullMapping } from "@/lib/pricing/module-mapping";

/**
 * Bring one clone's installed modules in line with its billing plan.
 * `dryRun` reports the diff without writing.
 */
export const reconcileClone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; planSlug?: string; dryRun?: boolean }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) =>
    reconcileCloneEntitlements({
      supabase: context.supabase,
      options: {
        cloneId: data.cloneId,
        planSlug: data.planSlug,
        dryRun: data.dryRun ?? false,
        userId: context.userId,
      },
    }),
  );

/** Process every plan change whose modules have not been reconciled yet. */
export const drainPlanChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { limit?: number }) => data ?? {})
  .handler(async ({ data, context }) => {
    const res = await drainPlanChangeReconciliations({
      supabase: context.supabase,
      limit: data.limit ?? 25,
      userId: context.userId,
    });
    return {
      ok: true as const,
      processed: res.processed,
      failed: res.results.filter((r) => !r.ok).length,
      results: res.results,
    };
  });

/** Refresh the derived mapping, preserving operator overrides. */
export const seedModuleMap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const res = await seedPricingModuleMap({ supabase: context.supabase, userId: context.userId });
    return { ok: true as const, ...res };
  });

/** The mapping table, for the operator-facing editor. */
export const getModuleMap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("pricing_module_map")
      .select("*")
      .order("source_kind", { ascending: true })
      .order("source_slug", { ascending: true })
      .order("source_name", { ascending: true });
    if (error) return { ok: false as const, error: error.message, rows: [] };
    return { ok: true as const, rows: data ?? [] };
  });

/** Take operator ownership of one mapping row. */
export const overrideModuleMap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; moduleSlugs: string[]; mappingKind?: string }) => {
    if (!data?.id) throw new Error("id required");
    if (!Array.isArray(data.moduleSlugs)) throw new Error("moduleSlugs required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("pricing_module_map")
      .update({
        module_slugs: data.moduleSlugs,
        mapping_kind: data.mappingKind ?? (data.moduleSlugs.length > 0 ? "installs" : "unmapped"),
        confidence: "manual",
        is_override: true,
        overridden_by: context.userId,
        overridden_at: new Date().toISOString(),
        reason: "Set by operator",
      })
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "pricing_module_map.override",
      entity_type: "pricing_module_map",
      entity_id: data.id,
      actor_user_id: context.userId,
      metadata: { module_slugs: data.moduleSlugs },
    });

    return { ok: true as const };
  });

/** Release an operator override so the row tracks the derived mapping again. */
export const clearModuleMapOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("pricing_module_map")
      .update({ is_override: false, overridden_by: null, overridden_at: null })
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

/**
 * Which technical modules a tier entitles a clone to — used by the clone
 * creation wizard to pre-select modules instead of making an operator tick
 * seventy-five boxes from memory.
 */
export const previewTierModules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { planSlug: string; purchasedAddons?: string[] }) => {
    if (!data?.planSlug) throw new Error("planSlug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const [{ data: modules }, { data: overrideRows }] = await Promise.all([
      context.supabase.from("modules").select("id, slug, name, layer").neq("status", "archived"),
      context.supabase
        .from("pricing_module_map")
        .select("source_kind, source_slug, source_name, module_slugs")
        .eq("is_override", true),
    ]);

    const known = new Set((modules ?? []).map((m) => m.slug as string));

    const overrides: Record<string, string[]> = {};
    for (const r of overrideRows ?? []) {
      const key =
        r.source_kind === "tier"
          ? `tier:${r.source_slug}:${String(r.source_name)
              .toLowerCase()
              .replace(/\//g, " ")
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")}`
          : `module:${r.source_slug}`;
      overrides[key] = (r.module_slugs as string[]) ?? [];
    }

    const resolution = resolveEntitledModules({
      planSlug: data.planSlug,
      purchasedAddons: data.purchasedAddons ?? [],
      knownModules: known,
      overrides,
    });

    const idBySlug = new Map((modules ?? []).map((m) => [m.slug as string, m.id as string]));

    return {
      ok: true as const,
      ...resolution,
      moduleIds: resolution.moduleSlugs
        .map((s) => idBySlug.get(s))
        .filter((id): id is string => Boolean(id)),
    };
  });

/** Per-clone entitlement state plus its reconciliation history. */
export const getCloneEntitlements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const [{ data: clone }, { data: history }, plan] = await Promise.all([
      context.supabase
        .from("clones")
        .select(
          "id, name, entitled_plan_slug, entitled_module_slugs, revoked_module_slugs, " +
            "purchased_addon_slugs, entitlement_keys, entitlements_synced_at",
        )
        .eq("id", data.cloneId)
        .maybeSingle(),
      context.supabase
        .from("clone_entitlement_reconciliations")
        .select("*")
        .eq("clone_id", data.cloneId)
        .order("created_at", { ascending: false })
        .limit(20),
      resolveClonePlan(context.supabase, data.cloneId),
    ]);

    if (!clone) return { ok: false as const, error: "Clone not found" };

    return {
      ok: true as const,
      clone,
      currentPlanSlug: plan.planSlug,
      /** Non-null when the live plan has drifted from the last reconciliation. */
      pendingDirection:
        plan.planSlug && plan.planSlug !== clone.entitled_plan_slug
          ? classifyChange(clone.entitled_plan_slug, plan.planSlug)
          : null,
      history: history ?? [],
    };
  });

/** Set the priced add-ons a clone has bought on top of its tier. */
export const setCloneAddons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; addonSlugs: string[] }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!Array.isArray(data.addonSlugs)) throw new Error("addonSlugs required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("clones")
      .update({ purchased_addon_slugs: data.addonSlugs })
      .eq("id", data.cloneId);
    if (error) return { ok: false as const, error: error.message };

    // Applying the purchase immediately is the point — an add-on the customer
    // has paid for should not wait for the next plan change to arrive.
    return reconcileCloneEntitlements({
      supabase: context.supabase,
      options: { cloneId: data.cloneId, userId: context.userId, direction: "manual" },
    });
  });

/** The derived mapping, without touching the database — for previews. */
export const previewDerivedMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: modules } = await context.supabase
      .from("modules")
      .select("slug")
      .neq("status", "archived");
    const known = new Set((modules ?? []).map((m) => m.slug as string));
    return { ok: true as const, rows: buildFullMapping(known) };
  });
