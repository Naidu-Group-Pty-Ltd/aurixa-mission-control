import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { resolveStorefrontAccess } from "@/server/storefront-access.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";

/**
 * POST /api/public/storefront/access
 *
 * The single authority on whether a pricing-page visitor may see the
 * restricted sections. The storefront calls this BEFORE serving add-on
 * modules, onboarding packages or report economics — the gate lives with the
 * data, not with the rendering.
 *
 * Returns only a boolean, a reason and a display label. It never says which
 * grants exist, and a wrong token is answered the same way as a missing one
 * so the endpoint cannot be used to test tokens for validity beyond the one
 * that was actually presented.
 */
const Schema = z.object({
  h: z.string().uuid().optional().nullable(),
  uid: z.string().max(200).optional().nullable(),
  access: z.string().max(100).optional().nullable(),
});

export const Route = createFileRoute("/api/public/storefront/access")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const parsed = Schema.safeParse(body ?? {});
        if (!parsed.success) {
          return storefrontJson({ ok: true, granted: false, reason: "no_credential" });
        }
        const { h, uid, access } = parsed.data;

        try {
          const decision = await resolveStorefrontAccess({ h, uid, token: access });
          return storefrontJson({ ok: true, ...decision });
        } catch (err) {
          // Fail CLOSED. This gate exists to keep commercial detail off the
          // open web, so an error must not become an accidental grant.
          console.error("storefront access check failed", err);
          return storefrontJson({ ok: true, granted: false, reason: "no_credential" });
        }
      },
    },
  },
});
