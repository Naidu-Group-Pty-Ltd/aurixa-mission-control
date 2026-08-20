// Server-only ingest core for the Support Portal ticket pipeline.
//
// The public route (/api/public/support/tickets) hands the raw request in
// here. This module authenticates the caller, applies the sliding-window
// rate limit, validates the payload, classifies the ticket P0–P4
// (src/lib/ticket-classification.ts — deterministic, unit-tested), writes
// the ticket + audit events, raises the operator notification, and kicks
// the eligible ones into the self-healing planner.
//
// Authentication is layered like the security intake route: if the
// `support-portal` row in `security_intake_sources` carries an HMAC
// secret, a valid `x-support-signature` over the raw body is required.
// Otherwise, if SUPPORT_INGEST_SECRET is set in the environment, the
// `x-aurixa-support-secret` header must match (constant-time). With
// neither configured the endpoint still ingests — the portal form is
// public by nature and the rate limit is the real gate — but the ticket
// is marked unverified in metadata so operators can see the difference.

import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BREAKAGE_VECTORS, TICKET_CATEGORIES, classifyTicket } from "@/lib/ticket-classification";

export const SUPPORT_SOURCE_SLUG = "support-portal";

// Sliding-window caps. The portal's own edge function throttles harder;
// these bound direct hits on the public endpoint.
const IP_WINDOW_MINUTES = 15;
const IP_WINDOW_LIMIT = 8;
const IP_DAY_LIMIT = 40;
const WORKSPACE_WINDOW_LIMIT = 12;

const MAX_BODY_BYTES = 64 * 1024;

const ClientMetaSchema = z
  .object({
    source: z.string().max(40).optional(),
    url: z.string().max(500).optional(),
    user_agent: z.string().max(400).optional(),
  })
  .partial()
  .optional();

export const SupportTicketPayloadSchema = z.object({
  version: z.union([z.literal(1), z.literal("1")]).default(1),
  workspace_id: z.string().trim().min(1).max(120),
  user_id: z.string().trim().max(120).optional().nullable(),
  reporter_name: z.string().trim().max(120).optional().nullable(),
  reporter_email: z.string().trim().email().max(320),
  category: z.enum(TICKET_CATEGORIES),
  breakage_vector: z.enum(BREAKAGE_VECTORS).default("none"),
  subject: z.string().trim().min(4).max(160),
  description: z.string().trim().min(20).max(5000),
  impact: z.string().trim().max(1000).optional().nullable(),
  client_meta: ClientMetaSchema,
});

export type IngestOutcome = { status: number; body: Record<string, unknown> };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** First hop of x-forwarded-for, or a stable fallback so hashing never throws. */
export function clientIpFrom(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("cf-connecting-ip") ?? "unknown";
}

type AuthResult =
  | { ok: true; verified: boolean; mode: string }
  | { ok: false; status: number; error: string };

async function verifySupportAuth(rawBody: string, headers: Headers): Promise<AuthResult> {
  const admin = supabaseAdmin;
  const { data: source } = await admin
    .from("security_intake_sources")
    .select("slug, active, hmac_secret")
    .eq("slug", SUPPORT_SOURCE_SLUG)
    .maybeSingle();

  if (!source) return { ok: false, status: 503, error: "support intake source not provisioned" };
  if (!source.active) return { ok: false, status: 403, error: "support intake disabled" };

  if (source.hmac_secret) {
    const { verifyIntakeSignature } = await import("@/server/security-intake/signature");
    const valid = await verifyIntakeSignature(
      rawBody,
      headers.get("x-support-signature") ?? headers.get("x-intake-signature"),
      source.hmac_secret,
    );
    if (!valid) return { ok: false, status: 401, error: "invalid signature" };
    return { ok: true, verified: true, mode: "hmac" };
  }

  const sharedSecret = process.env.SUPPORT_INGEST_SECRET;
  if (sharedSecret) {
    const provided = headers.get("x-aurixa-support-secret") ?? "";
    if (!constantTimeEqual(provided, sharedSecret)) {
      return { ok: false, status: 401, error: "invalid support secret" };
    }
    return { ok: true, verified: true, mode: "shared_secret" };
  }

  return { ok: true, verified: false, mode: "open" };
}

type RateLimitResult = { limited: false } | { limited: true; retryAfterSeconds: number };

async function checkRateLimit(
  ipHash: string,
  workspaceId: string | null,
): Promise<RateLimitResult> {
  const admin = supabaseAdmin;
  try {
    // Record first so failed validations count against the window too.
    await admin
      .from("support_ingest_requests")
      .insert({ ip_hash: ipHash, workspace_id: workspaceId });

    const windowStart = new Date(Date.now() - IP_WINDOW_MINUTES * 60_000).toISOString();
    const dayStart = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

    const { count: ipRecent } = await admin
      .from("support_ingest_requests")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", windowStart);
    if ((ipRecent ?? 0) > IP_WINDOW_LIMIT) {
      return { limited: true, retryAfterSeconds: IP_WINDOW_MINUTES * 60 };
    }

    const { count: ipDay } = await admin
      .from("support_ingest_requests")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", dayStart);
    if ((ipDay ?? 0) > IP_DAY_LIMIT) {
      return { limited: true, retryAfterSeconds: 24 * 60 * 60 };
    }

    if (workspaceId) {
      const { count: wsRecent } = await admin
        .from("support_ingest_requests")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .gte("created_at", windowStart);
      if ((wsRecent ?? 0) > WORKSPACE_WINDOW_LIMIT) {
        return { limited: true, retryAfterSeconds: IP_WINDOW_MINUTES * 60 };
      }
    }
  } catch (err) {
    // The limiter failing must not take support down with it — but say so,
    // because a quietly dead limiter is an open faucet.
    console.error("support ingest rate limiter unavailable:", (err as Error).message);
  }
  return { limited: false };
}

async function resolveWorkspace(workspaceId: string): Promise<{
  cloneId: string | null;
  tenantId: string | null;
  resolution: string;
}> {
  const admin = supabaseAdmin;
  const { data: clone } = await admin
    .from("clones")
    .select("id")
    .eq("slug", workspaceId)
    .maybeSingle();
  if (clone?.id) return { cloneId: clone.id, tenantId: null, resolution: "clone_slug" };

  const { data: tenant } = await admin
    .from("tenants")
    .select("id, clone_id")
    .eq("external_ref", workspaceId)
    .limit(1)
    .maybeSingle();
  if (tenant?.id) {
    return {
      cloneId: tenant.clone_id ?? null,
      tenantId: tenant.id,
      resolution: "tenant_external_ref",
    };
  }

  // Prime installs (e.g. "npc-prime") and unknown workspaces land here;
  // clone_id null means "prime scope" to the remediation planner.
  return { cloneId: null, tenantId: null, resolution: "unresolved" };
}

function makeReference(): string {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `TKT-${Date.now().toString(36).toUpperCase()}${rand}`;
}

function zodFieldErrors(err: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

export async function ingestSupportTicket(request: Request): Promise<IngestOutcome> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: "payload_too_large" } };
  }

  const auth = await verifySupportAuth(raw, request.headers);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  // Rate-limit before validation so malformed floods still hit the wall.
  const ipHash = await sha256Hex(clientIpFrom(request.headers));
  const workspaceForLimit =
    typeof (parsedJson as any)?.workspace_id === "string"
      ? ((parsedJson as any).workspace_id as string).slice(0, 120)
      : null;
  const limit = await checkRateLimit(ipHash, workspaceForLimit);
  if (limit.limited) {
    return {
      status: 429,
      body: { ok: false, error: "throttled", retry_after_seconds: limit.retryAfterSeconds },
    };
  }

  const parsed = SupportTicketPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", fields: zodFieldErrors(parsed.error) },
    };
  }
  const payload = parsed.data;

  const admin = supabaseAdmin;
  const workspace = await resolveWorkspace(payload.workspace_id);
  const classification = classifyTicket({
    category: payload.category,
    breakageVector: payload.breakage_vector,
    subject: payload.subject,
    description: payload.description,
    impact: payload.impact ?? null,
  });

  const slaDueAt = new Date(Date.now() + classification.slaMinutes * 60_000).toISOString();
  const reference = makeReference();

  const { data: ticket, error: insertErr } = await admin
    .from("support_tickets")
    .insert({
      reference,
      source_slug: SUPPORT_SOURCE_SLUG,
      workspace_id: payload.workspace_id,
      clone_id: workspace.cloneId,
      tenant_id: workspace.tenantId,
      user_external_id: payload.user_id ?? null,
      reporter_name: payload.reporter_name ?? null,
      reporter_email: payload.reporter_email,
      category: payload.category,
      breakage_vector: payload.breakage_vector,
      subject: payload.subject,
      description: payload.description,
      impact: payload.impact ?? null,
      priority: classification.priority,
      priority_score: classification.score,
      classification,
      requires_human: classification.requiresHuman,
      auto_remediable: classification.autoRemediable,
      remediation_lane: classification.lane,
      status: "triaged",
      sla_due_at: slaDueAt,
      client_meta: payload.client_meta ?? {},
      metadata: {
        workspace_resolution: workspace.resolution,
        auth_mode: auth.mode,
        verified_source: auth.verified,
      },
    })
    .select("id, reference, priority, status, sla_due_at")
    .single();
  if (insertErr) {
    console.error("support ticket insert failed:", insertErr.message);
    return { status: 500, body: { ok: false, error: "ingest_failed" } };
  }

  await admin.from("support_ticket_events").insert([
    {
      ticket_id: ticket.id,
      event_type: "ticket.created",
      payload: {
        source: payload.client_meta?.source ?? null,
        verified_source: auth.verified,
        auth_mode: auth.mode,
        workspace_resolution: workspace.resolution,
      },
    },
    {
      ticket_id: ticket.id,
      event_type: "ticket.classified",
      payload: classification,
    },
  ]);

  // One notification per ticket; severity tracks the priority band.
  const notifSeverity =
    classification.priority === "P0"
      ? "error"
      : classification.priority === "P1"
        ? "warning"
        : "info";
  await admin.from("notifications").insert({
    kind: "support_ticket_created",
    severity: notifSeverity,
    title: `${classification.priority} support ticket · ${payload.category.replace(/_/g, " ")}`,
    body: `${reference} — ${payload.subject} (workspace ${payload.workspace_id})`,
    clone_id: workspace.cloneId,
    url: "/support/tickets",
    metadata: { ticket_id: ticket.id, reference, priority: classification.priority },
  });

  // Self-healing: plan runs for auto-remediable tickets. Failure to plan
  // must not fail the ingest — the ticket exists either way and the drain
  // sweep will surface planless "remediating" tickets as triaged.
  let autoRemediation: "queued" | "human_review" | "none" = "none";
  if (classification.requiresHuman) {
    autoRemediation = "human_review";
  } else if (classification.autoRemediable) {
    try {
      const { planTicketRemediation } = await import("@/server/self-healing.server");
      const planned = await planTicketRemediation(ticket.id);
      if (planned.runsPlanned > 0) {
        autoRemediation = "queued";
        await admin.from("support_tickets").update({ status: "remediating" }).eq("id", ticket.id);
        ticket.status = "remediating";
      }
    } catch (err) {
      console.error("remediation planning failed:", (err as Error).message);
      await admin.from("support_ticket_events").insert({
        ticket_id: ticket.id,
        event_type: "remediation.plan_failed",
        payload: { error: (err as Error).message },
      });
    }
  }

  return {
    status: 201,
    body: {
      ok: true,
      ticket: {
        reference: ticket.reference,
        priority: ticket.priority,
        status: ticket.status,
        sla_due_at: ticket.sla_due_at,
        auto_remediation: autoRemediation,
      },
    },
  };
}

/**
 * Status lookup for the portal's "check my ticket" flow. Requires both the
 * reference AND the workspace id so a reference alone (guessable format)
 * discloses nothing across workspaces; the response carries no PII.
 */
export async function getTicketStatus(
  reference: string,
  workspaceId: string,
  headers: Headers,
): Promise<IngestOutcome> {
  if (!reference || !workspaceId) {
    return { status: 400, body: { ok: false, error: "reference and workspace_id required" } };
  }

  const ipHash = await sha256Hex(clientIpFrom(headers));
  const limit = await checkRateLimit(ipHash, workspaceId);
  if (limit.limited) {
    return {
      status: 429,
      body: { ok: false, error: "throttled", retry_after_seconds: limit.retryAfterSeconds },
    };
  }

  const admin = supabaseAdmin;
  const { data: ticket } = await admin
    .from("support_tickets")
    .select("reference, status, priority, created_at, resolved_at")
    .eq("reference", reference.trim().toUpperCase())
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!ticket) return { status: 404, body: { ok: false, error: "not_found" } };
  return { status: 200, body: { ok: true, ticket } };
}

// ── Assistant activity feed ──────────────────────────────────────────────

const AssistantActivitySchema = z.object({
  version: z.union([z.literal(1), z.literal("1")]).default(1),
  workspace_id: z.string().trim().max(120).optional().nullable(),
  user_id: z.string().trim().max(120).optional().nullable(),
  question: z.string().trim().min(1).max(500),
  mode: z.enum(["model", "retrieval", "no_match", "escalate"]),
  escalated: z.boolean().default(false),
  escalate_reason: z.string().trim().max(300).optional().nullable(),
  latency_ms: z.number().int().min(0).max(600_000).optional().nullable(),
  source: z.string().trim().max(40).optional().nullable(),
  asked_at: z.string().datetime({ offset: true }).optional().nullable(),
});

// The forwarder retries nothing and drops are fine — this cap only stops a
// compromised or looping sender from flooding the table.
const ACTIVITY_WINDOW_MINUTES = 15;
const ACTIVITY_WINDOW_LIMIT = 120;

/**
 * POST /api/public/support/assistant-activity — one row per question the
 * Support Portal's screening assistant handled, carrying the workspace and
 * user identity the portal took from the dashboard.
 *
 * Machine-to-machine only: unlike ticket ingest there is no open mode —
 * a valid per-source HMAC signature or the shared secret is REQUIRED,
 * because nothing interactive ever calls this.
 */
export async function ingestAssistantActivity(request: Request): Promise<IngestOutcome> {
  const raw = await request.text();
  if (raw.length > 32 * 1024) {
    return { status: 413, body: { ok: false, error: "payload_too_large" } };
  }

  const auth = await verifySupportAuth(raw, request.headers);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };
  if (!auth.verified) {
    return { status: 401, body: { ok: false, error: "signature required" } };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  const parsed = AssistantActivitySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", fields: zodFieldErrors(parsed.error) },
    };
  }
  const payload = parsed.data;
  const admin = supabaseAdmin;

  const workspaceId = payload.workspace_id ?? null;
  if (workspaceId) {
    const { count } = await admin
      .from("support_assistant_activity")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte(
        "created_at",
        new Date(Date.now() - ACTIVITY_WINDOW_MINUTES * 60_000).toISOString(),
      );
    if ((count ?? 0) >= ACTIVITY_WINDOW_LIMIT) {
      return { status: 202, body: { ok: true, dropped: true, reason: "workspace_flood_cap" } };
    }
  }

  const workspace = workspaceId
    ? await resolveWorkspace(workspaceId)
    : { cloneId: null, tenantId: null, resolution: "absent" };

  const { error } = await admin.from("support_assistant_activity").insert({
    workspace_id: workspaceId,
    clone_id: workspace.cloneId,
    tenant_id: workspace.tenantId,
    user_external_id: payload.user_id ?? null,
    question: payload.question,
    mode: payload.mode,
    escalated: payload.escalated,
    escalate_reason: payload.escalate_reason ?? null,
    latency_ms: payload.latency_ms ?? null,
    source: payload.source ?? null,
    verified_source: auth.verified,
    asked_at: payload.asked_at ?? null,
  });
  if (error) {
    console.error("assistant activity insert failed:", error.message);
    return { status: 500, body: { ok: false, error: "ingest_failed" } };
  }

  return { status: 202, body: { ok: true } };
}
