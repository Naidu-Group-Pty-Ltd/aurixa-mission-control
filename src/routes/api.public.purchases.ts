import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

/**
 * GET /api/public/purchases
 *
 * Purchase-history read-back for command centers (user-attributed pricing
 * workflow, Phase 4): a clone can render its own attributed purchase ledger
 * (who bought what, when, for how much) inside its billing/settings UI.
 *
 * Auth: `x-clone-api-key`. Rows are hard-scoped to the key's clone — a clone
 * can never read another clone's purchases. Optional `?tenant_ref=` narrows
 * to one tenant (resolved within the key's clone; unknown refs return an
 * empty page rather than provisioning anything). `?status=` filters by
 * lifecycle state; default returns completed + refunded (the money that
 * actually moved).
 */
export const Route = createFileRoute("/api/public/purchases")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "billing:handoff",
          "tokens:read",
          "tokens:meter",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(key.id);
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
              count: rl.count,
              limit: rl.limit,
              retry_after_seconds: rl.retry_after_seconds,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retry_after_seconds),
              },
            },
          );
        }

        const url = new URL(request.url);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 25) || 25));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const statusParam = url.searchParams.get("status");
        // "all" = every lifecycle state (the billing page's transactions view
        // wants failed/initiated attempts visible too, not just settled money).
        const allowedStatuses = [
          "initiated",
          "completed",
          "failed",
          "refunded",
          "abandoned",
          "all",
        ];

        // Optional tenant narrowing, resolved strictly inside this key's clone.
        let tenantId: string | null = null;
        const tenantRef = url.searchParams.get("tenant_ref");
        if (tenantRef) {
          let tq = supabaseAdmin.from("tenants").select("id").eq("external_ref", tenantRef);
          tq = key.clone_id == null ? tq.is("clone_id", null) : tq.eq("clone_id", key.clone_id);
          const { data: tenant } = await tq.maybeSingle();
          if (!tenant) {
            return jsonResponse({
              ok: true,
              purchases: [],
              pagination: { limit, offset, total: 0, has_more: false, next_offset: null },
            });
          }
          tenantId = tenant.id;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- item_name postdates the generated DB types
        const adminAny = supabaseAdmin;
        let q = adminAny
          .from("purchases")
          .select(
            "id, created_at, completed_at, status, mode, item_slug, item_name, quantity, amount_cents, currency, payment_status, origin_user_id, origin_username, origin_source, stripe_checkout_session_id, stripe_payment_intent_id",
            { count: "exact" },
          )
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

        // Hard clone scoping — the key IS the boundary.
        q = key.clone_id == null ? q.is("clone_id", null) : q.eq("clone_id", key.clone_id);
        if (tenantId) q = q.eq("tenant_id", tenantId);
        if (statusParam === "all") {
          // no status filter
        } else if (statusParam && allowedStatuses.includes(statusParam)) {
          q = q.eq("status", statusParam);
        } else if (!statusParam) {
          q = q.in("status", ["completed", "refunded"]);
        } else {
          return jsonResponse({ ok: false, error: "invalid_status" }, 400);
        }

        const { data: rows, count, error } = await q;
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        const total = count ?? 0;
        return new Response(
          JSON.stringify({
            ok: true,
            purchases: rows ?? [],
            pagination: {
              limit,
              offset,
              total,
              has_more: offset + (rows?.length ?? 0) < total,
              next_offset: offset + (rows?.length ?? 0) < total ? offset + limit : null,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": String(rl.limit),
              "X-RateLimit-Remaining": String(Math.max(0, rl.limit - rl.count)),
              "X-Total-Count": String(total),
            },
          },
        );
      },
    },
  },
});
