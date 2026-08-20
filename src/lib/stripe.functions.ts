// Stripe Checkout server functions (Mission Control operator surface).
// The checkout engine itself lives in src/server/checkout.server.ts and is
// shared with the storefront REST endpoint that powers the customer-facing
// pricing page on the Aurixa Systems website. The webhook
// (api/public/stripe/webhook) finalises every purchase server-side.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import { getRequestHost } from "@tanstack/react-start/server";
import { OPERATOR_SOURCE, loadValidHandoff, operatorDisplayName } from "@/server/purchases.server";
import { startCheckoutCore, startHandoffCheckout } from "@/server/checkout.server";

const InputSchema = z.object({
  mode: z.enum(["topup", "seat_plan", "setup_package"]),
  tenantId: z.string().uuid().optional(),
  cloneId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(100).default(1),
  successPath: z.string().startsWith("/").default("/billing/success"),
  cancelPath: z.string().startsWith("/").default("/billing/cancel"),
  // Server-minted single-use token that pins the originating clone user
  // (user-attributed pricing workflow; docs/user-tracking-pricing-workflow-plan.md).
  handoffId: z.string().uuid().optional(),
});

function requestOrigin(): string {
  const host = getRequestHost();
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

function withSessionPlaceholder(origin: string, path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${origin}${path}${sep}session_id={CHECKOUT_SESSION_ID}`;
}

/**
 * Operator-initiated checkout (Mission Control's discretionary purchase
 * console — buying on behalf of a client at our discretion). Customer
 * self-serve purchases go through the storefront endpoint instead.
 */
export const createStripeCheckout = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    // Resolve who initiated this purchase. A handoff token (minted server-to-
    // server under a clone API key) pins the originating clone user; otherwise
    // the purchase is attributed to the signed-in Mission Control operator.
    const handoff = data.handoffId ? await loadValidHandoff(data.handoffId) : null;
    if (data.handoffId && !handoff) {
      return { ok: false as const, error: "handoff_invalid" };
    }
    if (handoff?.clone_id && data.cloneId && handoff.clone_id !== data.cloneId) {
      return { ok: false as const, error: "handoff_clone_mismatch" };
    }
    const attribution = handoff
      ? {
          originUserId: handoff.origin_user_id,
          originUsername: handoff.origin_username,
          originSource: handoff.origin_source,
          handoffId: handoff.id,
        }
      : {
          originUserId: context.userId as string,
          originUsername: await operatorDisplayName(
            context.userId as string,
            (context.claims as { email?: string } | undefined)?.email ?? null,
          ),
          originSource: OPERATOR_SOURCE,
          handoffId: null,
        };

    const origin = requestOrigin();
    // Scope defaults come from the handoff when the caller didn't specify —
    // a handoff-initiated purchase always lands on the clone/tenant it was
    // minted for.
    return await startCheckoutCore({
      mode: data.mode,
      itemId: data.itemId,
      quantity: data.quantity,
      cloneId: data.cloneId ?? handoff?.clone_id ?? null,
      tenantId: data.tenantId ?? handoff?.tenant_id ?? undefined,
      successUrl: withSessionPlaceholder(origin, data.successPath),
      cancelUrl: `${origin}${data.cancelPath}`,
      attribution,
      handoffToConsume: handoff?.id ?? null,
    });
  });

const HandoffCheckoutSchema = z.object({
  handoffId: z.string().uuid(),
  mode: z.enum(["topup", "seat_plan", "setup_package"]),
  itemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
});

/**
 * Handoff-scoped checkout for pages served by Mission Control itself
 * (operator consoles following attributed links). The customer storefront
 * uses the REST equivalent (api/public/storefront/checkout), which redirects
 * back to the storefront's own success/cancel pages.
 */
export const createHandoffCheckout = createServerFn({ method: "POST" })
  .inputValidator((input) => HandoffCheckoutSchema.parse(input))
  .handler(async ({ data }) => {
    const origin = requestOrigin();
    const h = encodeURIComponent(data.handoffId);
    return await startHandoffCheckout({
      handoffId: data.handoffId,
      mode: data.mode,
      itemId: data.itemId,
      quantity: data.quantity,
      // The h param lets the success/cancel pages do a non-operator lookup
      // (session_id + matching handoff pair) and offer the return link.
      successUrl: withSessionPlaceholder(origin, `/billing/success?h=${h}`),
      cancelUrl: `${origin}/billing/cancel?h=${h}`,
    });
  });
