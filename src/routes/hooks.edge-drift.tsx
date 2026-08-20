// Daily edge drift check — walks every active clone_edge_config, compares
// live provider state to intended posture, marks drifted rows and emits
// notifications. Enqueues a `sync` job per config; the drain worker does
// the heavy lifting so this endpoint stays fast.
import { createFileRoute } from "@tanstack/react-router";
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// How many edge configs one run checks. Reported back as `truncated` when the
// batch comes back full, so a fleet that has outgrown it says so.
const EDGE_DRIFT_BATCH = 500;

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
            // Ordered, because the cap is real: an unordered LIMIT returns an
            // arbitrary subset, so above 500 configs the same ones can be
            // checked every run while the rest are never checked at all.
            .order("updated_at", { ascending: true })
            .limit(EDGE_DRIFT_BATCH);
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
          // `truncated` rather than silence: a fleet that has outgrown the batch
          // looks identical to one that fits, and only this says which.
          return new Response(
            JSON.stringify({
              success: true,
              scheduled: rows.length,
              truncated: rows.length >= EDGE_DRIFT_BATCH,
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
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
