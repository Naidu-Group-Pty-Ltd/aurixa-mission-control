import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cloudflareApi, CloudflareError } from "./cloudflare/client";

async function audit(
  supabase: any,
  args: {
    clone_id?: string;
    zone_id?: string;
    action: string;
    payload?: any;
    result?: any;
    success: boolean;
    error?: string;
    actor: string | null;
  },
) {
  await supabase.from("cloudflare_audit").insert({
    clone_id: args.clone_id ?? null,
    zone_id: args.zone_id ?? null,
    action: args.action,
    payload: args.payload ?? {},
    result: args.result ?? {},
    success: args.success,
    error_message: args.error ?? null,
    actor_user_id: args.actor,
  });
}

export const cfTokenStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    if (!process.env.CLOUDFLARE_API_TOKEN) {
      return { configured: false as const, valid: false as const };
    }
    try {
      const r = await cloudflareApi.verifyToken();
      return { configured: true as const, valid: r.status === "active", status: r.status };
    } catch (e) {
      return {
        configured: true as const,
        valid: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

export const cfListZones = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    if (!process.env.CLOUDFLARE_API_TOKEN) return { zones: [], configured: false };
    try {
      const zones = await cloudflareApi.listZones();
      return { zones, configured: true };
    } catch (e) {
      return { zones: [], configured: true, error: e instanceof Error ? e.message : String(e) };
    }
  });

export const cfAttachZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneId: string; zoneId: string }) =>
    z.object({ cloneId: z.string().uuid(), zoneId: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    try {
      const zone = await cloudflareApi.getZone(data.zoneId);
      const { error } = await supabase.from("cloudflare_clone_config").upsert(
        {
          clone_id: data.cloneId,
          account_id: zone.account.id,
          zone_id: zone.id,
          zone_name: zone.name,
          plan: zone.plan?.name ?? null,
          status: zone.status,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "clone_id" },
      );
      if (error) throw new Error(error.message);
      await supabase
        .from("clones")
        .update({ cloudflare_enabled: true, cloudflare_zone_id: zone.id })
        .eq("id", data.cloneId);
      await audit(supabase, {
        clone_id: data.cloneId,
        zone_id: zone.id,
        action: "attach_zone",
        success: true,
        actor: userId,
      });
      return { ok: true, zone };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit(supabase, {
        clone_id: data.cloneId,
        zone_id: data.zoneId,
        action: "attach_zone",
        success: false,
        error: msg,
        actor: userId,
      });
      throw new Error(msg);
    }
  });

export const cfSeedZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      cloneId: string;
      zoneId: string;
      zoneName: string;
      accountId?: string;
      plan?: string;
      securityLevel?: "off" | "essentially_off" | "low" | "medium" | "high" | "under_attack";
      botFight?: boolean;
      rateLimitRps?: number;
      wafPreset?: "lenient" | "balanced" | "strict";
    }) =>
      z
        .object({
          cloneId: z.string().uuid(),
          zoneId: z.string().min(1),
          zoneName: z.string().min(1),
          accountId: z.string().optional(),
          plan: z.string().optional(),
          securityLevel: z
            .enum(["off", "essentially_off", "low", "medium", "high", "under_attack"])
            .optional(),
          botFight: z.boolean().optional(),
          rateLimitRps: z.number().int().min(0).max(10000).optional(),
          wafPreset: z.enum(["lenient", "balanced", "strict"]).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    try {
      const { error } = await supabase.from("cloudflare_clone_config").upsert(
        {
          clone_id: data.cloneId,
          account_id: data.accountId ?? "manual",
          zone_id: data.zoneId,
          zone_name: data.zoneName,
          plan: data.plan ?? null,
          status: "manual",
          security_level: data.securityLevel ?? null,
          bot_fight_mode: data.botFight ?? false,
          rate_limit_rps: data.rateLimitRps ?? null,
          waf_preset: data.wafPreset ?? null,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "clone_id" },
      );
      if (error) throw new Error(error.message);
      await supabase
        .from("clones")
        .update({ cloudflare_enabled: true, cloudflare_zone_id: data.zoneId })
        .eq("id", data.cloneId);
      await audit(supabase, {
        clone_id: data.cloneId,
        zone_id: data.zoneId,
        action: "seed_zone_manual",
        payload: data,
        success: true,
        actor: userId,
      });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit(supabase, {
        clone_id: data.cloneId,
        zone_id: data.zoneId,
        action: "seed_zone_manual",
        payload: data,
        success: false,
        error: msg,
        actor: userId,
      });
      throw new Error(msg);
    }
  });

export const cfDetachZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await supabase.from("cloudflare_clone_config").delete().eq("clone_id", data.cloneId);
    await supabase
      .from("clones")
      .update({ cloudflare_enabled: false, cloudflare_zone_id: null })
      .eq("id", data.cloneId);
    await audit(supabase, {
      clone_id: data.cloneId,
      action: "detach_zone",
      success: true,
      actor: userId,
    });
    return { ok: true };
  });

export const cfApplyPosture = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      cloneId: string;
      securityLevel?: "off" | "essentially_off" | "low" | "medium" | "high" | "under_attack";
      botFight?: boolean;
      rateLimitRps?: number;
      wafPreset?: "lenient" | "balanced" | "strict";
    }) =>
      z
        .object({
          cloneId: z.string().uuid(),
          securityLevel: z
            .enum(["off", "essentially_off", "low", "medium", "high", "under_attack"])
            .optional(),
          botFight: z.boolean().optional(),
          rateLimitRps: z.number().int().min(0).max(10000).optional(),
          wafPreset: z.enum(["lenient", "balanced", "strict"]).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cfg } = await supabase
      .from("cloudflare_clone_config")
      .select("zone_id")
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    if (!cfg) throw new Error("Clone not attached to a Cloudflare zone");

    const ops: string[] = [];
    try {
      if (data.securityLevel) {
        await cloudflareApi.setSecurityLevel(cfg.zone_id, data.securityLevel);
        ops.push(`security_level=${data.securityLevel}`);
      }
      if (typeof data.botFight === "boolean") {
        await cloudflareApi.setBotFightMode(cfg.zone_id, data.botFight);
        ops.push(`bot_fight=${data.botFight}`);
      }
      await supabase
        .from("cloudflare_clone_config")
        .update({
          security_level: data.securityLevel ?? undefined,
          bot_fight_mode: data.botFight ?? undefined,
          rate_limit_rps: data.rateLimitRps ?? undefined,
          waf_preset: data.wafPreset ?? undefined,
          last_synced_at: new Date().toISOString(),
        })
        .eq("clone_id", data.cloneId);
      await audit(supabase, {
        clone_id: data.cloneId,
        zone_id: cfg.zone_id,
        action: "apply_posture",
        payload: data,
        success: true,
        actor: userId,
      });
      return { ok: true, applied: ops };
    } catch (e) {
      const msg = e instanceof CloudflareError ? e.message : (e as Error).message;
      await audit(supabase, {
        clone_id: data.cloneId,
        zone_id: cfg.zone_id,
        action: "apply_posture",
        payload: data,
        success: false,
        error: msg,
        actor: userId,
      });
      throw new Error(msg);
    }
  });

type CloudflareZoneAnalytics = {
  clone_id: string;
  zone_name: string;
  requests: number;
  threats: number;
  bandwidth: number;
  error?: boolean;
};

export const cfFleetAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data: configs } = await supabase
      .from("cloudflare_clone_config")
      .select(
        "clone_id, zone_id, zone_name, security_level, bot_fight_mode, rate_limit_rps, waf_preset, status, last_synced_at",
      );
    const list = configs ?? [];
    // Typed explicitly: a bare `[]` here is `never[]`, and the union of the two
    // return shapes then gives every consumer of `analytics` an element type of
    // `never` — which is why the fleet page could not read `a.clone_id`.
    if (!process.env.CLOUDFLARE_API_TOKEN)
      return { configs: list, analytics: [] as CloudflareZoneAnalytics[], configured: false };

    const analytics = await Promise.all(
      list.slice(0, 20).map(async (c) => {
        try {
          const a = await cloudflareApi.getAnalytics(c.zone_id, 24);
          return {
            clone_id: c.clone_id,
            zone_name: c.zone_name,
            requests: a.totals.requests.all,
            threats: a.totals.threats.all,
            bandwidth: a.totals.bandwidth.all,
          };
        } catch {
          return {
            clone_id: c.clone_id,
            zone_name: c.zone_name,
            requests: 0,
            threats: 0,
            bandwidth: 0,
            error: true,
          };
        }
      }),
    );
    return { configs: list, analytics, configured: true };
  });
