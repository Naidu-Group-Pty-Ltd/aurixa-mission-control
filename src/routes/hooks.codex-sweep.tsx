// Codex Security stalled-scan sweeper — invoked by pg_cron every 10 minutes
// with Bearer(cron_secret) auth.
//
// Scans are dispatched to an external executor (GitHub Actions) and reported
// back over a webhook, so any lost dispatch or dead workflow run would sit
// in `queued`/`running` forever — and the dedup window would then suppress
// every subsequent scan of that target. This endpoint reconciles both.
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { sweepStalledScans } from "@/server/codex-scheduling.server";

export const Route = createFileRoute("/hooks/codex-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const result = await sweepStalledScans();
          return new Response(
            JSON.stringify({
              success: true,
              retried: result.retried.length,
              failed: result.failed.length,
              timedOut: result.timedOut.length,
              detail: result,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "sweep_failed";
          console.error("codex-sweep failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
