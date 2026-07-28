import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { fireTokenWebhook, balanceSnapshot } from "@/server/token-webhooks.server";

const Schema = z.object({
  job_id: z.string().uuid(),
  reason: z.string().max(300).optional(),
  /**
   * Release semantics: when the job was already committed by an earlier call in
   * the same generation run, refund the charge instead of no-oping.
   *
   * Chunked report generation commits nothing until the run finishes, but a run
   * that was committed by an older clone build — or by a final chunk whose
   * response never reached the caller — must still be reversible when the
   * report ends up failed. Callers that genuinely mean "cancel a live
   * reservation only" omit the flag and keep the historical behaviour.
   */
  refund_if_committed: z.boolean().optional(),
});

export const Route = createFileRoute("/api/public/tokens/cancel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "tokens:meter",
        );
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success)
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );

        const job = await supabaseAdmin
          .from("report_jobs")
          .select("clone_id, tenant_id")
          .eq("id", parsed.data.job_id)
          .maybeSingle();
        if (!job.data) return jsonResponse({ ok: false, error: "job_not_found" }, 404);
        if (job.data.clone_id !== key.clone_id)
          return jsonResponse({ ok: false, error: "forbidden" }, 403);

        // `release_token_job` cancels a live reservation or refunds an
        // already-committed one; both branches are idempotent, so a clone that
        // retries a release never double-refunds.
        const { data: result, error } = parsed.data.refund_if_committed
          ? await (supabaseAdmin.rpc as any)("release_token_job", {
              _job_id: parsed.data.job_id,
              _reason: parsed.data.reason ?? undefined,
            })
          : await supabaseAdmin.rpc("cancel_token_reservation", {
              _job_id: parsed.data.job_id,
              _reason: parsed.data.reason ?? undefined,
            });
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        // Releasing credits changes the spendable balance — tell subscribers,
        // the same way reserve does. Fire-and-forget: never block the release.
        balanceSnapshot(job.data.tenant_id)
          .then((snap) =>
            fireTokenWebhook(
              "tokens.balance.updated",
              { ...snap, source: "release" },
              key.clone_id,
            ),
          )
          .catch(() => {});

        return jsonResponse(result, 200);
      },
    },
  },
});
