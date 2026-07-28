import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

export const Route = createFileRoute("/api/public/tokens/balance")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "tokens:read",
          "tokens:meter",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const url = new URL(request.url);
        const tenantRef = url.searchParams.get("tenant_ref");
        if (!tenantRef || tenantRef.length > 200) {
          return jsonResponse({ ok: false, error: "tenant_ref_required" }, 400);
        }
        const displayName = url.searchParams.get("display_name") ?? undefined;
        const tenant = await ensureTenant(key.clone_id, tenantRef, displayName);
        if (!tenant.ok) return jsonResponse(tenant, 500);

        // `token_balances` is a cache refreshed by ledger writes. A reservation
        // orphaned by an abandoned generation run stops counting once its TTL
        // passes, but nothing rewrites the cache — so without this the tenant
        // keeps seeing credits that are already free again as "reserved". The
        // RPC no-ops unless the cached row is actually stale.
        await supabaseAdmin
          .rpc("refresh_token_balance", { _tenant_id: tenant.tenantId, _max_age_seconds: 60 })
          .then(
            ({ error }) => {
              if (error) console.warn("[tokens/balance] refresh failed", error.message);
            },
            () => {},
          );

        const [bal, ten] = await Promise.all([
          supabaseAdmin
            .from("token_balances")
            .select("available, reserved, lifetime_granted, lifetime_spent, updated_at")
            .eq("tenant_id", tenant.tenantId)
            .maybeSingle(),
          supabaseAdmin
            .from("tenants")
            .select(
              "id, external_ref, display_name, status, current_period_end, billing_exempt, billing_plans:plan_id(slug, name, monthly_allowance, overage_policy)",
            )
            .eq("id", tenant.tenantId)
            .maybeSingle(),
        ]);

        return jsonResponse({
          ok: true,
          tenant: ten.data,
          balance: bal.data ?? {
            available: 0,
            reserved: 0,
            lifetime_granted: 0,
            lifetime_spent: 0,
          },
        });
      },
    },
  },
});
