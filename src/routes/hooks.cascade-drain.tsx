// Cascade worker — drains queued cascade_events that were enqueued but never
// executed synchronously (e.g. provision-time module cascades). Runs every
// minute via pg_cron with Bearer(cron_secret) auth.
//
// Only auto-merge events with requires_approval=false are picked up so we
// never bypass approvals. Approval-gated cascades still execute via the
// existing approval UI path.
//
// Concurrency safety mirrors hooks.backend-provisioning-drain:
//  - Atomic claim: UPDATE ... WHERE status='pending' AND worker_started_at IS NULL
//  - Stall reclaim: rows stuck in 'running' past STALL_MINUTES are requeued.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { executeCascade } from "@/server/cascade-engine.server";

const admin = supabaseAdmin;
const STALL_MINUTES = 10;
const MAX_JOBS_PER_RUN = 3;
const MAX_ATTEMPTS = 3;

async function reclaimStalled() {
  const cutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();
  await admin
    .from("cascade_events")
    .update({ worker_started_at: null, status: "pending" })
    .lt("worker_started_at", cutoff)
    .is("worker_finished_at", null)
    .in("status", ["pending", "running"]);
}

/**
 * Claim one job.
 *
 * A READ THAT FAILED IS NOT A QUEUE THAT IS EMPTY, and a CLAIM that failed is
 * not a race that was lost. PostgREST resolves to `{ data: null, error }` on any
 * failure, and `data: null` is also what both of those normal outcomes look
 * like — so a database fault returned "nothing to do", the worker reported
 * success, and the queue never drained with nothing anywhere to grep. That is
 * the defect `SCREENING_EXECUTION.md` records in the prime, and it was inert
 * here only because this worker had never been scheduled. It is not inert now.
 *
 * A genuine failure THROWS: the route's catch turns it into a non-200 that
 * lands in `net._http_response`, where `cron_delivery_health()` can see it.
 */
async function claimOne(): Promise<{ id: string; attempts: number } | null> {
  const nowIso = new Date().toISOString();
  const { data: candidates, error: selectError } = await admin
    .from("cascade_events")
    .select("id, attempts")
    .eq("status", "pending")
    .eq("requires_approval", false)
    .eq("mode", "auto_merge")
    .is("worker_started_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(1);
  if (selectError) {
    throw new Error(`cascade-drain claim: could not read the queue: ${selectError.message}`);
  }
  if (!candidates?.length) return null;
  const target = candidates[0];
  const { data: claimed, error: claimError } = await admin
    .from("cascade_events")
    .update({
      worker_started_at: nowIso,
      attempts: (target.attempts ?? 0) + 1,
    })
    .eq("id", target.id)
    .eq("status", "pending")
    .is("worker_started_at", null)
    .select("id, attempts")
    .maybeSingle();
  // Losing the race returns no row and no error. A fault is not that.
  if (claimError) {
    throw new Error(`cascade-drain claim: could not claim ${target.id}: ${claimError.message}`);
  }
  return claimed ?? null;
}

async function drainOne(): Promise<{ processed: boolean; ok?: boolean; error?: string }> {
  const claimed = await claimOne();
  if (!claimed) return { processed: false };

  try {
    await executeCascade(supabaseAdmin, claimed.id);
    await admin
      .from("cascade_events")
      .update({ worker_finished_at: new Date().toISOString() })
      .eq("id", claimed.id);
    return { processed: true, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cascade-drain] execute failed for ${claimed.id}:`, msg);
    const terminal = claimed.attempts >= MAX_ATTEMPTS;
    await admin
      .from("cascade_events")
      .update({
        worker_started_at: terminal ? undefined : null,
        worker_finished_at: terminal ? new Date().toISOString() : null,
        status: terminal ? "failed" : "pending",
      })
      .eq("id", claimed.id);
    return { processed: true, ok: false, error: msg };
  }
}

export const Route = createFileRoute("/hooks/cascade-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          await reclaimStalled();
          const results: Array<{ ok?: boolean; error?: string }> = [];
          for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
            const r = await drainOne();
            if (!r.processed) break;
            results.push({ ok: r.ok, error: r.error });
          }
          return new Response(
            JSON.stringify({ success: true, processed: results.length, results }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drain_failed";
          console.error("cascade-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
