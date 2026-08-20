// Phase 10 — Operator UX server functions:
// - brand version diff
// - bulk cascade approvals
// - audit log export (paginated batch fetch)
// - bulk clone ops (delete)
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ─── Brand version diff ──────────────────────────────────────────────
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

function diffJson(
  a: unknown,
  b: unknown,
  path = "",
): Array<{ path: string; before: unknown; after: unknown; kind: "added" | "removed" | "changed" }> {
  const out: Array<{
    path: string;
    before: unknown;
    after: unknown;
    kind: "added" | "removed" | "changed";
  }> = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const sub = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: sub, before: undefined, after: b[k], kind: "added" });
      else if (!(k in b)) out.push({ path: sub, before: a[k], after: undefined, kind: "removed" });
      else out.push(...diffJson(a[k], b[k], sub));
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: path || "$", before: a, after: b, kind: "changed" });
  }
  return out;
}

export const diffBrandVersions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string; versionA: string; versionB: string }) =>
    z
      .object({
        profileId: z.string().uuid(),
        versionA: z.string().uuid(),
        versionB: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("clone_brand_versions")
      .select("id, version, brand_config, report_contact, asset_manifest, published_at")
      .eq("profile_id", data.profileId)
      .in("id", [data.versionA, data.versionB]);
    if (error) return { ok: false as const, error: error.message };
    if (!rows || rows.length !== 2)
      return { ok: false as const, error: "Could not load both versions" };
    const a = rows.find((r) => r.id === data.versionA)!;
    const b = rows.find((r) => r.id === data.versionB)!;
    const diff = [
      ...diffJson(a.brand_config as Json, b.brand_config as Json, "brand_config"),
      ...diffJson(a.report_contact as Json, b.report_contact as Json, "report_contact"),
      ...diffJson(a.asset_manifest as Json, b.asset_manifest as Json, "asset_manifest"),
    ];
    const safeDiff = diff.map((d) => ({
      path: d.path,
      kind: d.kind,
      before: d.before === undefined ? null : (JSON.stringify(d.before) ?? "null"),
      after: d.after === undefined ? null : (JSON.stringify(d.after) ?? "null"),
    }));
    return {
      ok: true as const,
      a: { id: a.id, version: a.version, published_at: a.published_at },
      b: { id: b.id, version: b.version, published_at: b.published_at },
      diff: safeDiff,
    };
  });

// ─── Pending cascade approvals (queue) ────────────────────────────────

export const listPendingApprovals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("cascade_events")
      .select(
        "id, mode, summary, source_branch, source_sha, initiated_by, created_at, requires_approval, approved_at, scope_filter",
      )
      .eq("requires_approval", true)
      .is("approved_at", null)
      .neq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { ok: false as const, error: error.message, events: [] };
    return { ok: true as const, events: data ?? [] };
  });

// ─── Bulk clone delete (admin only — RLS enforces) ────────────────────

export const bulkDeleteClones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[] }) =>
    z.object({ cloneIds: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of data.cloneIds) {
      const { error } = await supabase.from("clones").delete().eq("id", id);
      results.push({ id, ok: !error, error: error?.message });
    }
    await supabase.from("audit_log").insert({
      action: "clones.bulk_deleted",
      entity_type: "clone",
      actor_user_id: userId,
      metadata: { count: data.cloneIds.length, results },
    });
    return { ok: true as const, results };
  });

// ─── Bulk pause / resume (uses sync_status enum: 'unknown' as paused proxy) ──
// We track paused state via a metadata note, since the sync_status enum has
// no dedicated value. The UI shows a "paused" pill when notes contain a tag.

const PAUSE_TAG = "[paused]";

export const bulkPauseClones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[]; pause: boolean }) =>
    z.object({ cloneIds: z.array(z.string().uuid()).min(1).max(100), pause: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: clones } = await supabase
      .from("clones")
      .select("id, notes")
      .in("id", data.cloneIds);
    const updates = (clones ?? []).map(async (c) => {
      const existing = (c.notes ?? "").replace(PAUSE_TAG, "").trim();
      const next = data.pause ? `${PAUSE_TAG} ${existing}`.trim() : existing;
      await supabase
        .from("clones")
        .update({ notes: next || null })
        .eq("id", c.id);
    });
    await Promise.all(updates);
    await supabase.from("audit_log").insert({
      action: data.pause ? "clones.bulk_paused" : "clones.bulk_resumed",
      entity_type: "clone",
      actor_user_id: userId,
      metadata: { count: data.cloneIds.length, ids: data.cloneIds },
    });
    return { ok: true as const, count: data.cloneIds.length };
  });

export const bulkReprovisionBackends = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[] }) =>
    z.object({ cloneIds: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("clone_backends")
      .update({
        status: "pending" as const,
        error_message: null,
        status_detail: "Re-queued by bulk reprovision",
      })
      .in("clone_id", data.cloneIds)
      .in("status", ["failed", "ready"] as const);
    await supabase.from("audit_log").insert({
      action: "clones.bulk_reprovision_queued",
      entity_type: "clone_backend",
      actor_user_id: userId,
      metadata: { count: data.cloneIds.length, ids: data.cloneIds },
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, count: data.cloneIds.length };
  });

// ─── Audit log export (CSV-friendly batch) ────────────────────────────

export const exportAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      sinceIso?: string;
      untilIso?: string;
      action?: string;
      entity?: string;
      limit?: number;
    }) =>
      z
        .object({
          sinceIso: z.string().optional(),
          untilIso: z.string().optional(),
          action: z.string().optional(),
          entity: z.string().optional(),
          limit: z.number().int().min(1).max(5000).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from("audit_log")
      .select("id, created_at, action, entity_type, entity_id, actor_user_id, metadata")
      .order("created_at", { ascending: false })
      .limit(Math.min(data.limit ?? 2000, 5000));
    if (data.sinceIso) q = q.gte("created_at", data.sinceIso);
    if (data.untilIso) q = q.lte("created_at", data.untilIso);
    if (data.action && data.action !== "all") q = q.eq("action", data.action);
    if (data.entity && data.entity !== "all") q = q.eq("entity_type", data.entity);
    const { data: rows, error } = await q;
    if (error) return { ok: false as const, error: error.message, rows: [] };
    return { ok: true as const, rows: rows ?? [] };
  });
