import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { planForBillingUserId } from "@/server/current-plan.server";

/**
 * GET /api/public/storefront/identity?uid=<billing_user_id>
 *
 * Display-safe resolution of an operator-assigned tracking id for the Aurixa
 * Systems pricing page: the storefront shows "Purchasing for <clone>" and
 * enables its buy CTAs. The uid is a stable, non-secret key (unlike a handoff
 * it is reusable), so this only ever returns non-PII display fields; the
 * actual scope is re-resolved server-side at checkout.
 */
export const Route = createFileRoute("/api/public/storefront/identity")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const uid = (url.searchParams.get("uid") ?? "").trim();
        if (!uid || uid.length > 200) {
          return storefrontJson({ ok: false, error: "uid_invalid" }, 400);
        }

        // Prefer a clone match (admins set billing_user_id on the clone); fall
        // back to a global/prime tenant carrying the id.
        const { data: clone } = await supabaseAdmin
          .from("clones")
          .select("name, slug")
          .eq("billing_user_id", uid)
          .maybeSingle();

        let cloneName: string | null = clone?.name ?? clone?.slug ?? null;
        if (!cloneName) {
          const { data: tenant } = await supabaseAdmin
            .from("tenants")
            .select("display_name, external_ref")
            .eq("billing_user_id", uid)
            .maybeSingle();
          if (!tenant) return storefrontJson({ ok: false, error: "uid_unknown" }, 404);
          cloneName = tenant.display_name ?? tenant.external_ref ?? null;
        }

        // Best-effort: the pricing page only uses this to label its buttons,
        // and a workspace should never fail to load pricing because its plan
        // lookup did.
        const plan = await planForBillingUserId(uid).catch(() => null);

        return storefrontJson({
          ok: true,
          uid,
          clone_name: cloneName,
          origin_username: null,
          current_plan_slug: plan?.slug ?? null,
          current_plan_name: plan?.name ?? null,
        });
      },
    },
  },
});
