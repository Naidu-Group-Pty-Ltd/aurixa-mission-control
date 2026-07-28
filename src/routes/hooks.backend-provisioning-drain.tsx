// Backend provisioning worker — drains queued clone_backends jobs.
//
// This route exists because backend provisioning takes minutes and must
// NOT depend on the browser request staying open. The wizard enqueues a
// row (status='pending', queued_admin_password_enc set) and this drainer,
// invoked by pg_cron every minute (Bearer via verifyCronAuth), claims and
// processes it.
//
// Concurrency safety:
//  - Atomic claim: UPDATE ... WHERE status='pending' AND worker_started_at IS NULL
//  - Stall reclaim: rows where worker_started_at is older than STALL_MINUTES
//    and still not finished are reset back to pending so a fresh worker
//    picks them up (previous Cloudflare Worker invocation likely timed out).
//  - Serial per invocation (CONCURRENCY=1): provisioning is heavy, we'd
//    rather burn wall clock than saturate the Supabase Management API.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decryptSecret } from "@/server/crypto.server";
import { runQueuedBackendProvisioning } from "@/lib/backend-provisioning.functions";

const admin = supabaseAdmin as any;
const STALL_MINUTES = 15;
const MAX_JOBS_PER_RUN = 2;
const MAX_ATTEMPTS = 3;

async function reclaimStalled() {
  const cutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();
  await admin
    .from("clone_backends")
    .update({ worker_started_at: null, status_detail: "Worker stalled — requeued" })
    .lt("worker_started_at", cutoff)
    .is("worker_finished_at", null)
    .in("status", ["pending", "provisioning", "migrating", "seeding_admin"]);
}

async function claimOne(): Promise<null | {
  clone_id: string;
  queued_admin_password_enc: string | null;
  queued_module_ids: string[] | null;
  admin_email: string | null;
  region: string | null;
  enqueued_by: string | null;
  attempts: number;
}> {
  const nowIso = new Date().toISOString();
  const { data: candidates } = await admin
    .from("clone_backends")
    .select("clone_id, attempts")
    .eq("status", "pending")
    .is("worker_started_at", null)
    .not("queued_admin_password_enc", "is", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("queued_at", { ascending: true, nullsFirst: false })
    .limit(1);
  if (!candidates?.length) return null;
  const target = candidates[0];
  const { data: claimed } = await admin
    .from("clone_backends")
    .update({
      worker_started_at: nowIso,
      attempts: (target.attempts ?? 0) + 1,
      status_detail: "Worker claimed job",
    })
    .eq("clone_id", target.clone_id)
    .eq("status", "pending")
    .is("worker_started_at", null)
    .select(
      "clone_id, queued_admin_password_enc, queued_module_ids, admin_email, region, enqueued_by, attempts",
    )
    .maybeSingle();
  return claimed ?? null;
}

async function drainOne(): Promise<{ processed: boolean; ok?: boolean; error?: string }> {
  const claimed = await claimOne();
  if (!claimed) return { processed: false };

  const { data: clone } = await admin
    .from("clones")
    .select("name")
    .eq("id", claimed.clone_id)
    .maybeSingle();

  if (!clone) {
    await admin
      .from("clone_backends")
      .update({
        status: "failed",
        error_message: "Clone row not found",
        worker_finished_at: new Date().toISOString(),
      })
      .eq("clone_id", claimed.clone_id);
    return { processed: true, ok: false, error: "clone_not_found" };
  }

  let adminPassword: string;
  try {
    adminPassword = decryptSecret(claimed.queued_admin_password_enc!);
  } catch (e) {
    await admin
      .from("clone_backends")
      .update({
        status: "failed",
        error_message: "Could not decrypt queued admin password",
        worker_finished_at: new Date().toISOString(),
        queued_admin_password_enc: null,
      })
      .eq("clone_id", claimed.clone_id);
    return { processed: true, ok: false, error: "decrypt_failed" };
  }

  const result = await runQueuedBackendProvisioning({
    cloneId: claimed.clone_id,
    cloneName: clone.name,
    region: claimed.region ?? undefined,
    adminEmail: claimed.admin_email ?? "",
    adminPassword,
    moduleIds: claimed.queued_module_ids ?? [],
    actorUserId: claimed.enqueued_by ?? null,
  });

  // Clear the queued password whether we succeeded or exhausted retries.
  const isTerminal = result.ok || claimed.attempts >= MAX_ATTEMPTS;
  await admin
    .from("clone_backends")
    .update({
      worker_finished_at: isTerminal ? new Date().toISOString() : null,
      queued_admin_password_enc: isTerminal ? null : claimed.queued_admin_password_enc,
      // If we failed but still have retries left, allow another worker to claim.
      worker_started_at: !result.ok && !isTerminal ? null : undefined,
      status: !result.ok && !isTerminal ? "pending" : undefined,
    })
    .eq("clone_id", claimed.clone_id);

  return { processed: true, ok: result.ok, error: result.ok ? undefined : result.error };
}

export const Route = createFileRoute("/hooks/backend-provisioning-drain")({
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
          console.error("backend-provisioning-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
