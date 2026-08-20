import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { executeCascade } from "./cascade-engine.server";

// User-facing wrapper around the cascade engine. The webhook receiver and
// other server-only callers should import executeCascade directly instead.
export const runCascade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cascadeEventId: string }) => {
    if (!data?.cascadeEventId || typeof data.cascadeEventId !== "string") {
      throw new Error("cascadeEventId required");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    return executeCascade(context.supabase, data.cascadeEventId);
  });

// Cancel a cascade event that is still pending or running. Marks the event
// as failed and any non-terminal cascade_results as skipped, so the UI
// stops spinning and operators can audit who cancelled what.
export const cancelCascade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cascadeEventId: string; reason?: string }) =>
    z
      .object({
        cascadeEventId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: ev } = await supabase
      .from("cascade_events")
      .select("id, status")
      .eq("id", data.cascadeEventId)
      .maybeSingle();
    if (!ev) return { ok: false as const, error: "Cascade not found" };
    if (ev.status === "completed" || ev.status === "failed") {
      return { ok: false as const, error: `Cannot cancel a ${ev.status} cascade` };
    }
    const now = new Date().toISOString();
    await supabase
      .from("cascade_results")
      .update({
        status: "skipped",
        error_message: data.reason ? `Cancelled: ${data.reason}` : "Cancelled by operator",
        completed_at: now,
      })
      .eq("cascade_event_id", data.cascadeEventId)
      .in("status", ["queued", "pushing"]);
    const { error } = await supabase
      .from("cascade_events")
      .update({
        status: "failed",
        completed_at: now,
        summary: data.reason ? `Cancelled: ${data.reason}` : "Cancelled by operator",
      })
      .eq("id", data.cascadeEventId);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "cascade.cancelled",
      entity_type: "cascade_event",
      entity_id: data.cascadeEventId,
      actor_user_id: userId,
      metadata: { reason: data.reason ?? null },
    });
    return { ok: true as const };
  });
