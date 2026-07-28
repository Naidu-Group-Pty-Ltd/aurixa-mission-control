import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { EXPIRY_WARNING_DAYS, TOKEN_EXPIRY_DAYS } from "@/server/token-lots.server";

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

        // What lapses, and when. Credits live 30 days from issue, so a clone
        // needs to be able to warn before a balance quietly shrinks. Derived
        // from the same lot arithmetic as `available`, so the warning can never
        // contradict the number beside it. Best-effort: a balance read must not
        // fail because the schedule query did.
        let expiringSoon = 0;
        let nextExpiryAt: string | null = null;
        try {
          const { data: schedule } = await supabaseAdmin.rpc(
            "token_expiry_schedule" as never,
            {
              _tenant_id: tenant.tenantId,
            } as never,
          );
          const rows = (schedule ?? []) as Array<{ expires_at: string | null; remaining: number }>;
          const dated = rows.filter((r) => r.expires_at);
          nextExpiryAt = dated[0]?.expires_at ?? null;
          const horizon = Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
          expiringSoon = dated
            .filter((r) => Date.parse(r.expires_at as string) <= horizon)
            .reduce((sum, r) => sum + Number(r.remaining ?? 0), 0);
        } catch (err) {
          console.warn("[tokens/balance] expiry schedule unavailable", err);
        }

        return jsonResponse({
          ok: true,
          tenant: ten.data,
          balance: bal.data ?? {
            available: 0,
            reserved: 0,
            lifetime_granted: 0,
            lifetime_spent: 0,
          },
          expiry: {
            policy_days: TOKEN_EXPIRY_DAYS,
            warning_days: EXPIRY_WARNING_DAYS,
            expiring_soon: expiringSoon,
            next_expiry_at: nextExpiryAt,
          },
        });
      },
    },
  },
});
