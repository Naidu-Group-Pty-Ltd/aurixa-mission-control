import { createFileRoute } from "@tanstack/react-router";
import { getStripe } from "@/server/stripe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadHandoffById } from "@/server/billing-handoffs.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";

const adminAny = supabaseAdmin;

/**
 * GET /api/public/storefront/wallet?session_id=cs_…&(h=…|uid=…)
 *
 * Card-saved receipt for the storefront's post-setup page. Authorised by
 * possession of the (session_id, credential) pair: the credential must be the
 * exact one the setup session was scoped to (the handoff id in the session's
 * metadata, or a uid resolving to the session's tenant). Returns whether the
 * webhook has persisted the card yet — the page polls until `saved`.
 */
export const Route = createFileRoute("/api/public/storefront/wallet")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const sessionId = (url.searchParams.get("session_id") ?? "").trim();
        const h = (url.searchParams.get("h") ?? "").trim();
        const uid = (url.searchParams.get("uid") ?? "").trim();
        if (!sessionId.startsWith("cs_")) {
          return storefrontJson({ ok: false, error: "invalid_session_id" }, 400);
        }
        if (!!h === !!uid) {
          return storefrontJson({ ok: false, error: "credential_required" }, 400);
        }

        let session;
        try {
          session = await getStripe().checkout.sessions.retrieve(sessionId);
        } catch {
          return storefrontJson({ ok: false, error: "session_not_found" }, 404);
        }
        if (session.mode !== "setup") {
          return storefrontJson({ ok: false, error: "not_a_setup_session" }, 400);
        }

        const md = (session.metadata ?? {}) as Record<string, string>;

        // Credential must match the session's own scope.
        let returnUrl: string | null = null;
        if (h) {
          if (!md.handoff_id || md.handoff_id !== h) {
            return storefrontJson({ ok: false, error: "credential_mismatch" }, 403);
          }
          const handoff = await loadHandoffById(h);
          returnUrl = handoff?.return_url ?? null;
        } else {
          // Verify the uid governs the session's tenant: either the tenant
          // itself carries this billing_user_id, or its clone does.
          if (!md.tenant_id) {
            return storefrontJson({ ok: false, error: "credential_mismatch" }, 403);
          }
          const { data: tenant } = await adminAny
            .from("tenants")
            .select("id, clone_id, billing_user_id")
            .eq("id", md.tenant_id)
            .maybeSingle();
          let authorised = !!tenant && tenant.billing_user_id === uid;
          if (!authorised && tenant?.clone_id) {
            const { data: clone } = await adminAny
              .from("clones")
              .select("billing_user_id")
              .eq("id", tenant.clone_id)
              .maybeSingle();
            authorised = clone?.billing_user_id === uid;
          }
          if (!authorised) {
            return storefrontJson({ ok: false, error: "credential_mismatch" }, 403);
          }
        }

        const { data: row, error: lookupError } = await adminAny
          .from("payment_methods")
          .select("brand, last4, exp_month, exp_year, priority, status, created_at")
          .eq("stripe_checkout_session_id", sessionId)
          .eq("status", "active")
          .maybeSingle();
        if (lookupError) {
          // Surface backend problems (e.g. wallet tables missing) instead of
          // letting the card-saved page poll `saved:false` forever.
          return storefrontJson(
            { ok: false, error: `wallet_lookup_failed: ${lookupError.message}` },
            500,
          );
        }

        return storefrontJson({
          ok: true,
          saved: !!row,
          brand: row?.brand ?? null,
          last4: row?.last4 ?? null,
          priority: row?.priority ?? null,
          return_url: returnUrl,
        });
      },
    },
  },
});
