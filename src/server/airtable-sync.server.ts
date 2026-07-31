// Airtable → waitlist_leads mirror sync.
//
// Backfill + safety-net + progress feed for the Aurixa Systems priority-access
// funnel. The website's Make.com scenarios are the primary source of truth
// (Airtable + realtime notification); this pulls the Airtable base directly so
// that:
//
//   * historical rows and any rows Make/webhook missed get mirrored, and
//   * Stage 2 / Stage 3 progress reaches Mission Control at all.
//
// That second job is the reason this is an upsert rather than an insert. The
// funnel's later stages are recorded on the Airtable waitlist row as rollups
// from the "BRQ Detailed Responses" and "Strategic Review Bookings" tables —
// they change *after* the lead first lands. A sync that only ever inserted saw
// each applicant once, at Stage 1, and never again.
//
// This path deliberately does NOT fan out notifications: only fresh
// browser/Make-forwarded submissions (/api/public/leads/capture) do that, so a
// backfill can never spam operators with a hundred stale alerts.
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  cleanLeadText,
  normaliseApplicationId,
  LEAD_MAX_TEXT_LENGTH,
} from "@/server/lead-capture.server";

const AIRTABLE_BASE_ID = "apptyShYE0yzL4IGB";
const AIRTABLE_TABLE = "Aurixa Waitlist";
const GATEWAY_URL = "https://connector-gateway.lovable.dev/airtable";
const PAGE_SIZE = 100;

type AirtableRecord = {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
};

type AirtablePage = {
  records: AirtableRecord[];
  offset?: string;
};

function pickField(fields: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const v = fields[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Airtable returns multi-selects as arrays and (through some gateways) single
 * selects as `{id, name}` objects. Reduce either to the plain slug list the
 * lead row stores.
 */
function pickSlugList(fields: Record<string, unknown>, ...names: string[]): string[] {
  const raw = pickField(fields, ...names);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      cleanLeadText(
        typeof item === "object" && item !== null ? (item as { name?: unknown }).name : item,
        80,
      ),
    )
    .filter(Boolean);
}

function pickText(fields: Record<string, unknown>, ...names: string[]): string {
  const raw = pickField(fields, ...names);
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return cleanLeadText((raw as { name?: unknown }).name);
  }
  return cleanLeadText(raw);
}

function pickBoolean(fields: Record<string, unknown>, ...names: string[]): boolean | null {
  const raw = pickField(fields, ...names);
  return typeof raw === "boolean" ? raw : null;
}

function pickTimestamp(fields: Record<string, unknown>, ...names: string[]): string | null {
  const raw = pickText(fields, ...names);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Airtable's "Stage N Reached" formulas answer 1 or 0. */
function reached(fields: Record<string, unknown>, name: string): boolean {
  const raw = pickField(fields, name);
  return Number(raw) > 0;
}

function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function dedupeKeyFor(email: string, submittedAt: string | null): string | null {
  if (!submittedAt) return null;
  return crypto.createHash("sha256").update(`${email}|${submittedAt}`).digest("hex");
}

async function fetchAirtablePage(offset?: string): Promise<AirtablePage> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const airtableKey = process.env.AIRTABLE_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY not configured");
  if (!airtableKey) throw new Error("AIRTABLE_API_KEY not configured");

  const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
  if (offset) params.set("offset", offset);
  const url = `${GATEWAY_URL}/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?${params}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": airtableKey,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable gateway ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AirtablePage;
}

export function mapRecord(rec: AirtableRecord) {
  const f = rec.fields;
  const first_name = cleanLeadText(pickField(f, "First Name"));
  const last_name = cleanLeadText(pickField(f, "Last Name"));
  const email = cleanLeadText(pickField(f, "Corporate Email")).toLowerCase();
  if (!first_name || !last_name || !email || !isEmail(email)) return null;

  const submittedRaw = cleanLeadText(pickField(f, "Date Added"));
  const submittedMs = submittedRaw ? Date.parse(submittedRaw) : NaN;
  const submitted_at = Number.isFinite(submittedMs)
    ? new Date(submittedMs).toISOString()
    : rec.createdTime;

  const stage2Reached = reached(f, "Stage 2 Reached");
  const stage3Reached = reached(f, "Stage 3 Reached");

  return {
    application_id: normaliseApplicationId(pickField(f, "Application ID")),
    first_name,
    last_name,
    email,
    mobile_number:
      cleanLeadText(pickField(f, "Phone", "Phone Number", "Mobile Number", "Mobile")) || null,
    entity_name: cleanLeadText(pickField(f, "Entity Name")) || null,
    entity_classification: pickText(f, "Entity Classification") || null,
    transaction_volume:
      pickText(f, "Annual Transactional Value", "Annual Origination Volume") || null,
    tech_stack_bottlenecks:
      cleanLeadText(pickField(f, "Current Bottlenecks"), LEAD_MAX_TEXT_LENGTH) || null,
    notes: cleanLeadText(pickField(f, "Notes"), LEAD_MAX_TEXT_LENGTH) || null,

    // Stage 1 answers the previous mapping ignored entirely.
    role: pickText(f, "Your Role") || null,
    primary_areas: pickSlugList(f, "Primary Areas to Improve"),
    additional_notes: cleanLeadText(pickField(f, "Additional Notes"), LEAD_MAX_TEXT_LENGTH) || null,
    form_version: cleanLeadText(pickField(f, "Form Version")) || null,
    privacy_acknowledged: pickBoolean(f, "Privacy Acknowledged"),
    privacy_notice_version: cleanLeadText(pickField(f, "Privacy Notice Version")) || null,
    marketing_consent: pickBoolean(f, "Marketing Consent"),

    // Attribution, recorded silently at Stage 1.
    landing_page: cleanLeadText(pickField(f, "Landing Page"), 500) || null,
    referrer: cleanLeadText(pickField(f, "Referrer"), 500) || null,
    utm_source: cleanLeadText(pickField(f, "UTM Source")) || null,
    utm_medium: cleanLeadText(pickField(f, "UTM Medium")) || null,
    utm_campaign: cleanLeadText(pickField(f, "UTM Campaign")) || null,
    utm_term: cleanLeadText(pickField(f, "UTM Term")) || null,
    utm_content: cleanLeadText(pickField(f, "UTM Content")) || null,

    // Journey — the whole point of syncing more than once.
    stage: stage3Reached ? 3 : stage2Reached ? 2 : 1,
    stage2_status: pickText(f, "Stage 2 Completion Status") || (stage2Reached ? "Reached" : null),
    // Despite its name, "Stage 2 Started At" rolls up the BRQ response's
    // *submitted* time — the questionnaire is written once, on completion.
    stage2_completed_at: pickTimestamp(f, "Stage 2 Started At"),
    stage3_status: pickText(f, "Stage 3 Booking Status") || (stage3Reached ? "Reached" : null),
    stage3_booked_at: pickTimestamp(f, "Stage 3 Booked At"),
    stage3_session_start: pickTimestamp(f, "Stage 3 Session Start"),

    submitted_at,
    airtable_record_id: rec.id,
    airtable_status: cleanLeadText(pickField(f, "Status")) || null,
    airtable_created_time: rec.createdTime,
  };
}

type MappedRecord = NonNullable<ReturnType<typeof mapRecord>>;

/** The columns the Airtable mirror owns, in the shape the table stores them. */
function rowFor(mapped: MappedRecord) {
  const { airtable_created_time, ...row } = mapped;
  return {
    ...row,
    source: "airtable_mirror",
    page: null,
    metadata: {
      channel: "airtable_mirror",
      airtable_record_id: mapped.airtable_record_id,
      airtable_created_time,
      ...(mapped.airtable_status ? { airtable_status: mapped.airtable_status } : {}),
    },
    synced_at: new Date().toISOString(),
  };
}

/**
 * Finds the row this Airtable record already maps to, in key order:
 * the Airtable record id we stored last time, then the application reference,
 * then the Stage 1 dedupe hash (which is how a browser-captured lead and its
 * Airtable twin recognise each other).
 */
async function findExisting(mapped: MappedRecord, dedupeKey: string | null) {
  for (const [column, value] of [
    ["airtable_record_id", mapped.airtable_record_id],
    ["application_id", mapped.application_id],
    ["dedupe_key", dedupeKey],
  ] as const) {
    if (!value) continue;
    const { data } = await supabaseAdmin
      .from("waitlist_leads")
      .select("id, stage, status")
      .eq(column, value)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

export type AirtableSyncResult = {
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped_invalid: number;
  errors: number;
};

export async function syncAirtableWaitlist(): Promise<AirtableSyncResult> {
  const out: AirtableSyncResult = {
    pages: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped_invalid: 0,
    errors: 0,
  };

  let offset: string | undefined = undefined;
  do {
    const page = await fetchAirtablePage(offset);
    out.pages += 1;
    for (const rec of page.records) {
      out.fetched += 1;
      const mapped = mapRecord(rec);
      if (!mapped) {
        out.skipped_invalid += 1;
        continue;
      }

      const dedupe_key =
        dedupeKeyFor(mapped.email, mapped.submitted_at) ?? `airtable:${mapped.airtable_record_id}`;
      const row = rowFor(mapped);

      try {
        const existing = await findExisting(mapped, dedupe_key);

        if (existing) {
          // The mirror owns the Airtable-derived columns only. `status` is the
          // operator's own triage decision and `source`/`page` describe how the
          // lead first reached us — neither is Airtable's to overwrite.
          const { source: _source, page: _page, ...mirrored } = row;
          const { error } = await supabaseAdmin
            .from("waitlist_leads")
            // Never walk the journey backwards: a rollup that has not caught
            // up yet must not un-book a review we already recorded.
            .update({ ...mirrored, stage: Math.max(Number(existing.stage ?? 1), row.stage) })
            .eq("id", existing.id);
          if (error) throw error;
          out.updated += 1;
          continue;
        }

        const { error } = await supabaseAdmin.from("waitlist_leads").insert({ ...row, dedupe_key });
        if (error) {
          // Another delivery path won the race between our lookup and this
          // insert. Its row is the same submission, so that is success.
          if (error.code === "23505") {
            out.unchanged += 1;
            continue;
          }
          throw error;
        }
        out.inserted += 1;
      } catch (error) {
        out.errors += 1;
        console.error("airtable sync failed for record", { record: rec.id, error });
      }
    }
    offset = page.offset;
  } while (offset);

  return out;
}
