import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import {
  detachPaymentMethod,
  readStripeWalletTruth,
  reconcileStripeDefault,
  listActivePaymentMethods,
  MAX_PAYMENT_METHODS,
  PRIORITY_ROLES,
  reorderPaymentMethods,
} from "@/server/payment-methods.server";

/**
 * GET/POST /api/public/billing/payment-methods
 *
 * Wallet read-back + management for command centers (billing & usage page).
 * Rows are hard-scoped to the key's clone; `tenant_ref` selects (and, on GET,
 * provisions) the tenant within that scope — the same contract as
 * /api/public/tokens/balance. Cards themselves live at Stripe; these rows are
 * display references (brand / last4 / expiry) with an ordered role:
 * priority 1 = primary, 2 = secondary, 3 = backup (max 3).
 *
 * POST actions:
 *   { action: "make_primary", payment_method_id }        — promote to slot 1
 *   { action: "reorder", ordered_ids: [id, id, …] }      — full order rewrite
 *   { action: "remove", payment_method_id }              — detach + retire
 */
const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("make_primary"),
    tenant_ref: z.string().min(1).max(200),
    payment_method_id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("reorder"),
    tenant_ref: z.string().min(1).max(200),
    ordered_ids: z.array(z.string().uuid()).min(1).max(MAX_PAYMENT_METHODS),
  }),
  z.object({
    action: z.literal("remove"),
    tenant_ref: z.string().min(1).max(200),
    payment_method_id: z.string().uuid(),
  }),
  // Repair drift: push the primary card back onto the Stripe customer as its
  // default. Reordering already does this, but needing to reorder cards to fix
  // a stale default is not a repair anybody should have to discover.
  z.object({
    action: z.literal("sync_default"),
    tenant_ref: z.string().min(1).max(200),
  }),
]);

const SCOPES = ["billing:handoff", "tokens:read", "tokens:meter"];

type CloneKey = NonNullable<Awaited<ReturnType<typeof resolveCloneApiKey>>>;

async function resolveTenantId(
  key: CloneKey,
  tenantRef: string,
  provision: boolean,
): Promise<string | null> {
  if (provision) {
    const ensured = await ensureTenant(key.clone_id, tenantRef, null);
    return ensured.ok ? ensured.tenantId : null;
  }
  let tq = supabaseAdmin.from("tenants").select("id").eq("external_ref", tenantRef);
  tq = key.clone_id == null ? tq.is("clone_id", null) : tq.eq("clone_id", key.clone_id);
  const { data: tenant } = await tq.maybeSingle();
  return tenant?.id ?? null;
}

type WalletTruth = Awaited<ReturnType<typeof readStripeWalletTruth>>;

/**
 * Serialise the wallet, annotated with what Stripe actually holds.
 *
 * `priority` is this database's opinion; `is_stripe_default` is Stripe's. They
 * are reported separately and deliberately never reconciled here, because a
 * dashboard that quietly papers over the difference is how a workspace ends up
 * believing it will be charged on a card Stripe has already forgotten.
 */
function serialize(
  rows: Awaited<ReturnType<typeof listActivePaymentMethods>>,
  truth?: WalletTruth,
) {
  return rows.map((r) => ({
    stripe_payment_method_id: r.stripe_payment_method_id,
    is_stripe_default: truth?.verified
      ? truth.defaultPaymentMethodId === r.stripe_payment_method_id
      : null,
    attached_at_stripe: truth?.verified
      ? truth.attachedIds.has(r.stripe_payment_method_id)
      : null,
    id: r.id,
    brand: r.brand,
    last4: r.last4,
    exp_month: r.exp_month,
    exp_year: r.exp_year,
    funding: r.funding,
    // Cardholder as entered on Stripe's page — lets a clone label the card
    // with a person instead of just a brand and last4.
    billing_name: r.billing_name,
    billing_email: r.billing_email,
    priority: r.priority,
    role: PRIORITY_ROLES[r.priority] ?? `slot_${r.priority}`,
    origin_username: r.origin_username,
    created_at: r.created_at,
  }));
}

export const Route = createFileRoute("/api/public/billing/payment-methods")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), SCOPES);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        const rl = await checkRateLimit(key.id);
        if (!rl.ok) return jsonResponse({ ok: false, error: "rate_limited" }, 429);

        const url = new URL(request.url);
        const tenantRef = url.searchParams.get("tenant_ref");
        if (!tenantRef) return jsonResponse({ ok: false, error: "tenant_ref_required" }, 400);

        const tenantId = await resolveTenantId(key, tenantRef, true);
        if (!tenantId) return jsonResponse({ ok: false, error: "tenant_resolution_failed" }, 500);

        try {
          const rows = await listActivePaymentMethods(tenantId);
          // Read Stripe alongside the rows so the caller can show what will
          // actually be charged rather than what this table last recorded.
          const truth = await readStripeWalletTruth(rows);
          return jsonResponse({
            ok: true,
            payment_methods: serialize(rows, truth),
            max_payment_methods: MAX_PAYMENT_METHODS,
            stripe_verified: truth.verified,
            stripe_default_payment_method_id: truth.defaultPaymentMethodId,
          });
        } catch (err) {
          return jsonResponse({ ok: false, error: (err as Error).message }, 500);
        }
      },

      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), SCOPES);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        const rl = await checkRateLimit(key.id);
        if (!rl.ok) return jsonResponse({ ok: false, error: "rate_limited" }, 429);

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = ActionSchema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        }
        const data = parsed.data;

        // Mutations never provision: acting on a tenant that has no wallet
        // yet is always payment_method_not_found territory.
        const tenantId = await resolveTenantId(key, data.tenant_ref, false);
        if (!tenantId) return jsonResponse({ ok: false, error: "tenant_not_found" }, 404);

        try {
          if (data.action === "sync_default") {
            const synced = await reconcileStripeDefault(tenantId);
            if (!synced.ok) {
              return jsonResponse({ ok: false, error: "stripe_unreachable" }, 502);
            }
          } else if (data.action === "remove") {
            const result = await detachPaymentMethod(tenantId, data.payment_method_id);
            if (!result.ok) return jsonResponse(result, 400);
          } else if (data.action === "reorder") {
            const result = await reorderPaymentMethods(tenantId, data.ordered_ids);
            if (!result.ok) return jsonResponse(result, 400);
          } else {
            // make_primary: move the target to slot 1, keep the rest in order.
            const rows = await listActivePaymentMethods(tenantId);
            const target = rows.find((r) => r.id === data.payment_method_id);
            if (!target) return jsonResponse({ ok: false, error: "payment_method_not_found" }, 404);
            const ordered = [
              target.id,
              ...rows
                .filter((r) => r.id !== target.id)
                .sort((a, b) => a.priority - b.priority)
                .map((r) => r.id),
            ];
            const result = await reorderPaymentMethods(tenantId, ordered);
            if (!result.ok) return jsonResponse(result, 400);
          }

          const rows = await listActivePaymentMethods(tenantId);
          const truth = await readStripeWalletTruth(rows);
          return jsonResponse({
            ok: true,
            payment_methods: serialize(rows, truth),
            max_payment_methods: MAX_PAYMENT_METHODS,
            stripe_verified: truth.verified,
            stripe_default_payment_method_id: truth.defaultPaymentMethodId,
          });
        } catch (err) {
          return jsonResponse({ ok: false, error: (err as Error).message }, 500);
        }
      },
    },
  },
});
