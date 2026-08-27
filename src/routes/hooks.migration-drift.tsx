import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runMigrationDrift } from "@/server/migration-drift.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here hourly (`migration-drift-hourly`).
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Asks the database whether each migration's declared effect is actually there.
// The ledger cannot answer that on this deployment -- 40 of 211 repo versions
// appear in `supabase_migrations.schema_migrations` and 103 of its rows match
// no repo file -- so the claims are declared in the SQL as `-- @asserts` lines
// and resolved against the live schema here.
//
// It reads. It creates nothing, grants nothing and applies nothing: the
// automation that WOULD apply a migration is deliberately not this endpoint,
// for the reasons in docs/MIGRATION_AUTOMATION_OPTIONS.md.
export const Route = createFileRoute("/hooks/migration-drift")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const result = await runMigrationDrift(supabaseAdmin);
          // 200 with the summary in the body, including when claims drifted.
          // Drift is a finding, not a failed run -- the run did exactly what it
          // exists to do. The alarm is the operator notification the worker
          // raises; a 500 here would only make the scheduler look broken.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Migration drift check failed";
          console.error("Migration drift check failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
