// Codex remediation callback: receives lifecycle events from the GitHub
// Actions workflow that produces draft fix PRs. Signature is HMAC over the
// raw body using CODEX_REMEDIATION_WEBHOOK_SECRET (falling back to the
// built-in intake source secret, same as the dispatcher).
//
// Beyond recording PR state this now persists the evidence a reviewer needs
// to judge the patch: which engine wrote it, whether the patched tree still
// passes the repo's own checks, whether the secret scan came back clean, and
// how much of the repo it touched.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyRemediationSignature } from "@/server/codex-remediation.server";
import { shouldReopenOnRemediationFailure } from "@/lib/codex-finding-state";

const VerificationSchema = z.object({
  ok: z.boolean().nullable().optional(),
  secrets_clean: z.boolean().optional(),
  checks: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
        skipped: z.boolean().optional(),
        ms: z.number().optional(),
        detail: z.string().optional(),
      }),
    )
    .max(50)
    .optional(),
});

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
  engine: z.string().max(60).optional(),
  model: z.string().max(120).optional(),
  pr_number: z.number().int().optional(),
  pr_url: z.string().url().optional(),
  pr_state: z.string().optional(),
  workflow_run_id: z.number().int().optional(),
  workflow_run_url: z.string().url().optional(),
  branch_name: z.string().optional(),
  verification: VerificationSchema.optional(),
  files_changed: z.number().int().min(0).optional(),
  lines_added: z.number().int().min(0).optional(),
  lines_removed: z.number().int().min(0).optional(),
  summary: z.string().max(4000).optional(),
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
          request.headers.get("x-codex-signature") || request.headers.get("x-webhook-signature");

        // Same fallback chain the dispatcher uses when handing the secret to
        // the workflow, so both ends always agree on the key in play.
        const { resolveRemediationWebhookSecret } =
          await import("@/server/codex-scheduling.server");
        const ok = await verifyRemediationSignature(raw, sig, [
          await resolveRemediationWebhookSecret(),
        ]);
        if (!ok) return json({ error: "invalid signature" }, 401);

        let payload: z.infer<typeof PayloadSchema>;
        try {
          payload = PayloadSchema.parse(JSON.parse(raw));
        } catch (err) {
          return json({ error: "invalid payload", detail: (err as Error).message }, 400);
        }

        const admin = supabaseAdmin as any;
        const { data: rem } = await admin
          .from("codex_remediations")
          .select("id, finding_id, scan_job_id, status")
          .eq("id", payload.remediation_id)
          .maybeSingle();
        if (!rem) return json({ error: "unknown remediation" }, 404);

        const nowIso = new Date().toISOString();

        const patch: Record<string, unknown> = {
          status: EVENT_STATUS[payload.event] ?? rem.status,
          last_event: payload,
        };
        if (payload.pr_number != null) patch.pr_number = payload.pr_number;
        if (payload.pr_url) patch.pr_url = payload.pr_url;
        if (payload.pr_state) patch.pr_state = payload.pr_state;
        if (payload.workflow_run_id != null) patch.workflow_run_id = payload.workflow_run_id;
        if (payload.workflow_run_url) patch.workflow_run_url = payload.workflow_run_url;
        if (payload.branch_name) patch.branch_name = payload.branch_name;
        if (payload.engine) patch.engine = payload.engine;
        if (payload.model) patch.model = payload.model;
        if (payload.files_changed != null) patch.files_changed = payload.files_changed;
        if (payload.lines_added != null) patch.lines_added = payload.lines_added;
        if (payload.lines_removed != null) patch.lines_removed = payload.lines_removed;

        if (payload.verification) {
          patch.verification = payload.verification;
          // `verified` stays NULL when the workflow could not determine it,
          // which reads differently from an explicit false in the UI.
          patch.verified =
            typeof payload.verification.ok === "boolean" ? payload.verification.ok : null;
        }

        if (payload.event === "workflow.failed") {
          patch.last_error = (payload.error ?? "workflow failed").slice(0, 4000);
          patch.completed_at = nowIso;
        }
        if (payload.event === "pr.merged" || payload.event === "pr.closed") {
          patch.completed_at = nowIso;
        }

        await admin.from("codex_remediations").update(patch).eq("id", rem.id);

        // Mirror finding state where applicable.
        const findingState = EVENT_FINDING_STATE[payload.event];
        if (findingState) {
          const findingPatch: Record<string, unknown> = { state: findingState };
          if (payload.pr_url) findingPatch.remediation_pr_url = payload.pr_url;
          if (payload.pr_state) findingPatch.remediation_pr_state = payload.pr_state;
          if (payload.event === "pr.merged") findingPatch.resolved_at = nowIso;
          await admin.from("codex_findings").update(findingPatch).eq("id", rem.finding_id);
        }

        // A failed remediation must not leave the finding parked in a state
        // that implies a fix is on its way.
        if (payload.event === "workflow.failed") {
          const { data: finding } = await admin
            .from("codex_findings")
            .select("id, state")
            .eq("id", rem.finding_id)
            .maybeSingle();
          if (shouldReopenOnRemediationFailure(finding?.state)) {
            await admin
              .from("codex_findings")
              .update({ state: "open", remediation_pr_state: "failed" })
              .eq("id", finding.id);
          }
        }

        // codex_scan_events.job_id is NOT NULL; intake-sourced findings have
        // no scan job, so skip the audit row rather than failing the hook.
        if (rem.scan_job_id) {
          await admin.from("codex_scan_events").insert({
            job_id: rem.scan_job_id,
            event_type: `remediation.${payload.event}`,
            payload: {
              remediation_id: rem.id,
              pr_number: payload.pr_number,
              pr_url: payload.pr_url,
              pr_state: payload.pr_state,
              verified: payload.verification?.ok ?? null,
              secrets_clean: payload.verification?.secrets_clean ?? null,
              files_changed: payload.files_changed,
              error: payload.error,
            },
          });
        }

        return json({ ok: true });
      },
    },
  },
});
