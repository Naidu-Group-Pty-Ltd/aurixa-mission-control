// Daily edge drift check — walks every active clone_edge_config, compares
// live provider state to intended posture, marks drifted rows and emits
// notifications. Enqueues a `sync` job per config; the drain worker does
// the heavy lifting so this endpoint stays fast.
import { createFileRoute } from "@tanstack/react-router";
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

const admin = supabaseAdmin;

export const Route = createFileRoute("/hooks/edge-drift")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const { data: configs } = await admin
            .from("clone_edge_config")
            .select("clone_id, provider_slug, status")
            .in("status", ["active", "drifted"])
            .limit(500);
          const rows = (configs ?? []) as Array<{
            clone_id: string;
            provider_slug: string;
          }>;
          const nowIso = new Date().toISOString();
          for (const cfg of rows) {
            const payload_hash = crypto
              .createHash("sha256")
              .update(JSON.stringify({ scheduled: nowIso.slice(0, 10) }))
              .digest("hex");
            await admin.from("edge_provisioning_jobs").upsert(
              {
                clone_id: cfg.clone_id,
                provider_slug: cfg.provider_slug,
                action: "sync",
                payload: { scheduled: nowIso.slice(0, 10) },
                payload_hash,
                status: "queued",
                attempts: 0,
                next_attempt_at: nowIso,
              },
              { onConflict: "clone_id,provider_slug,action,payload_hash" },
            );
          }
          return new Response(JSON.stringify({ success: true, scheduled: rows.length }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drift_failed";
          console.error("edge-drift failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
