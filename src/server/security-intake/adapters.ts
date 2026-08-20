// Provider-neutral security intake adapters.
//
// Each adapter converts an upstream vendor payload into a normalized finding
// shape and persists it against `codex_findings` (our canonical findings table).
// This lets us plug in new scanners (Snyk, Semgrep, custom) or ticketing
// systems (Linear, Jira) without touching downstream consumers.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type NormalizedSeverity = "critical" | "high" | "medium" | "low" | "info";

export type NormalizedFinding = {
  external_id: string;
  title: string;
  severity: NormalizedSeverity;
  description?: string | null;
  affected_file?: string | null;
  affected_line?: number | null;
  cwe?: string | null;
  cvss?: number | null;
  auto_fix_confidence?: number | null;
  clone_id?: string | null;
  raw?: Record<string, unknown>;
};

export type IntakeSource = {
  slug: string;
  name: string;
  kind: "codex" | "manual" | "ticketing" | "generic";
  hmac_secret: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
};

export interface SecurityIntakeAdapter {
  slug: string;
  ingestFinding(finding: NormalizedFinding, source: IntakeSource): Promise<{ id: string; created: boolean }>;
  updateStatus(externalId: string, state: string): Promise<void>;
  linkExternalTicket(
    findingId: string,
    ticket: { provider: string; external_id: string; url?: string; status?: string },
    source: IntakeSource,
    actorUserId?: string | null,
  ): Promise<{ id: string }>;
}

const admin = supabaseAdmin as any;

// Shared upsert used by codex/manual/generic adapters. Ticketing adapter does
// not create findings (it only links to existing ones).
async function upsertFinding(finding: NormalizedFinding, source: IntakeSource) {
  const externalKey = `${source.slug}:${finding.external_id}`;
  const row = {
    // Intake findings have no scan job; the column is nullable and a partial
    // unique index on codex_finding_id keeps this path idempotent.
    scan_job_id: null,
    clone_id: finding.clone_id ?? null,
    codex_finding_id: externalKey,
    // Same identity the scan pipeline uses, so intake findings take part in
    // cross-run carry-forward and regression detection too.
    fingerprint: externalKey,
    scanner: source.slug,
    last_seen_at: new Date().toISOString(),
    title: finding.title,
    severity: finding.severity,
    description: finding.description ?? null,
    affected_file: finding.affected_file ?? null,
    affected_line: finding.affected_line ?? null,
    cwe: finding.cwe ?? null,
    cvss: finding.cvss ?? null,
    auto_fix_confidence: finding.auto_fix_confidence ?? null,
    source_slug: source.slug,
    raw: finding.raw ?? {},
  };

  // Try to find existing row (unique on codex_finding_id in most deployments,
  // but we don't rely on that constraint — we look up manually).
  const existing = await admin
    .from("codex_findings")
    .select("id")
    .eq("codex_finding_id", row.codex_finding_id)
    .maybeSingle();

  if (existing.data?.id) {
    await admin.from("codex_findings").update(row).eq("id", existing.data.id);
    return { id: existing.data.id as string, created: false };
  }

  const inserted = await admin.from("codex_findings").insert(row).select("id").single();
  if (inserted.error) throw new Error(inserted.error.message);
  return { id: inserted.data.id as string, created: true };
}

async function updateFindingState(externalId: string, sourceSlug: string, state: string) {
  await admin
    .from("codex_findings")
    .update({ state })
    .eq("codex_finding_id", `${sourceSlug}:${externalId}`);
}

async function linkTicket(
  findingId: string,
  ticket: { provider: string; external_id: string; url?: string; status?: string },
  source: IntakeSource,
  actorUserId?: string | null,
) {
  const payload = {
    codex_finding_id: findingId,
    source_slug: source.slug,
    provider: ticket.provider,
    external_id: ticket.external_id,
    url: ticket.url ?? null,
    status: ticket.status ?? "open",
    created_by: actorUserId ?? null,
  };
  const res = await admin
    .from("security_external_tickets")
    .upsert(payload, { onConflict: "source_slug,provider,external_id" })
    .select("id")
    .single();
  if (res.error) throw new Error(res.error.message);
  if (ticket.url) {
    await admin.from("codex_findings").update({ external_ticket_url: ticket.url }).eq("id", findingId);
  }
  return { id: res.data.id as string };
}

class BaseAdapter implements SecurityIntakeAdapter {
  constructor(public slug: string) {}
  async ingestFinding(finding: NormalizedFinding, source: IntakeSource) {
    return upsertFinding(finding, source);
  }
  async updateStatus(externalId: string, state: string) {
    return updateFindingState(externalId, this.slug, state);
  }
  async linkExternalTicket(
    findingId: string,
    ticket: { provider: string; external_id: string; url?: string; status?: string },
    source: IntakeSource,
    actorUserId?: string | null,
  ) {
    return linkTicket(findingId, ticket, source, actorUserId);
  }
}

export class CodexAdapter extends BaseAdapter {
  constructor() {
    super("codex");
  }
}

export class ManualAdapter extends BaseAdapter {
  constructor() {
    super("manual");
  }
}

export class GenericAdapter extends BaseAdapter {}

// Ticketing adapter: cannot create findings (throws), only links tickets.
export class TicketingAdapter implements SecurityIntakeAdapter {
  constructor(public slug: string) {}
  async ingestFinding(): Promise<{ id: string; created: boolean }> {
    throw new Error("ticketing_adapter_cannot_ingest_findings");
  }
  async updateStatus(externalId: string, state: string) {
    // Ticketing status updates land on security_external_tickets instead.
    await admin
      .from("security_external_tickets")
      .update({ status: state })
      .eq("source_slug", this.slug)
      .eq("external_id", externalId);
  }
  async linkExternalTicket(
    findingId: string,
    ticket: { provider: string; external_id: string; url?: string; status?: string },
    source: IntakeSource,
    actorUserId?: string | null,
  ) {
    return linkTicket(findingId, ticket, source, actorUserId);
  }
}

export function adapterFor(source: IntakeSource): SecurityIntakeAdapter {
  switch (source.kind) {
    case "codex":
      return new CodexAdapter();
    case "manual":
      return new ManualAdapter();
    case "ticketing":
      return new TicketingAdapter(source.slug);
    case "generic":
    default:
      return new GenericAdapter(source.slug);
  }
}

export async function loadSourceBySlug(slug: string): Promise<IntakeSource | null> {
  const res = await admin
    .from("security_intake_sources")
    .select("slug, name, kind, hmac_secret, active, metadata")
    .eq("slug", slug)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return res.data as IntakeSource;
}
