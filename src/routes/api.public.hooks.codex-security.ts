// @ts-nocheck
// Codex Security webhook receiver.
//
// Verifies the HMAC signature, transitions the scan job, and persists
// findings. Beyond the original "insert whatever arrived" behaviour it now:
//   - carries triage decisions forward across scans (a dismissed finding
//     does not come back as `open` every night),
//   - flags regressions when a previously resolved finding reappears,
//   - auto-resolves findings that a full re-scan no longer reports,
//   - computes the result summary server-side rather than trusting the
//     scanner's own counts.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCodexSignature } from "@/server/codex-security-client.server";
import { resolveScanWebhookSecret } from "@/server/codex-scheduling.server";
import {
  FULL_TREE_KINDS,
  canAutoResolve,
  carryForwardState,
  countOpenBySeverity,
  earliestTimestamp,
  mostDecisiveState,
} from "@/lib/codex-finding-state";

/** Reject absurd bodies before spending CPU on HMAC + JSON parsing. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const FindingSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
  description: z.string().optional(),
  file: z.string().optional().nullable(),
  line: z.number().int().optional().nullable(),
  cwe: z.string().optional().nullable(),
  cvss: z.number().optional().nullable(),
  auto_fix_confidence: z.number().min(0).max(1).optional().nullable(),
  scanner: z.string().optional().nullable(),
  rule_id: z.string().optional().nullable(),
  fingerprint: z.string().optional().nullable(),
  snippet: z.string().optional().nullable(),
  raw: z.record(z.any()).optional(),
});

const PayloadSchema = z.object({
  client_job_id: z.string().uuid(),
  external_scan_id: z.string().optional(),
  engine: z.string().optional(),
  workflow_run_id: z.number().int().optional().nullable(),
  workflow_run_url: z.string().url().optional().nullable(),
  event: z.enum(["scan.started", "scan.progress", "scan.completed", "scan.failed"]),
  summary: z.record(z.any()).optional(),
  findings: z.array(FindingSchema).max(500).optional(),
  findings_complete: z.boolean().optional(),
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
        if (raw.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

        const sig =
          request.headers.get("x-codex-signature") || request.headers.get("x-webhook-signature");

        // The built-in `codex` intake source carries an auto-generated HMAC
        // secret, so the pipeline authenticates even when no env var is set.
        const fallbackSecret = await resolveScanWebhookSecret();
        const ok = await verifyCodexSignature(raw, sig, [fallbackSecret]);
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
          .select("id, clone_id, target_kind, repo_full_name, kind, status")
          .eq("id", payload.client_job_id)
          .maybeSingle();
        if (!job) return json({ error: "unknown job" }, 404);

        const nowIso = new Date().toISOString();
        const incoming = payload.findings ?? [];

        await admin.from("codex_scan_events").insert({
          job_id: job.id,
          event_type: payload.event,
          payload: {
            summary: payload.summary,
            error: payload.error,
            count: incoming.length,
            engine: payload.engine,
            workflow_run_url: payload.workflow_run_url,
          },
        });

        // Record where this scan is actually executing as soon as we know.
        const runPatch: Record<string, unknown> = {};
        if (payload.workflow_run_id) runPatch.workflow_run_id = payload.workflow_run_id;
        if (payload.workflow_run_url) runPatch.workflow_run_url = payload.workflow_run_url;
        if (payload.external_scan_id) runPatch.external_scan_id = payload.external_scan_id;

        if (payload.event === "scan.started") {
          await admin
            .from("codex_scan_jobs")
            .update({ ...runPatch, status: "running", started_at: nowIso, last_error: null })
            .eq("id", job.id);
        } else if (Object.keys(runPatch).length) {
          await admin.from("codex_scan_jobs").update(runPatch).eq("id", job.id);
        }

        let regressions = 0;
        if (incoming.length) {
          const fingerprints = incoming.map((f) => f.fingerprint || f.id);

          // Prior verdicts for the same target keyed by fingerprint. Without
          // this, every dismissal and false-positive call an operator makes
          // is undone by the next nightly scan.
          const priorQuery = admin
            .from("codex_findings")
            .select("fingerprint, state, first_seen_at")
            .in("fingerprint", fingerprints)
            .neq("scan_job_id", job.id);
          if (job.clone_id) priorQuery.eq("clone_id", job.clone_id);
          else priorQuery.is("clone_id", null);
          const { data: prior } = await priorQuery;

          // A fingerprint can have several historical rows (one per past
          // scan). Collapse them order-independently: most decisive verdict
          // wins, and "first seen" means first ever rather than first here.
          const priorByFingerprint = new Map<string, any>();
          for (const p of prior ?? []) {
            const existing = priorByFingerprint.get(p.fingerprint);
            priorByFingerprint.set(p.fingerprint, {
              state: mostDecisiveState(existing?.state, p.state),
              first_seen_at: earliestTimestamp(existing?.first_seen_at, p.first_seen_at),
            });
          }

          const rows = incoming.map((f) => {
            const fingerprint = f.fingerprint || f.id;
            const previous = priorByFingerprint.get(fingerprint);
            const carried = carryForwardState(previous?.state);
            const state = carried.state;
            if (carried.regression) regressions += 1;
            return {
              scan_job_id: job.id,
              clone_id: job.clone_id,
              codex_finding_id: f.id,
              fingerprint,
              title: f.title.slice(0, 500),
              severity: f.severity,
              state,
              description: f.description ?? null,
              affected_file: f.file ?? null,
              affected_line: f.line ?? null,
              cwe: f.cwe ?? null,
              cvss: f.cvss ?? null,
              auto_fix_confidence: f.auto_fix_confidence ?? null,
              scanner: f.scanner ?? null,
              rule_id: f.rule_id ?? null,
              snippet: f.snippet ?? null,
              source_slug: "codex",
              first_seen_at: previous?.first_seen_at ?? nowIso,
              last_seen_at: nowIso,
              raw: f.raw ?? {},
            };
          });

          const { error: upsertErr } = await admin
            .from("codex_findings")
            .upsert(rows, { onConflict: "scan_job_id,codex_finding_id" });
          if (upsertErr) {
            await admin.from("codex_scan_events").insert({
              job_id: job.id,
              event_type: "findings_upsert_failed",
              payload: { error: upsertErr.message, count: rows.length },
            });
            return json({ error: "failed to persist findings", detail: upsertErr.message }, 500);
          }

          if (regressions > 0) {
            await admin.from("codex_scan_events").insert({
              job_id: job.id,
              event_type: "regression_detected",
              payload: { count: regressions },
            });
          }
        }

        if (payload.event === "scan.completed") {
          const summary = await finalizeScan(admin, job, payload, nowIso);
          return json({ ok: true, ingested: incoming.length, regressions, summary });
        }

        if (payload.event === "scan.failed") {
          await admin
            .from("codex_scan_jobs")
            .update({
              status: "failed",
              completed_at: nowIso,
              last_error: (payload.error ?? "unknown").slice(0, 2000),
            })
            .eq("id", job.id);
        }

        return json({ ok: true, ingested: incoming.length, regressions });
      },
    },
  },
});

/**
 * Close out a scan: recount severities from what was actually stored, and
 * for full-tree scans resolve anything the previous scan of this target
 * reported that this one no longer does.
 *
 * Partial scans (`pr_open`, `targeted_path`) deliberately never auto-resolve
 * — they only look at a slice of the tree, so absence proves nothing.
 */
async function finalizeScan(admin: any, job: any, payload: any, nowIso: string) {
  const { data: stored } = await admin
    .from("codex_findings")
    .select("fingerprint, severity, state")
    .eq("scan_job_id", job.id);

  const counts = countOpenBySeverity(stored ?? []);
  const currentFingerprints = new Set<string>();
  for (const f of stored ?? []) {
    if (f.fingerprint) currentFingerprints.add(f.fingerprint);
  }

  let autoResolved = 0;
  if (canAutoResolve(job.kind)) {
    const previousQuery = admin
      .from("codex_scan_jobs")
      .select("id")
      .eq("repo_full_name", job.repo_full_name)
      .eq("target_kind", job.target_kind)
      .in("kind", Array.from(FULL_TREE_KINDS))
      .eq("status", "completed")
      .neq("id", job.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (job.clone_id) previousQuery.eq("clone_id", job.clone_id);
    else previousQuery.is("clone_id", null);
    const { data: previous } = await previousQuery;

    const previousJobId = previous?.[0]?.id;
    if (previousJobId) {
      const { data: stale } = await admin
        .from("codex_findings")
        .select("id, fingerprint")
        .eq("scan_job_id", previousJobId)
        .in("state", ["open", "triaging"]);

      const goneIds = (stale ?? [])
        .filter((f: any) => f.fingerprint && !currentFingerprints.has(f.fingerprint))
        .map((f: any) => f.id);

      if (goneIds.length) {
        await admin
          .from("codex_findings")
          .update({ state: "resolved", resolved_at: nowIso })
          .in("id", goneIds);
        autoResolved = goneIds.length;
        await admin.from("codex_scan_events").insert({
          job_id: job.id,
          event_type: "findings_auto_resolved",
          payload: { count: autoResolved, previous_job_id: previousJobId },
        });
      }
    }
  }

  const summary = {
    ...(payload.summary ?? {}),
    ...counts,
    open_total: Object.values(counts).reduce((a, b) => a + b, 0),
    auto_resolved: autoResolved,
    engine: payload.engine ?? "github_actions",
  };

  await admin
    .from("codex_scan_jobs")
    .update({ status: "completed", completed_at: nowIso, result_summary: summary })
    .eq("id", job.id);

  return summary;
}
