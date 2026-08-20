import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

/**
 * GET /api/public/billing/invoices
 *
 * Invoice read-back for command centers (billing & usage page). Rows come
 * from the `invoices` mirror the Stripe webhook maintains (subscription
 * cycles + one-time purchases via invoice_creation) and are hard-scoped to
 * the key's clone; optional `?tenant_ref=` narrows to one tenant and
 * `?status=` filters by Stripe lifecycle state. Hosted/PDF links point at
 * Stripe's customer-safe invoice pages.
 */
export const Route = createFileRoute("/api/public/billing/invoices")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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

        const url = new URL(request.url);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 25) || 25));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const statusParam = url.searchParams.get("status");
        const allowedStatuses = ["draft", "open", "paid", "void", "uncollectible"];
        if (statusParam && !allowedStatuses.includes(statusParam)) {
          return jsonResponse({ ok: false, error: "invalid_status" }, 400);
        }

        // Optional tenant narrowing, resolved strictly inside this key's clone.
        let tenantId: string | null = null;
        const tenantRef = url.searchParams.get("tenant_ref");
        if (tenantRef) {
          let tq = supabaseAdmin.from("tenants").select("id").eq("external_ref", tenantRef);
          tq = key.clone_id == null ? tq.is("clone_id", null) : tq.eq("clone_id", key.clone_id);
          const { data: tenant } = await tq.maybeSingle();
          if (!tenant) {
            return jsonResponse({
              ok: true,
              invoices: [],
              pagination: { limit, offset, total: 0, has_more: false, next_offset: null },
            });
          }
          tenantId = tenant.id;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adminAny = supabaseAdmin;
        let q = adminAny
          .from("invoices")
          .select(
            "id, created_at, issued_at, paid_at, number, status, description, mode, item_slug, item_name, " +
              "amount_due_cents, amount_paid_cents, subtotal_cents, tax_cents, total_cents, currency, " +
              "hosted_invoice_url, invoice_pdf_url, origin_user_id, origin_username, origin_source, " +
              "period_start, period_end, stripe_invoice_id, purchase_id",
            { count: "exact" },
          )
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

        // Hard clone scoping — the key IS the boundary.
        q = key.clone_id == null ? q.is("clone_id", null) : q.eq("clone_id", key.clone_id);
        if (tenantId) q = q.eq("tenant_id", tenantId);
        if (statusParam) q = q.eq("status", statusParam);

        const { data: rows, count, error } = await q;
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        const total = count ?? 0;
        return jsonResponse({
          ok: true,
          invoices: rows ?? [],
          pagination: {
            limit,
            offset,
            total,
            has_more: offset + (rows?.length ?? 0) < total,
            next_offset: offset + (rows?.length ?? 0) < total ? offset + limit : null,
          },
        });
      },
    },
  },
});
