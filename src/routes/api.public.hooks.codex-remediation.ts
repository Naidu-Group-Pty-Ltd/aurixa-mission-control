// @ts-nocheck
// Codex remediation callback: receives PR lifecycle events from the
// GitHub Actions workflow that produces draft fix PRs. Signature is HMAC
// over the raw body using CODEX_REMEDIATION_WEBHOOK_SECRET.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyRemediationSignature } from "@/server/codex-remediation.server";

const PayloadSchema = z.object({
  remediation_id: z.string().uuid(),
  event: z.enum([
    "workflow.started",
    "branch.pushed",
    "pr.opened",
    "pr.updated",
    "pr.merged",
    "pr.closed",
    "workflow.failed",
  ]),
  pr_number: z.number().int().optional(),
  pr_url: z.string().url().optional(),
  pr_state: z.string().optional(),
  workflow_run_id: z.number().int().optional(),
  workflow_run_url: z.string().url().optional(),
  branch_name: z.string().optional(),
  error: z.string().optional(),
  detail: z.record(z.any()).optional(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EVENT_STATUS: Record<string, string> = {
  "workflow.started": "dispatched",
  "branch.pushed": "dispatched",
  "pr.opened": "pr_opened",
  "pr.updated": "pr_updated",
  "pr.merged": "merged",
  "pr.closed": "closed",
  "workflow.failed": "failed",
};

const EVENT_FINDING_STATE: Record<string, string> = {
  "pr.opened": "pr_open",
  "pr.updated": "pr_open",
  "pr.merged": "fix_merged",
  "pr.closed": "fix_drafted",
};

export const Route = createFileRoute("/api/public/hooks/codex-remediation")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const sig =
          request.headers.get("x-codex-signature") ||
          request.headers.get("x-webhook-signature");
        const ok = await verifyRemediationSignature(raw, sig);
        if (!ok) return json({ error: "invalid signature" }, 401);

        let payload: z.infer<typeof PayloadSchema>;
        try {
          payload = PayloadSchema.parse(JSON.parse(raw));
        } catch (err) {
          return json(
            { error: "invalid payload", detail: (err as Error).message },
            400,
          );
        }

        const admin = supabaseAdmin as any;
        const { data: rem } = await admin
          .from("codex_remediations")
          .select("id, finding_id, scan_job_id, status")
          .eq("id", payload.remediation_id)
          .maybeSingle();
        if (!rem) return json({ error: "unknown remediation" }, 404);

        const patch: Record<string, unknown> = {
          status: EVENT_STATUS[payload.event] ?? rem.status,
          last_event: payload,
        };
        if (payload.pr_number != null) patch.pr_number = payload.pr_number;
        if (payload.pr_url) patch.pr_url = payload.pr_url;
        if (payload.pr_state) patch.pr_state = payload.pr_state;
        if (payload.workflow_run_id != null)
          patch.workflow_run_id = payload.workflow_run_id;
        if (payload.workflow_run_url)
          patch.workflow_run_url = payload.workflow_run_url;
        if (payload.branch_name) patch.branch_name = payload.branch_name;
        if (payload.event === "workflow.failed") {
          patch.last_error = payload.error ?? "workflow failed";
          patch.completed_at = new Date().toISOString();
        }
        if (payload.event === "pr.merged" || payload.event === "pr.closed") {
          patch.completed_at = new Date().toISOString();
        }

        await admin
          .from("codex_remediations")
          .update(patch)
          .eq("id", rem.id);

        // Mirror finding state where applicable.
        const findingState = EVENT_FINDING_STATE[payload.event];
        if (findingState) {
          const findingPatch: Record<string, unknown> = { state: findingState };
          if (payload.pr_url) findingPatch.remediation_pr_url = payload.pr_url;
          if (payload.pr_state)
            findingPatch.remediation_pr_state = payload.pr_state;
          if (payload.event === "pr.merged") {
            findingPatch.resolved_at = new Date().toISOString();
          }
          await admin
            .from("codex_findings")
            .update(findingPatch)
            .eq("id", rem.finding_id);
        }

        await admin.from("codex_scan_events").insert({
          job_id: rem.scan_job_id,
          event_type: `remediation.${payload.event}`,
          payload: {
            remediation_id: rem.id,
            pr_number: payload.pr_number,
            pr_url: payload.pr_url,
            pr_state: payload.pr_state,
            error: payload.error,
          },
        });

        return json({ ok: true });
      },
    },
  },
});
