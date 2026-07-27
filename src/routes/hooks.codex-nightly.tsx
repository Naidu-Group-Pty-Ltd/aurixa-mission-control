// @ts-nocheck
// Codex Security nightly scan drainer — invoked by pg_cron with
// Bearer(cron_secret) auth. Enqueues one Codex scan for Prime plus one for
// every clone with codex_nightly_enabled=true, with a dedup window so
// overlapping cron runs (or manual re-runs) don't stack duplicates.
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { runNightlyScans } from "@/server/codex-scheduling.server";

export const Route = createFileRoute("/hooks/codex-nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const result = await runNightlyScans();
          return new Response(
            JSON.stringify({ success: true, ...result }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "nightly_failed";
          console.error("codex-nightly failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
