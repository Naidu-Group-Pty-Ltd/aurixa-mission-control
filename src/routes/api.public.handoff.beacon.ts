// G20 — Inbound health beacon from client-owned backends.
// Auth: x-clone-api-key with scope `health:beacon`. Payload is stored on
// `clone_health_beacons`, scoped to the key's clone_id and (best-effort) the
// most recent handoff for that clone.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";

const beaconSchema = z.object({
  project_ref: z.string().max(64).optional().nullable(),
  project_status: z.string().max(64).optional().nullable(),
  db_size_bytes: z.number().int().nonnegative().optional().nullable(),
  active_connections: z.number().int().nonnegative().optional().nullable(),
  api_p95_ms: z.number().int().nonnegative().optional().nullable(),
  storage_used_bytes: z.number().int().nonnegative().optional().nullable(),
  edge_invocations_24h: z.number().int().nonnegative().optional().nullable(),
  error_count_24h: z.number().int().nonnegative().optional().nullable(),
  severity: z.enum(["ok", "warn", "critical"]).optional(),
  message: z.string().max(1000).optional().nullable(),
  payload: z.record(z.any()).optional(),
});

export const Route = createFileRoute("/api/public/handoff/beacon")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "health:beacon",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        if (!key.clone_id) return jsonResponse({ ok: false, error: "key_not_clone_scoped" }, 400);

        let body: any;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = beaconSchema.safeParse(body);
        if (!parsed.success)
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );

        const admin = supabaseAdmin;
        const { data: handoff } = await admin
          .from("clone_handoffs")
          .select("id")
          .eq("clone_id", key.clone_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const { data: beacon, error } = await admin
          .from("clone_health_beacons")
          .insert({
            clone_id: key.clone_id,
            handoff_id: handoff?.id ?? null,
            source: "beacon",
            project_ref: parsed.data.project_ref ?? null,
            project_status: parsed.data.project_status ?? null,
            db_size_bytes: parsed.data.db_size_bytes ?? null,
            active_connections: parsed.data.active_connections ?? null,
            api_p95_ms: parsed.data.api_p95_ms ?? null,
            storage_used_bytes: parsed.data.storage_used_bytes ?? null,
            edge_invocations_24h: parsed.data.edge_invocations_24h ?? null,
            error_count_24h: parsed.data.error_count_24h ?? null,
            severity: parsed.data.severity ?? "ok",
            message: parsed.data.message ?? null,
            payload: parsed.data.payload ?? {},
          })
          .select("id, reported_at")
          .single();
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        return jsonResponse({
          ok: true,
          id: beacon.id,
          reported_at: beacon.reported_at,
          handoff_id: handoff?.id ?? null,
        });
      },
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, x-clone-api-key",
          },
        }),
    },
  },
});
