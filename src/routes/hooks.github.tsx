import { createFileRoute } from "@tanstack/react-router";
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createCascadeForAllClones } from "@/server/cascade-trigger.server";
import { executeCascade } from "@/server/cascade-engine.server";
import { enqueueScanNoAuth, resolveScanTarget } from "@/server/codex-scheduling.server";


// GitHub webhook receiver. Verifies HMAC-SHA256 signature with
// GITHUB_WEBHOOK_SECRET, and on a `push` event to prime's default branch
// auto-fires a cascade in prime_config.default_cascade_mode.

function verifySignature(secret: string, payload: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const Route = createFileRoute("/hooks/github")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        if (!secret) {
          return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256");
        if (!verifySignature(secret, rawBody, signature)) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const eventType = request.headers.get("x-github-event");
        const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";

        // Respond fast to ping
        if (eventType === "ping") {
          return new Response(JSON.stringify({ pong: true, delivery: deliveryId }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Phase 4 — PR-driven Codex Security scans. `pull_request` opens,
        // synchronizes, or reopens trigger a scan against the PR head SHA;
        // scans are deduped within prime_config.codex_scan_dedup_hours.
        if (eventType === "pull_request") {
          let prPayload: any;
          try {
            prPayload = JSON.parse(rawBody);
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          const action = prPayload?.action as string | undefined;
          if (!action || !["opened", "reopened", "synchronize", "ready_for_review"].includes(action)) {
            return new Response(
              JSON.stringify({ skipped: true, reason: `pull_request action ${action ?? "?"} ignored` }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          const repoOwner = prPayload?.repository?.owner?.login ?? prPayload?.repository?.owner?.name ?? "";
          const repoName = prPayload?.repository?.name ?? "";
          const repoFullName = repoOwner && repoName ? `${repoOwner}/${repoName}` : "";
          const headSha = prPayload?.pull_request?.head?.sha ?? null;
          const prNumber = prPayload?.pull_request?.number ?? null;
          const baseRef = prPayload?.pull_request?.base?.ref ?? null;

          const { data: primeCfg } = await supabaseAdmin
            .from("prime_config")
            .select("codex_pr_scan_enabled, codex_scan_dedup_hours")
            .limit(1)
            .maybeSingle();
          if (!primeCfg?.codex_pr_scan_enabled) {
            return new Response(
              JSON.stringify({ skipped: true, reason: "codex_pr_scan_disabled" }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          const target = repoFullName ? await resolveScanTarget(repoFullName) : null;
          if (!target) {
            return new Response(
              JSON.stringify({ skipped: true, reason: `unknown_repo:${repoFullName}` }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          try {
            const r = await enqueueScanNoAuth({
              kind: "pr_open",
              targetKind: target.targetKind,
              cloneId: target.cloneId ?? null,
              repoFullName,
              ref: headSha,
              // Scope the scan to the PR's own diff: a full-tree scan on
              // every push would take minutes and drown the PR in findings
              // the author did not introduce.
              diffBase: baseRef,
              dedupWindowHours: primeCfg.codex_scan_dedup_hours ?? 6,
              requestPayload: {
                source: "github_pr",
                delivery: deliveryId,
                action,
                pr: prNumber,
                baseRef,
              },
            });
            return new Response(JSON.stringify({ success: true, ...r }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response(
              JSON.stringify({ success: false, error: (err as Error).message }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (eventType !== "push") {
          // Acknowledge but don't act on other events
          return new Response(
            JSON.stringify({ skipped: true, reason: `Unhandled event: ${eventType}` }),
            { headers: { "Content-Type": "application/json" } },
          );
        }


        type PushPayload = {
          ref?: string;
          after?: string;
          repository?: { name?: string; owner?: { login?: string; name?: string } };
          head_commit?: { message?: string };
        };
        let payload: PushPayload;
        try {
          payload = JSON.parse(rawBody) as PushPayload;
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const repoOwner = payload.repository?.owner?.login ?? payload.repository?.owner?.name ?? "";
        const repoName = payload.repository?.name ?? "";
        const ref = payload.ref ?? "";
        const sourceSha = payload.after ?? null;

        // Verify this push is on prime
        const { data: prime } = await supabaseAdmin
          .from("prime_config")
          .select("*")
          .limit(1)
          .maybeSingle();
        if (!prime) {
          return new Response(JSON.stringify({ skipped: true, reason: "Prime not configured" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const isPrimeRepo =
          repoOwner.toLowerCase() === prime.github_owner.toLowerCase() &&
          repoName.toLowerCase() === prime.github_repo.toLowerCase();
        const expectedRef = `refs/heads/${prime.default_branch || "main"}`;
        if (!isPrimeRepo || ref !== expectedRef) {
          return new Response(
            JSON.stringify({
              skipped: true,
              reason: `Not prime default branch (got ${repoOwner}/${repoName}@${ref})`,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        const mode = prime.default_cascade_mode;
        const sourceBranch = prime.default_branch || "main";
        const summary = payload.head_commit?.message?.slice(0, 200) ?? null;

        const { eventId, cloneCount, error } = await createCascadeForAllClones({
          supabase: supabaseAdmin,
          mode,
          trigger: "commit",
          sourceBranch,
          sourceSha,
          initiatedBy: null,
          summary,
        });

        if (error || !eventId) {
          await supabaseAdmin.from("audit_log").insert({
            action: "webhook.skipped",
            entity_type: "cascade_event",
            metadata: { delivery: deliveryId, reason: error ?? "no event" },
          });
          return new Response(JSON.stringify({ skipped: true, reason: error ?? "no clones" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        await supabaseAdmin.from("audit_log").insert({
          action: "webhook.cascade_triggered",
          entity_type: "cascade_event",
          entity_id: eventId,
          metadata: { delivery: deliveryId, mode, sourceSha, cloneCount },
        });

        // Fire the cascade. We don't await — return 200 fast so GitHub doesn't
        // retry. (Cloudflare Workers will keep the promise alive long enough
        // for the cascade to finish in practice; if not, the event remains
        // pending and can be retried from the UI.)
        executeCascade(supabaseAdmin, eventId).catch((e) => {
          console.error("Webhook-triggered cascade failed:", e);
        });

        // Phase 4 — post-merge revalidate: run a Codex Security scan against
        // the freshly merged SHA so drift/fix regressions are caught fast.
        if (prime.codex_post_merge_revalidate !== false) {
          const primeRepo = `${prime.github_owner}/${prime.github_repo}`;
          // Awaited: dispatch is a couple of GitHub calls, and a floating
          // promise here dies with the isolate before the scan is ever sent.
          try {
            await enqueueScanNoAuth({
              kind: "post_merge_revalidate",
              targetKind: "prime",
              repoFullName: primeRepo,
              ref: sourceSha,
              dedupWindowHours: prime.codex_scan_dedup_hours ?? 6,
              requestPayload: { source: "post_merge", delivery: deliveryId, sha: sourceSha },
            });
          } catch (e) {
            console.error("post-merge codex scan enqueue failed:", e);
          }
        }


        return new Response(
          JSON.stringify({
            success: true,
            cascadeEventId: eventId,
            mode,
            cloneCount,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
