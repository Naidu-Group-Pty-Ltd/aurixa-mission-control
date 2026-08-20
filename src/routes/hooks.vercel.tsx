// Vercel webhook receiver.
//
// The drain polls a build only while a row is in `deploying` and stops at
// `live`. That leaves every SUBSEQUENT build unobserved: a cascade pushes code,
// the build fails, Vercel keeps the previous production deployment serving, and
// `clone_deployments` goes on saying `live` — true, and useless, because what is
// serving is not what we pushed.
//
// This closes that. It records build health beside the lifecycle rather than
// into it (see vercelWebhook.pure.ts for why those are two facts), and it is the
// FAST path only: `sweepLiveBuilds` in the deployment drain asks Vercel directly
// for rows the webhook never reached. A webhook that was never delivered leaves
// no trace anywhere, which is the same reason `cron_delivery_health` exists —
// a green run is not a delivered request.
import { createFileRoute } from "@tanstack/react-router";
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRow } from "@/lib/json-cast";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { lifecyclePatchFor, readVercelWebhook } from "@/server/hosting/vercelWebhook.pure";

const admin = supabaseAdmin;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Vercel signs with HMAC-SHA1 over the raw body, hex, in `x-vercel-signature`.
 *
 * SHA1 is Vercel's choice, not ours — it is what the platform sends and the only
 * thing there is to compare against. The comparison is length-checked first
 * because `timingSafeEqual` THROWS on a length mismatch rather than returning
 * false, which would turn a malformed header into a 500 and, on a route that
 * answers webhooks, into an infinite retry loop.
 */
function verify(secret: string, raw: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha1", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const Route = createFileRoute("/hooks/vercel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.VERCEL_WEBHOOK_SECRET;
        // Unconfigured is not "accept everything". An unsigned receiver that
        // writes to `clone_deployments` is an unauthenticated write endpoint for
        // the whole fleet's hosting state.
        if (!secret) return json({ error: "vercel_webhook_secret_not_configured" }, 503);

        const raw = await request.text();
        if (!verify(secret, raw, request.headers.get("x-vercel-signature"))) {
          return json({ error: "invalid_signature" }, 401);
        }

        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          // 200, not 400: the body is unusable and retrying will not change it.
          // A 4xx here makes Vercel redeliver a message that can never succeed.
          return json({ ok: true, ignored: "unparseable" });
        }

        const read = readVercelWebhook(body);
        if (read.kind === "ignored") return json({ ok: true, ignored: read.reason });

        // Find the clone by the project the event names. An unknown project is
        // an ordinary outcome — the team may host things Mission Control did not
        // create — and must answer 200, or Vercel retries it forever.
        const { data: row } = await admin
          .from("clone_deployments")
          .select("clone_id, provider_slug, status, latest_deployment_id, domain")
          .eq("project_id", read.projectId)
          .maybeSingle();
        if (!row) return json({ ok: true, ignored: "unknown_project" });

        const patch: Record<string, unknown> = {
          last_build_state: read.state,
          last_build_deployment_id: read.deploymentId,
          last_build_error: read.state === "error" ? (read.errorMessage ?? "Build failed") : null,
          last_build_at: new Date().toISOString(),
          build_checked_at: new Date().toISOString(),
        };

        const lifecycle = lifecyclePatchFor({
          currentStatus: row.status,
          trackedDeploymentId: row.latest_deployment_id,
          state: read.state,
          deploymentId: read.deploymentId,
        });
        if (lifecycle) {
          patch.status = lifecycle.status;
          patch.status_detail = lifecycle.detail;
          patch.next_attempt_at = new Date().toISOString();
          patch.worker_started_at = null;
        }

        const { error } = await admin
          .from("clone_deployments")
          .update(asRow<TablesUpdate<"clone_deployments">>(patch))
          .eq("clone_id", row.clone_id);

        await admin.from("deployment_events").insert({
          clone_id: row.clone_id,
          provider_slug: row.provider_slug ?? "vercel",
          action: "webhook_build",
          from_status: row.status,
          to_status: lifecycle?.status ?? null,
          success: !error,
          error_message: error?.message ?? null,
          payload: {
            state: read.state,
            deployment_id: read.deploymentId,
            target: read.target,
          },
        });

        // A production build that failed on a clone which is already LIVE is the
        // case this whole route exists for, and it is invisible everywhere else:
        // the site is up, so no uptime check fires, and the row still says
        // `live`, so no dashboard shows red. Say it once, plainly.
        if (read.state === "error" && row.status === "live") {
          const { data: clone } = await admin
            .from("clones")
            .select("name")
            .eq("id", row.clone_id)
            .maybeSingle();
          await admin.from("notifications").insert({
            kind: "deployment_build_failed",
            severity: "warning",
            title: `Build failed: ${clone?.name ?? row.clone_id}`,
            body: `${row.domain ?? "The clone"} is still serving the previous build. The latest push did not ship. ${read.errorMessage ?? ""}`.trim(),
            clone_id: row.clone_id,
            url: `/clones/${row.clone_id}`,
            metadata: { deployment_id: read.deploymentId, project_id: read.projectId },
          });
        }

        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true, state: read.state, lifecycle: lifecycle?.status ?? null });
      },
    },
  },
});
