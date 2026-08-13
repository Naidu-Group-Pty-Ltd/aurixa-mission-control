// @ts-nocheck
// POST /api/public/support/assistant-activity — the Support Portal's
// screening assistant forwards one record per question it handles, carrying
// the workspace_id and user_id the portal took from the dashboard, so
// assistant conversations are traceable per tenant alongside their tickets.
//
// Machine-to-machine only: requires the support-portal HMAC signature
// (x-support-signature) or the SUPPORT_INGEST_SECRET header — there is no
// open mode here, unlike ticket ingest. Logic lives in
// src/server/support-tickets.server.ts (ingestAssistantActivity).

import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/support/assistant-activity")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { ingestAssistantActivity } = await import("@/server/support-tickets.server");
          const outcome = await ingestAssistantActivity(request);
          return json(outcome.body, outcome.status);
        } catch (err) {
          console.error("assistant activity ingest failed:", (err as Error).message);
          return json({ ok: false, error: "ingest_failed" }, 500);
        }
      },
    },
  },
});
