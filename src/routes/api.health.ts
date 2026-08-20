import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { isEncryptionEnabled } from "@/server/crypto.server";

// Machine-readable health endpoint. Returns JSON with sub-system status.
// Used by uptime monitors and the /health dashboard.
//
// This endpoint is deliberately unauthenticated, because the thing asking is
// usually a monitor that holds no credential. That makes WHAT it says a
// security question rather than a design one. It used to answer
//
//   "secrets": { "ok": false, "error": "missing: SUPABASE_SERVICE_ROLE_KEY,
//                STRIPE_SECRET_KEY, GITHUB_APP_ID" }
//
// to anybody who asked — which is the platform's entire credential inventory
// plus a list of exactly which ones are absent right now, i.e. a map of what is
// unconfigured and therefore worth probing. A monitor needs to know that
// something is wrong; it does not need to know which secret, and an anonymous
// caller has no business knowing either.
//
// So the shape is the same for everyone and the DETAIL is gated: present the
// cron credential and the names come back, otherwise you get a count.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const started = Date.now();
        const checks: Record<string, { ok: boolean; latency_ms?: number; error?: string }> = {};

        // DB ping
        const dbStart = Date.now();
        try {
          const { error } = await supabaseAdmin
            .from("clones")
            .select("id", { count: "exact", head: true })
            .limit(1);
          checks.database = {
            ok: !error,
            latency_ms: Date.now() - dbStart,
            // A driver error string can carry a relation name, a column name or
            // a role — same reasoning as the secrets below.
            error: error ? "database_unavailable" : undefined,
          };
        } catch {
          checks.database = {
            ok: false,
            latency_ms: Date.now() - dbStart,
            error: "database_unavailable",
          };
        }

        // Required env / secret presence. Values are never read, only existence.
        const requiredEnv = [
          "SUPABASE_URL",
          "SUPABASE_SERVICE_ROLE_KEY",
          "LOVABLE_API_KEY",
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "GITHUB_APP_ID",
          "DRIFT_REFRESH_TOKEN",
        ];
        const missing = requiredEnv.filter((k) => !process.env[k]);
        const trusted = verifyCronAuth(request).ok;
        checks.secrets = {
          ok: missing.length === 0,
          error: missing.length
            ? trusted
              ? `missing: ${missing.join(",")}`
              : `${missing.length} required secret(s) missing`
            : undefined,
        };

        // Whether stored credentials are encrypted at rest. `encryptSecret` is a
        // no-op without CREDENTIALS_ENC_KEY — silently, into columns named
        // `..._ciphertext` — so nothing else in the product can tell you which
        // state a deployment is in. Reported, but deliberately NOT folded into
        // `ok`: this is a misconfiguration for a person to fix, not an outage
        // for a load balancer to route around, and a restart will not change it.
        const encryptionOn = isEncryptionEnabled();
        checks.credential_encryption = {
          ok: encryptionOn,
          error: encryptionOn
            ? undefined
            : "CREDENTIALS_ENC_KEY unset — clone service-role keys, database passwords and client PATs are stored in plaintext",
        };

        const allOk = Object.entries(checks)
          .filter(([name]) => name !== "credential_encryption")
          .every(([, c]) => c.ok);
        return new Response(
          JSON.stringify({
            ok: allOk,
            status: allOk ? "healthy" : "degraded",
            checks,
            latency_ms: Date.now() - started,
            timestamp: new Date().toISOString(),
          }),
          {
            status: allOk ? 200 : 503,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          },
        );
      },
    },
  },
});
