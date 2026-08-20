// Public read-only endpoint: returns the calling clone's edge/CDN status.
// Auth: x-clone-api-key with scope `edge:read` (or `edge:manage`). Scoped to
// the key's own clone_id — never returns other clones' configuration.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";

export const Route = createFileRoute("/api/public/edge/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "edge:read",
          "edge:manage",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        if (!key.clone_id) return jsonResponse({ ok: false, error: "key_not_clone_scoped" }, 400);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const admin = supabaseAdmin;
        const { data: configs, error } = await admin
          .from("clone_edge_config")
          .select(
            "provider_slug, hostname, status, status_detail, posture_preset, last_synced_at, updated_at",
          )
          .eq("clone_id", key.clone_id);
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        const { data: pending } = await admin
          .from("edge_provisioning_jobs")
          .select("provider_slug, action, status, attempts, created_at")
          .eq("clone_id", key.clone_id)
          .in("status", ["queued", "running", "retry"])
          .order("created_at", { ascending: false })
          .limit(20);

        return jsonResponse({
          ok: true,
          clone_id: key.clone_id,
          providers: configs ?? [],
          pending_jobs: pending ?? [],
        });
      },
    },
  },
});
