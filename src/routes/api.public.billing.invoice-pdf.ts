/**
 * GET /api/public/billing/invoice-pdf?invoice=in_…
 *
 * The dark Aurixa tax invoice for one Stripe invoice, as a PDF.
 *
 * Stripe's own PDF is white and cannot be made otherwise; this is the branded
 * presentation of the same figures. Both are offered — `invoice_pdf_url` on the
 * list endpoint still points at Stripe's, which remains the system of record.
 *
 * Authorisation is the same boundary as the list endpoint next door: the clone
 * API key IS the scope. The lookup goes through the `invoices` mirror rather
 * than straight to Stripe precisely so that a key can only ever name an invoice
 * inside its own clone — asking Stripe first would render any invoice on the
 * account to anyone holding any key.
 */
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { invoicePdfFilename, renderStripeInvoicePdf } from "@/server/invoice-pdf.server";
import { buildInvoiceDocument } from "@/lib/brand/invoiceDocument.pure";

export const Route = createFileRoute("/api/public/billing/invoice-pdf")({
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
          return jsonResponse(
            { ok: false, error: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
            429,
          );
        }

        const stripeInvoiceId = new URL(request.url).searchParams.get("invoice")?.trim();
        if (!stripeInvoiceId) return jsonResponse({ ok: false, error: "missing_invoice" }, 400);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adminAny = supabaseAdmin;
        let q = adminAny
          .from("invoices")
          .select("stripe_invoice_id, number, clone_id")
          .eq("stripe_invoice_id", stripeInvoiceId);
        q = key.clone_id == null ? q.is("clone_id", null) : q.eq("clone_id", key.clone_id);
        const { data: row } = await q.maybeSingle();
        // Deliberately the same answer for "no such invoice" and "not yours":
        // a distinguishable 403 would confirm the existence of another clone's
        // invoice to anyone willing to iterate ids.
        if (!row) return jsonResponse({ ok: false, error: "not_found" }, 404);

        let pdf: Uint8Array;
        try {
          pdf = await renderStripeInvoicePdf(stripeInvoiceId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[invoice-pdf] render failed:", message);
          return jsonResponse({ ok: false, error: "render_failed" }, 502);
        }

        const filename = invoicePdfFilename(
          // Only the number is needed for the filename, and it is already on the
          // mirror row — re-fetching the invoice to name the file it is attached
          // to would double the Stripe call for nothing.
          buildInvoiceDocument({ number: row.number, id: stripeInvoiceId, total: 0 }),
        );

        // `pdf.buffer` rather than the view: a Uint8Array is a valid body at
        // runtime but not in the DOM lib's BodyInit union, and slicing to the
        // view's own bounds keeps that correct if pdf-lib ever hands back a
        // subarray of a larger buffer.
        const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
        return new Response(body as ArrayBuffer, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${filename}"`,
            // A finalised invoice never changes, but a draft can, so this is
            // short rather than immutable.
            "Cache-Control": "private, max-age=300",
          },
        });
      },
    },
  },
});
