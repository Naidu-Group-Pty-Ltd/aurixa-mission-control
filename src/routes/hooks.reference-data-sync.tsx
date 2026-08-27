import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runReferenceDataSync } from "@/server/reference-data.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron schedules a POST here hourly.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Copies the prime's REFERENCE data — the seeded template catalogue, the
// suburb directory, the depreciation comparables — into one clone that still
// needs it. The set of tables that may travel is the allow-list in
// `_shared`-free `src/server/referenceTables.pure.ts`, and nothing here widens
// it: this route chooses no tables and takes none from the request body.
//
// Hourly, not every few minutes: seeding a clone finishes and then costs one
// cheap "already complete" read per tick forever after. The only work it picks
// up later is a clone that has just been provisioned.
//
// One clone per run, deliberately. A run works to a wall-clock budget and banks
// a cursor, so a big table is finished across ticks rather than in one
// invocation that outlives the isolate.
export const Route = createFileRoute("/hooks/reference-data-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const result = await runReferenceDataSync(supabaseAdmin);
          // 200 with per-table detail in the body rather than 500: one table
          // refused for an unclassified column is not a failed run, and a job
          // that reports failure for a state it handled correctly is one people
          // stop reading.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Reference data sync failed";
          console.error("Reference data sync failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
