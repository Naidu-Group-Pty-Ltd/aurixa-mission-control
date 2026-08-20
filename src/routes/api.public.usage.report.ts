/**
 * Ingest for third-party API usage made on the prime's forwarded vendor keys.
 *
 * A clone provisioned by Mission Control boots with our own OpenAI, Resend,
 * Domain, Cotality (and the rest) keys written into its Supabase project. Every
 * call it makes on one of those is billed to our vendor account, so this is
 * where it becomes attributable: the clone posts what it consumed, we decide
 * whether it ran on our key or theirs, and only the former is charged.
 *
 * Batched rather than per-call, because the reporting hop must never sit in the
 * path of a tenant's request. The clone buffers and flushes; this endpoint
 * takes up to 200 events at once and rates each one independently, so one bad
 * event in a batch cannot cost us the other 199.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { normalizeEvent, type BillingReason } from "@/lib/api-usage-rating";

/** A batch is a flush, not a call. One a minute per clone is plenty, and the
 *  60/min key limit is shared with the token API — keep batches large. */
const MAX_EVENTS = 200;

const Schema = z.object({
  tenant_ref: z.string().min(1).max(200),
  display_name: z.string().max(200).optional().nullable(),
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS),
});

type EventOutcome = {
  idempotency_key: string;
  ok: boolean;
  billable?: boolean;
  billing_reason?: BillingReason;
  duplicate?: boolean;
  error?: string;
};

export const Route = createFileRoute("/api/public/usage/report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "usage:report",
        );
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

        const tenant = await ensureTenant(
          key.clone_id,
          data.tenant_ref,
          data.display_name ?? undefined,
        );
        if (!tenant.ok) return jsonResponse(tenant, 500);

        const now = new Date();
        const results: EventOutcome[] = [];
        let accepted = 0;
        let billableCount = 0;
        let rejected = 0;

        for (const raw of data.events) {
          const norm = normalizeEvent(raw, now);
          if (norm.ok === false) {
            rejected += 1;
            results.push({
              idempotency_key:
                typeof (raw as { idempotency_key?: unknown })?.idempotency_key === "string"
                  ? (raw as { idempotency_key: string }).idempotency_key
                  : "",
              ok: false,
              error: norm.error,
            });
            continue;
          }
          const e = norm.event;

          // The rating decision — is this our key or theirs, and what is it
          // worth — is made inside the RPC so the billability lookup, the event
          // insert and the rollup update share one transaction. Splitting them
          // would let a crash between insert and rollup silently lose revenue.
          const { data: result, error } = await supabaseAdmin.rpc("record_api_usage_event", {
            _tenant_id: tenant.tenantId,
            // `record_api_usage_event(_clone_id uuid, ...)` accepts NULL — a
            // platform-level API key has no clone — but the generated types call the
            // parameter required and non-null, because the generator reads "no SQL
            // default" as "not nullable". NULL has to reach the function.
            _clone_id: key.clone_id as unknown as string,
            _secret_name: e.secret_name,
            _quantity: e.quantity,
            _idempotency_key: e.idempotency_key,
            // DEFAULT NULL on both: omitting the key and sending null are the same
            // row, and only omission typechecks.
            _model: e.model ?? undefined,
            _feature: e.feature ?? undefined,
            _call_status: e.status,
            _occurred_at: e.occurred_at,
            _metadata: e.metadata as never,
          });

          if (error) {
            rejected += 1;
            results.push({ idempotency_key: e.idempotency_key, ok: false, error: error.message });
            continue;
          }

          const r = (result ?? {}) as {
            ok?: boolean;
            billable?: boolean;
            billing_reason?: BillingReason;
            duplicate?: boolean;
            error?: string;
          };
          if (!r.ok) {
            rejected += 1;
            results.push({
              idempotency_key: e.idempotency_key,
              ok: false,
              error: r.error ?? "rating_failed",
            });
            continue;
          }

          accepted += 1;
          if (r.billable) billableCount += 1;
          results.push({
            idempotency_key: e.idempotency_key,
            ok: true,
            billable: Boolean(r.billable),
            billing_reason: r.billing_reason,
            duplicate: Boolean(r.duplicate),
          });
        }

        // A partially-rejected batch is still a success at the transport level:
        // the clone must not replay 200 accepted events because one was
        // malformed. Per-event outcomes tell it exactly what to drop.
        return jsonResponse(
          {
            ok: true,
            tenant_id: tenant.tenantId,
            accepted,
            rejected,
            billable: billableCount,
            results,
          },
          200,
        );
      },
    },
  },
});
