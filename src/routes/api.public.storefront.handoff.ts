import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadValidHandoff } from "@/server/purchases.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { planForTenant } from "@/server/current-plan.server";

/**
 * GET /api/public/storefront/handoff?h=<uuid>
 *
 * Display-safe handoff resolution for the Aurixa Systems pricing page: the
 * storefront shows "Purchasing for <clone> as <user>" and knows which intent
 * to auto-launch. The unguessable single-use token is the credential; the
 * response is deliberately minimal — the raw origin_user_id stays server-side
 * and checkout re-reads it from the handoff row.
 */
export const Route = createFileRoute("/api/public/storefront/handoff")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const h = url.searchParams.get("h") ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(h)) {
          return storefrontJson({ ok: false, error: "handoff_invalid" }, 400);
        }

        const handoff = await loadValidHandoff(h);
        if (!handoff) return storefrontJson({ ok: false, error: "handoff_invalid" }, 404);

        // Workspace display name: the clone's name when the handoff belongs to
        // a clone, else the tenant's display name — prime-install handoffs have
        // clone_id NULL but always carry tenant_id, and returning null here
        // made the pricing page fall back to a generic "your workspace".
        let cloneName: string | null = null;
        if (handoff.clone_id) {
          const { data: clone } = await supabaseAdmin
            .from("clones")
            .select("name, slug")
            .eq("id", handoff.clone_id)
            .maybeSingle();
          cloneName = clone?.name ?? clone?.slug ?? null;
        }
        if (!cloneName && handoff.tenant_id) {
          const { data: tenant } = await supabaseAdmin
            .from("tenants")
            .select("display_name, external_ref")
            .eq("id", handoff.tenant_id)
            .maybeSingle();
          cloneName = tenant?.display_name ?? tenant?.external_ref ?? null;
        }

        const plan = await planForTenant(handoff.tenant_id).catch(() => null);

        return storefrontJson({
          ok: true,
          current_plan_slug: plan?.slug ?? null,
          current_plan_name: plan?.name ?? null,
          handoff_id: handoff.id,
          clone_name: cloneName,
          origin_username: handoff.origin_username,
          intent: handoff.intent,
          expires_at: handoff.expires_at,
        });
      },
    },
  },
});
