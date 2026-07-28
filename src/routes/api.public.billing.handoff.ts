import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import {
  createHandoff,
  handoffUrl,
  storefrontPricingBase,
  validateReturnUrl,
} from "@/server/billing-handoffs.server";
import { normalizeBillingContact } from "@/server/billing-contact.server";

/**
 * POST /api/public/billing/handoff
 *
 * Mints a single-use, expiring deep link into the pricing/topup pages that
 * carries the originating command-center user's identity (user-attributed
 * pricing workflow, Phase 2). Identity is asserted server-to-server under the
 * clone API key — the browser only ever carries the opaque `?h=<uuid>` token,
 * so attribution cannot be spoofed from a URL.
 *
 * Auth: `x-clone-api-key` with `billing:handoff` (dedicated scope) or either
 * token scope, so pre-existing keys keep working without reissue.
 */
const Schema = z.object({
  tenant_ref: z.string().min(1).max(200),
  display_name: z.string().max(200).optional().nullable(),
  origin_user_id: z.string().min(1).max(200),
  origin_username: z.string().max(200).optional().nullable(),
  origin_source: z.string().max(100).optional().nullable(),
  intent: z.string().max(200).optional().nullable(),
  return_url: z.string().max(500).optional().nullable(),
  // Buyer contact block. Optional and best-effort: anything malformed is
  // dropped by normalizeBillingContact rather than rejected, because a
  // purchase CTA must never fail over a prefill nicety.
  contact: z
    .object({
      email: z.string().max(320).optional().nullable(),
      first_name: z.string().max(100).optional().nullable(),
      last_name: z.string().max(100).optional().nullable(),
      full_name: z.string().max(200).optional().nullable(),
      phone: z.string().max(40).optional().nullable(),
      company: z.string().max(200).optional().nullable(),
    })
    .optional()
    .nullable(),
});

export const Route = createFileRoute("/api/public/billing/handoff")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        }
        const data = parsed.data;

        // Clone context: slug feeds the default origin_source, deploy_url
        // anchors the open-redirect guard on return_url.
        let cloneSlug: string | null = null;
        let cloneDeployUrl: string | null = null;
        if (key.clone_id) {
          const { data: clone } = await supabaseAdmin
            .from("clones")
            .select("slug, deploy_url")
            .eq("id", key.clone_id)
            .maybeSingle();
          cloneSlug = clone?.slug ?? null;
          cloneDeployUrl = clone?.deploy_url ?? null;
        }

        const returnCheck = validateReturnUrl(data.return_url, cloneDeployUrl);
        if (!returnCheck.ok) return jsonResponse({ ok: false, error: returnCheck.error }, 400);

        const tenant = await ensureTenant(key.clone_id, data.tenant_ref, data.display_name);
        if (!tenant.ok) return jsonResponse(tenant, 500);

        const originSource =
          data.origin_source ||
          (key.clone_id ? `clone:${cloneSlug ?? key.clone_id}` : `prime:${data.tenant_ref}`);

        const created = await createHandoff({
          cloneId: key.clone_id,
          tenantId: tenant.tenantId,
          originUserId: data.origin_user_id,
          originUsername: data.origin_username,
          originSource,
          intent: data.intent,
          returnUrl: returnCheck.url,
          contact: normalizeBillingContact(data.contact),
        });
        if (!created.ok) return jsonResponse({ ok: false, error: created.error }, 500);

        // Handoffs land on the customer-facing Aurixa Systems pricing page
        // (PUBLIC_PRICING_SITE_URL) — never on Mission Control's operator UI.
        const pricingBase = storefrontPricingBase();

        return new Response(
          JSON.stringify({
            ok: true,
            handoff_id: created.id,
            url: handoffUrl(pricingBase, created.id),
            expires_at: created.expiresAt,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": String(rl.limit),
              "X-RateLimit-Remaining": String(Math.max(0, rl.limit - rl.count)),
            },
          },
        );
      },
    },
  },
});
