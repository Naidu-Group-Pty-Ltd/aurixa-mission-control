// Phase 11 — Reliability server functions:
// - SLO computation from clone_health_snapshots
// - Module library deprecation
// - Brand drift severity timeseries
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ─── SLO surface ──────────────────────────────────────────────────────

export const computeFleetSlo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { windowDays?: number }) =>
    z.object({ windowDays: z.number().int().min(1).max(90).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const days = data.windowDays ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: snapshots } = await supabase
      .from("clone_health_snapshots")
      .select("clone_id, payload, probed_at")
      .gte("probed_at", since)
      .order("probed_at", { ascending: true });

    const byClone = new Map<string, { up: number; total: number; lastStatus?: string }>();
    for (const s of snapshots ?? []) {
      const payload = (s.payload ?? {}) as Record<string, unknown>;
      const status = String(payload.status ?? payload.health ?? "unknown");
      const ok = ["ok", "up", "healthy", "ready", "active"].includes(status.toLowerCase());
      const prev = byClone.get(s.clone_id) ?? { up: 0, total: 0 };
      prev.total += 1;
      if (ok) prev.up += 1;
      prev.lastStatus = status;
      byClone.set(s.clone_id, prev);
    }
    const { data: clones } = await supabase.from("clones").select("id, name, slug");
    const cloneSlo = (clones ?? []).map((c) => {
      const stat = byClone.get(c.id);
      const uptime = stat && stat.total > 0 ? stat.up / stat.total : null;
      return {
        clone_id: c.id,
        name: c.name,
        slug: c.slug,
        uptime_pct: uptime === null ? null : Math.round(uptime * 10000) / 100,
        samples: stat?.total ?? 0,
        last_status: stat?.lastStatus ?? "unknown",
      };
    });
    const samplesTotal = cloneSlo.reduce((s, c) => s + c.samples, 0);
    const upTotal = (snapshots ?? []).filter((s) => {
      const p = (s.payload ?? {}) as Record<string, unknown>;
      const st = String(p.status ?? p.health ?? "").toLowerCase();
      return ["ok", "up", "healthy", "ready", "active"].includes(st);
    }).length;
    const fleetUptime =
      samplesTotal > 0 ? Math.round((upTotal / samplesTotal) * 10000) / 100 : null;

    return {
      ok: true as const,
      windowDays: days,
      fleetUptime,
      samplesTotal,
      clones: cloneSlo.sort((a, b) => (a.uptime_pct ?? 0) - (b.uptime_pct ?? 0)),
    };
  });

// ─── Module library deprecation ───────────────────────────────────────

export const deprecateLibraryEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { entryId: string; reason: string; replacementSlug?: string }) =>
    z
      .object({
        entryId: z.string().uuid(),
        reason: z.string().min(2).max(500),
        replacementSlug: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("module_library")
      .update({
        deprecated_at: new Date().toISOString(),
        deprecated_reason: data.reason,
        replacement_slug: data.replacementSlug ?? null,
      })
      .eq("id", data.entryId);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "module_library.deprecated",
      entity_type: "module_library",
      entity_id: data.entryId,
      actor_user_id: userId,
      metadata: { reason: data.reason, replacement_slug: data.replacementSlug ?? null },
    });
    return { ok: true as const };
  });

export const undeprecateLibraryEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { entryId: string }) => z.object({ entryId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("module_library")
      .update({ deprecated_at: null, deprecated_reason: null, replacement_slug: null })
      .eq("id", data.entryId);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "module_library.undeprecated",
      entity_type: "module_library",
      entity_id: data.entryId,
      actor_user_id: userId,
    });
    return { ok: true as const };
  });

// ─── Brand drift severity timeseries ──────────────────────────────────

export const brandDriftTimeseries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { days?: number }) =>
    z.object({ days: z.number().int().min(1).max(90).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const days = data.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows } = await supabase
      .from("clone_brand_assignments")
      .select("status, last_drift_check_at, updated_at")
      .gte("updated_at", since);
    // bucket by day, severity ~= status mapping
    const buckets = new Map<
      string,
      { date: string; pending: number; drifted: number; failed: number; applied: number }
    >();
    for (const r of rows ?? []) {
      const ts = r.last_drift_check_at ?? r.updated_at;
      if (!ts) continue;
      const date = ts.slice(0, 10);
      const cur = buckets.get(date) ?? { date, pending: 0, drifted: 0, failed: 0, applied: 0 };
      const status = String(r.status ?? "");
      if (status === "pending") cur.pending += 1;
      else if (status === "drifted") cur.drifted += 1;
      else if (status === "failed") cur.failed += 1;
      else if (status === "applied") cur.applied += 1;
      buckets.set(date, cur);
    }
    const series = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
    return { ok: true as const, days, series };
  });
