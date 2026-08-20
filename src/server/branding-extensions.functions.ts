// Server functions for Phase 6 white-label expansion:
// - listBrandVersions / rollbackBrandProfile
// - upsertCloneOverrides / clearCloneOverrides
// - registerProfileAssetVariants / listProfileAssetVariants
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listVersionsForProfile,
  rollbackProfileToVersion,
  registerAssetVariants,
  sanitizeOverrides,
  type BrandAsset,
  type CloneOverrides,
} from "./branding.server";

const STORAGE_BASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";

// ─── Versions ─────────────────────────────────────────────────────────

export const listBrandVersions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { profileId: string }) => {
    if (!data?.profileId) throw new Error("profileId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const versions = await listVersionsForProfile(context.supabase, data.profileId);
    // Round-trip through JSON to satisfy server-fn serialisation contract.
    return {
      ok: true as const,
      versions: JSON.parse(JSON.stringify(versions)) as Array<{
        id: string;
        profile_id: string;
        version: number;
        config_hash: string | null;
        notes: string | null;
        published_by: string | null;
        published_at: string;
      }>,
    };
  });

export const rollbackBrandProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { profileId: string; versionId: string }) => {
    if (!data?.profileId) throw new Error("profileId required");
    if (!data?.versionId) throw new Error("versionId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const result = await rollbackProfileToVersion(context.supabase, {
      profileId: data.profileId,
      versionId: data.versionId,
      actorUserId: context.userId,
    });
    if (!result.ok) return { ok: false as const, error: result.error };

    await context.supabase.from("audit_log").insert({
      action: "brand.profile_rolled_back",
      entity_type: "clone_brand_profile",
      entity_id: data.profileId,
      actor_user_id: context.userId,
      metadata: { version_id: data.versionId, new_version: result.newVersion ?? null },
    });
    await context.supabase.from("notifications").insert({
      kind: "library_entry_approved",
      severity: "info",
      title: "Brand profile rolled back",
      body: `Profile rolled back to a prior version. Drifted clones will re-cascade automatically.`,
      url: "/branding",
      metadata: { profile_id: data.profileId, version_id: data.versionId },
    });

    return { ok: true as const, newVersion: result.newVersion };
  });

// ─── Per-clone overrides ──────────────────────────────────────────────

export const upsertCloneOverrides = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; profileId: string; overrides: CloneOverrides }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!data?.profileId) throw new Error("profileId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const overrides = sanitizeOverrides(data.overrides);

    const { error } = await context.supabase.from("clone_brand_assignments").upsert(
      {
        clone_id: data.cloneId,
        profile_id: data.profileId,
        overrides: overrides as never,
        status: "pending",
        drift_summary: "Override changed — awaiting cascade",
      },
      { onConflict: "clone_id" },
    );
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "brand.overrides_updated",
      entity_type: "clone_brand_assignment",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        profile_id: data.profileId,
        config_keys: Object.keys(overrides.brand_config ?? {}),
        contact_keys: Object.keys(overrides.report_contact ?? {}),
      },
    });
    return { ok: true as const };
  });

export const clearCloneOverrides = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("clone_brand_assignments")
      .update({
        overrides: {} as never,
        override_keys: [],
        status: "pending",
        drift_summary: "Overrides cleared — awaiting cascade",
      })
      .eq("clone_id", data.cloneId);
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "brand.overrides_cleared",
      entity_type: "clone_brand_assignment",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
    });
    return { ok: true as const };
  });

// ─── Asset variants ───────────────────────────────────────────────────

export const registerProfileAssetVariants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { profileId: string; assets: BrandAsset[] }) => {
    if (!data?.profileId) throw new Error("profileId required");
    if (!Array.isArray(data?.assets)) throw new Error("assets required");
    return data;
  })
  .handler(async ({ data, context }) => {
    if (!STORAGE_BASE_URL) {
      return { ok: false as const, error: "Storage base URL not configured" };
    }
    const result = await registerAssetVariants(context.supabase, {
      profileId: data.profileId,
      assets: data.assets,
      storageBaseUrl: STORAGE_BASE_URL,
    });
    return { ok: true as const, ...result };
  });

export const listProfileAssetVariants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { profileId: string }) => {
    if (!data?.profileId) throw new Error("profileId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("clone_brand_asset_variants")
      .select("*")
      .eq("profile_id", data.profileId)
      .order("source_path", { ascending: true })
      .order("variant_kind", { ascending: true });
    if (error) return { ok: false as const, error: error.message, variants: [] };
    return { ok: true as const, variants: rows ?? [] };
  });

// ─── Per-clone effective bundle (preview support) ─────────────────────

export const getCloneEffectiveBundle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("clone_brand_assignments")
      .select(
        "overrides, override_keys, profile_id, clone_brand_profiles(brand_config, report_contact, asset_manifest, version, name, slug)",
      )
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!row) return { ok: false as const, error: "No assignment found" };
    return { ok: true as const, assignment: row };
  });
