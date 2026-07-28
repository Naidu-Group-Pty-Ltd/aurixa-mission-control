// Has this workspace's plan just changed, and has it been told?
//
// A plan change is worth announcing exactly once: the tier moved, an allowance
// landed in the balance, and the customer should see both — but on every visit
// afterwards it is noise. So the change is a row with an acknowledgement, not
// a flag derived from current state, and this is the pair of calls that reads
// it and retires it.
//
// GET  — the unseen changes for a credential. Reading is not seeing, so this
//        deliberately does NOT acknowledge: a page that fetched and then failed
//        to render would otherwise swallow the only notice ever shown.
// POST — acknowledge one, by id, scoped to the same credential that read it.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { loadValidHandoff } from "@/server/purchases.server";
import { tenantIdForBillingUserId } from "@/server/current-plan.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

/**
 * The workspace behind a storefront credential.
 *
 * A handoff carries its tenant outright. A uid is resolved exactly as checkout
 * and the subscription webhook resolve it, so the notice is looked up against
 * the same tenant the change was recorded against — a different answer here
 * would leave the notice permanently unread.
 *
 * A handoff is NOT consumed: it is single-use for checkout, and reading a
 * banner must not burn someone's ability to buy.
 */
async function tenantFor(
  h: string | null,
  uid: string | null,
): Promise<{ tenantId: string | null }> {
  if (h) {
    const handoff = await loadValidHandoff(h).catch(() => null);
    if (handoff?.tenant_id) return { tenantId: handoff.tenant_id };
  }
  if (uid) return { tenantId: await tenantIdForBillingUserId(uid).catch(() => null) };
  return { tenantId: null };
}

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

export const Route = createFileRoute("/api/public/storefront/plan-change")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),

      GET: async ({ request }) => {
        const url = new URL(request.url);
        const { tenantId } = await tenantFor(
          url.searchParams.get("h"),
          url.searchParams.get("uid"),
        );
        // No credential, an unknown one, or a workspace with nothing to say
        // all answer identically. There is nothing here worth distinguishing,
        // and a 404 would tell an anonymous caller that a uid exists.
        if (!tenantId) return storefrontJson({ ok: true, changes: [] });

        const { data, error } = await adminAny.rpc("unseen_plan_changes", {
          _tenant_id: tenantId,
        });
        if (error) return storefrontJson({ ok: false, error: error.message }, 500);

        const rows = (data ?? []) as PlanChangeRow[];
        return storefrontJson({
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
        let body: { h?: string; uid?: string; id?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return storefrontJson({ ok: false, error: "invalid_body" }, 400);
        }

        const id = (body.id ?? "").trim();
        if (!id) return storefrontJson({ ok: false, error: "id_required" }, 400);

        const { tenantId } = await tenantFor(body.h ?? null, body.uid ?? null);
        // Acknowledging is scoped to the tenant inside the function too, so an
        // id on its own can never retire someone else's notice.
        if (!tenantId) return storefrontJson({ ok: true, acknowledged: false });

        const { data, error } = await adminAny.rpc("acknowledge_plan_change", {
          _tenant_id: tenantId,
          _event_id: id,
        });
        if (error) return storefrontJson({ ok: false, error: error.message }, 500);

        return storefrontJson({
          ok: true,
          acknowledged: (data as { acknowledged?: boolean } | null)?.acknowledged === true,
        });
      },
    },
  },
});
