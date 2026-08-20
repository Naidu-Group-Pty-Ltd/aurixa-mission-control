// Plan changes, for the workspace itself.
//
// The storefront has its own plan-change endpoint, but it authenticates with a
// handoff or a uid — the possession-based credentials a pricing link carries.
// A clone holds neither. It has an API key and meters against a tenant_ref, so
// it needs the same facts through the door it already uses.
//
// Why the workspace needs them at all: the pricing page announces a change to
// whoever happened to be standing at the checkout. The dashboard is where the
// balance lives, where the credits are spent, and where the rest of the team
// will look — so that is where the change has to be visible too.
//
// GET  — plan changes this workspace has not seen. Reading is not seeing, so
//        this does not acknowledge.
// POST — acknowledge one, by id, scoped to the same tenant.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin;

type PlanChangeRow = {
  id: string;
  from_plan_slug: string | null;
  from_plan_name: string | null;
  to_plan_slug: string;
  to_plan_name: string;
  credits_granted: number;
  credits_expire_at: string | null;
  created_at: string;
};

/**
 * The tenant this call is about.
 *
 * `ensureTenant` is the same resolution every other clone endpoint uses, so a
 * clone reads plan changes against exactly the tenant it meters and spends
 * against. Anything else and the notice would be recorded on one balance and
 * looked for on another.
 */
async function resolve(request: Request, scopes: string[]) {
  const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), scopes);
  if (!key) return { ok: false as const, status: 401, error: "unauthorized" };

  const rl = await checkRateLimit(key.id);
  if (!rl.ok) return { ok: false as const, status: 429, error: "rate_limited" };

  return { ok: true as const, key };
}

export const Route = createFileRoute("/api/public/tokens/plan-change")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await resolve(request, ["tokens:read", "tokens:meter"]);
        if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status);

        const url = new URL(request.url);
        const tenantRef = url.searchParams.get("tenant_ref");
        if (!tenantRef || tenantRef.length > 200) {
          return jsonResponse({ ok: false, error: "tenant_ref_required" }, 400);
        }

        const tenant = await ensureTenant(
          auth.key.clone_id,
          tenantRef,
          url.searchParams.get("display_name") ?? undefined,
        );
        if (!tenant.ok) return jsonResponse(tenant, 500);

        const { data, error } = await adminAny.rpc("unseen_plan_changes", {
          _tenant_id: tenant.tenantId,
        });
        // A workspace must not fail to load its dashboard because a banner
        // lookup did. An empty list is the honest degraded answer.
        if (error) {
          console.warn("[tokens/plan-change] read failed", error.message);
          return jsonResponse({ ok: true, changes: [] });
        }

        const rows = (data ?? []) as PlanChangeRow[];
        return jsonResponse({
          ok: true,
          changes: rows.map((r) => ({
            id: r.id,
            from_plan_slug: r.from_plan_slug,
            from_plan_name: r.from_plan_name,
            to_plan_slug: r.to_plan_slug,
            to_plan_name: r.to_plan_name,
            credits_granted: r.credits_granted,
            credits_expire_at: r.credits_expire_at,
            created_at: r.created_at,
          })),
        });
      },

      POST: async ({ request }) => {
        // Acknowledging is a write about this workspace's own state, so it
        // needs no more privilege than reading the balance does.
        const auth = await resolve(request, ["tokens:read", "tokens:meter"]);
        if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, auth.status);

        let body: { tenant_ref?: string; display_name?: string; id?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return jsonResponse({ ok: false, error: "invalid_body" }, 400);
        }

        const id = (body.id ?? "").trim();
        const tenantRef = body.tenant_ref;
        if (!id) return jsonResponse({ ok: false, error: "id_required" }, 400);
        if (!tenantRef || tenantRef.length > 200) {
          return jsonResponse({ ok: false, error: "tenant_ref_required" }, 400);
        }

        const tenant = await ensureTenant(auth.key.clone_id, tenantRef, body.display_name);
        if (!tenant.ok) return jsonResponse(tenant, 500);

        const { data, error } = await adminAny.rpc("acknowledge_plan_change", {
          _tenant_id: tenant.tenantId,
          _event_id: id,
        });
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        return jsonResponse({
          ok: true,
          acknowledged: (data as { acknowledged?: boolean } | null)?.acknowledged === true,
        });
      },
    },
  },
});
