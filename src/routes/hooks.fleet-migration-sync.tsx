import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runFleetMigrationSync } from "@/server/fleet-migration.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 30 min.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Applies the prime's migrations to a bounded slice of the fleet. The cascade
// already copies migration FILES into every clone's repository; this is what
// gets them into the clone's DATABASE, which until now happened only when an
// operator pressed a button on an admin page.
//
// Thirty minutes, not one: nothing here is queue-draining, a clone's schema
// does not change between ticks, and each run is bounded to a few clones so
// the fleet is worked through across ticks rather than in one invocation that
// would outlive the isolate.
//
// It can only ever reach a clone: the candidate list is `clone_backends`, whose
// `clone_id` is NOT NULL, so the prime — whose ref lives in `prime_config` —
// has no row there to return.
export const Route = createFileRoute("/hooks/fleet-migration-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const result = await runFleetMigrationSync(supabaseAdmin);
          // 200 with the failures in the body rather than 500: one clone whose
          // migration failed is not a failed run, and a job that reports
          // failure for a state it handled correctly is one people stop reading.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Fleet migration sync failed";
          console.error("Fleet migration sync failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
