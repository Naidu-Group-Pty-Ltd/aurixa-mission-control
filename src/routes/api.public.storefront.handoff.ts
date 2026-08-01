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

        // Add-ons held, so the storefront can gate documentation the same way
        // the clone's own user guide does. Tier alone cannot answer it: a
        // separately-sold module carries an empty tier list, so a Launch
        // workspace that bought Market Updates looks identical to one that did
        // not unless the add-ons travel too.
        //
        // Wrapped like the balance endpoint's copy of this query: a docs page
        // is not worth failing a handoff resolution over. An empty list means
        // "none known", which the gate treats as no add-ons rather than as an
        // error — the tier entitlements still resolve normally.
        let addonSlugs: string[] = [];
        if (handoff.clone_id) {
          try {
            const { data: addons } = await supabaseAdmin
              .from("clone_addon_purchases")
              .select("addon_slug")
              .eq("clone_id", handoff.clone_id)
              .in("status", ["active", "past_due"]);
            addonSlugs = [...new Set((addons ?? []).map((a) => a.addon_slug))].sort();
          } catch (err) {
            console.warn("[storefront/handoff] add-on entitlements unavailable", err);
          }
        }

        return storefrontJson({
          ok: true,
          current_plan_slug: plan?.slug ?? null,
          current_plan_name: plan?.name ?? null,
          addon_slugs: addonSlugs,
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
