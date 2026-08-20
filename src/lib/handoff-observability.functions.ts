// G20 — Post-handoff observability admin surface.
// Server functions that configure how Mission Control stays informed after
// the client owns their backend, plus manual poll + beacon listing.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

export const OBSERVABILITY_MODES = [
  "pat_polling",
  "health_beacons",
  "shared_role",
  "dropped",
] as const;

export const upsertObservabilityConfig = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        mode: z.enum(OBSERVABILITY_MODES),
        poll_interval_seconds: z
          .number()
          .int()
          .min(60)
          .max(24 * 60 * 60)
          .optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: h, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, clone_id")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!h) return { ok: false as const, error: "handoff_not_found" };

    const poll = data.poll_interval_seconds ?? 900;
    const nextPoll = data.mode === "pat_polling" ? new Date().toISOString() : null;

    const { data: existing } = await context.supabase
      .from("handoff_observability_configs")
      .select("id")
      .eq("handoff_id", data.handoff_id)
      .maybeSingle();

    if (existing) {
      const { error } = await context.supabase
        .from("handoff_observability_configs")
        .update({
          mode: data.mode,
          poll_interval_seconds: poll,
          notes: data.notes ?? null,
          next_poll_at: nextPoll,
        })
        .eq("id", existing.id);
      if (error) throw error;
      return { ok: true as const, id: existing.id, updated: true };
    }

    const { data: row, error } = await context.supabase
      .from("handoff_observability_configs")
      .insert({
        handoff_id: data.handoff_id,
        clone_id: h.clone_id,
        mode: data.mode,
        poll_interval_seconds: poll,
        next_poll_at: nextPoll,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw error;

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "observability.configured",
      actor_user_id: context.userId,
      details: { mode: data.mode, poll_interval_seconds: poll },
    });

    return { ok: true as const, id: row.id, updated: false };
  });

export const getObservabilityStatus = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        beacon_limit: z.number().int().min(1).max(50).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const [{ data: config }, { data: beacons }] = await Promise.all([
      context.supabase
        .from("handoff_observability_configs")
        .select("*")
        .eq("handoff_id", data.handoff_id)
        .maybeSingle(),
      context.supabase
        .from("clone_health_beacons")
        .select(
          "id, source, reported_at, project_status, severity, message, db_size_bytes, active_connections, storage_used_bytes",
        )
        .eq("handoff_id", data.handoff_id)
        .order("reported_at", { ascending: false })
        .limit(data.beacon_limit ?? 10),
    ]);
    return { config: config ?? null, beacons: beacons ?? [] };
  });

export const pollObservabilityNow = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { pollClientBackendHealth } = await import("@/server/handoff-observability.server");
    return await pollClientBackendHealth(data.handoff_id);
  });
