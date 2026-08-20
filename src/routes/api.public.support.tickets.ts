// POST /api/public/support/tickets — Support Portal ticket ingestion.
// GET  /api/public/support/tickets?reference=&workspace_id= — status lookup.
//
// The Aurixa Systems Support Portal's edge function forwards submissions
// here server-to-server. Authentication, rate limiting, validation,
// P0–P4 classification and self-healing kickoff all live in
// src/server/support-tickets.server.ts; this file is only the HTTP shell.
//
// Header contract (either, checked in this order):
//   x-support-signature:      sha256=<hex hmac of raw body> keyed by the
//                             `support-portal` intake source's secret
//   x-aurixa-support-secret:  shared secret (SUPPORT_INGEST_SECRET env)
//
// Body contract: see SupportTicketPayloadSchema (versioned, version 1).

import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/support/tickets")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { ingestSupportTicket } = await import("@/server/support-tickets.server");
          const outcome = await ingestSupportTicket(request);
          return json(outcome.body, outcome.status);
        } catch (err) {
          console.error("support ticket ingest failed:", (err as Error).message);
          return json({ ok: false, error: "ingest_failed" }, 500);
        }
      },
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const { getTicketStatus } = await import("@/server/support-tickets.server");
          const outcome = await getTicketStatus(
            url.searchParams.get("reference") ?? "",
            url.searchParams.get("workspace_id") ?? "",
            request.headers,
          );
          return json(outcome.body, outcome.status);
        } catch (err) {
          console.error("support ticket status lookup failed:", (err as Error).message);
          return json({ ok: false, error: "lookup_failed" }, 500);
        }
      },
    },
  },
});
