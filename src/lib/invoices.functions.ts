// Operator queries over the invoice mirror + saved-card wallet
// (billing & usage workflow). Both tables postdate the generated DB types,
// hence the service-role `adminAny` escape hatch (requireOperator-gated).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { invoicePdfFilename, renderStripeInvoicePdf } from "@/server/invoice-pdf.server";
import { buildInvoiceDocument } from "@/lib/brand/invoiceDocument.pure";

const adminAny = supabaseAdmin;

const STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;

const ListSchema = z.object({
  cloneId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  status: z.enum(STATUSES).optional(),
  /** Matches number, origin_username, item_slug or item_name (ilike). */
  search: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const listInvoices = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => ListSchema.parse(input))
  .handler(async ({ data }) => {
    let q = adminAny
      .from("invoices")
      .select(
        "id, created_at, issued_at, paid_at, number, status, description, mode, item_slug, item_name, " +
          "amount_due_cents, amount_paid_cents, total_cents, currency, hosted_invoice_url, invoice_pdf_url, " +
          "origin_user_id, origin_username, origin_source, clone_id, tenant_id, stripe_invoice_id, purchase_id, clones(name)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);

    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    if (data.tenantId) q = q.eq("tenant_id", data.tenantId);
    if (data.status) q = q.eq("status", data.status);
    if (data.from) q = q.gte("created_at", data.from);
    if (data.to) q = q.lte("created_at", data.to);
    if (data.search) {
      const term = data.search.replaceAll("%", "\\%").replaceAll(",", " ");
      q = q.or(
        `number.ilike.%${term}%,origin_username.ilike.%${term}%,item_slug.ilike.%${term}%,item_name.ilike.%${term}%`,
      );
    }

    const { data: rows, count, error } = await q;
    if (error) return { ok: false as const, error: error.message };

    const invoices = (rows ?? []).map((r: any) => ({
      ...r,
      clone_name: r.clones?.name ?? null,
      clones: undefined,
    }));
    return {
      ok: true as const,
      invoices,
      total: count ?? 0,
      hasMore: data.offset + invoices.length < (count ?? 0),
    };
  });

/** Saved cards across the fleet (display references only — brand/last4/expiry). */
export const listPaymentMethodsAdmin = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid().optional(),
        includeDetached: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let q = adminAny
      .from("payment_methods")
      .select(
        "id, created_at, detached_at, status, priority, brand, last4, exp_month, exp_year, funding, " +
          "origin_username, origin_source, clone_id, tenant_id, clones(name), tenants(display_name, external_ref)",
      )
      .order("tenant_id", { ascending: true })
      .order("priority", { ascending: true })
      .limit(data.limit);

    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    if (!data.includeDetached) q = q.eq("status", "active");

    const { data: rows, error } = await q;
    if (error) return { ok: false as const, error: error.message };

    const paymentMethods = (rows ?? []).map((r: any) => ({
      ...r,
      clone_name: r.clones?.name ?? null,
      tenant_name: r.tenants?.display_name ?? r.tenants?.external_ref ?? null,
      clones: undefined,
      tenants: undefined,
    }));
    return { ok: true as const, paymentMethods };
  });

/**
 * The dark Aurixa tax invoice for one mirrored invoice, base64-encoded.
 *
 * Base64 rather than a streamed response because server fns speak JSON; the
 * operator UI turns it back into a Blob. Invoices are one page, so the ~1.3x
 * encoding cost is measured in kilobytes.
 *
 * Stripe's own white PDF is still on the row as `invoice_pdf_url` and is still
 * the system of record — this is the branded presentation of the same figures.
 */
export const renderDarkInvoicePdf = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ stripeInvoiceId: z.string().min(3).max(120) }).parse(input))
  .handler(async ({ data }) => {
    // Through the mirror, not straight to Stripe: an operator id typed into
    // this endpoint should only ever resolve to an invoice this deployment
    // actually knows about.
    const { data: row } = await adminAny
      .from("invoices")
      .select("stripe_invoice_id, number")
      .eq("stripe_invoice_id", data.stripeInvoiceId)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "invoice_not_found" };

    try {
      const pdf = await renderStripeInvoicePdf(data.stripeInvoiceId);
      let binary = "";
      for (const byte of pdf) binary += String.fromCharCode(byte);
      return {
        ok: true as const,
        filename: invoicePdfFilename(
          buildInvoiceDocument({ number: row.number, id: data.stripeInvoiceId, total: 0 }),
        ),
        base64: btoa(binary),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
