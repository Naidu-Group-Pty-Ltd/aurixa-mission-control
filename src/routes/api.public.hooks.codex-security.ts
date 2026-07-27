// @ts-nocheck
// Codex Security webhook receiver.
// Verifies HMAC signature, transitions the scan job, and persists findings.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCodexSignature } from "@/server/codex-security-client.server";

const FindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
  description: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  cwe: z.string().optional(),
  cvss: z.number().optional(),
  auto_fix_confidence: z.number().optional(),
  raw: z.record(z.any()).optional(),
});

const PayloadSchema = z.object({
  client_job_id: z.string().uuid(),
  external_scan_id: z.string().optional(),
  event: z.enum(["scan.started", "scan.progress", "scan.completed", "scan.failed"]),
  summary: z.record(z.any()).optional(),
  findings: z.array(FindingSchema).optional(),
  error: z.string().optional(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/hooks/codex-security")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const sig =
          request.headers.get("x-codex-signature") ||
          request.headers.get("x-webhook-signature");
        const ok = await verifyCodexSignature(raw, sig);
        if (!ok) return json({ error: "invalid signature" }, 401);

        let payload: z.infer<typeof PayloadSchema>;
        try {
          payload = PayloadSchema.parse(JSON.parse(raw));
        } catch (err) {
          return json({ error: "invalid payload", detail: (err as Error).message }, 400);
        }

        const admin = supabaseAdmin as any;
        const { data: job } = await admin
          .from("codex_scan_jobs")
          .select("id, clone_id")
          .eq("id", payload.client_job_id)
          .maybeSingle();
        if (!job) return json({ error: "unknown job" }, 404);

        await admin.from("codex_scan_events").insert({
          job_id: job.id,
          event_type: payload.event,
          payload: { summary: payload.summary, error: payload.error, count: payload.findings?.length ?? 0 },
        });

        if (payload.event === "scan.started") {
          await admin
            .from("codex_scan_jobs")
            .update({ status: "running", started_at: new Date().toISOString() })
            .eq("id", job.id);
        }

        if (payload.findings?.length) {
          const rows = payload.findings.map((f) => ({
            scan_job_id: job.id,
            clone_id: job.clone_id,
            codex_finding_id: f.id,
            title: f.title,
            severity: f.severity,
            description: f.description ?? null,
            affected_file: f.file ?? null,
            affected_line: f.line ?? null,
            cwe: f.cwe ?? null,
            cvss: f.cvss ?? null,
            auto_fix_confidence: f.auto_fix_confidence ?? null,
            raw: f.raw ?? {},
          }));
          await admin
            .from("codex_findings")
            .upsert(rows, { onConflict: "scan_job_id,codex_finding_id" });
        }

        if (payload.event === "scan.completed") {
          await admin
            .from("codex_scan_jobs")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              result_summary: payload.summary ?? {},
            })
            .eq("id", job.id);
        } else if (payload.event === "scan.failed") {
          await admin
            .from("codex_scan_jobs")
            .update({
              status: "failed",
              completed_at: new Date().toISOString(),
              last_error: payload.error ?? "unknown",
            })
            .eq("id", job.id);
        }

        return json({ ok: true });
      },
    },
  },
});
