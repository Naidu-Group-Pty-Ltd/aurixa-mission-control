// The per-report token cost index, and cascading it to every clone.
//
// `report_credit_costs` is the platform's price list for generated work: one
// row per report type, keyed by the same string a clone's token client sends
// as `kind`. A clone resolves its reserve amount from here, so a number
// changed in Mission Control reaches every workspace without a deploy.
//
// "Cascade" means two things, and both matter:
//   • CORRECTNESS — clones poll the public catalog on a short cache, so a new
//     price takes effect everywhere on its own. The cascade only makes it
//     immediate.
//   • ACCOUNTABILITY — repricing changes what every workspace on the platform
//     pays. Each publish is recorded with who did it, what moved, and what
//     each clone said when notified.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fireTokenWebhook } from "@/server/token-webhooks.server";

const adminAny = supabaseAdmin;

/** Credit costs are whole numbers; this ceiling is a fat-finger guard, not a
 *  business rule. A four-digit cost on a report that used to cost 12 is far
 *  more likely to be a typo than an intent. */
export const MAX_CREDIT_COST = 10_000;
export const MIN_CREDIT_COST = 0;

export type ReportCostRow = {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  credit_cost: number;
  is_active: boolean;
  sort_order: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>;
  updated_at: string;
};

export type CostEdit = { slug: string; credit_cost: number };

export type CostChange = { slug: string; from: number; to: number };

export type ValidationResult =
  | { ok: true; edits: CostEdit[]; error?: undefined }
  | { ok: false; error: string; edits?: undefined };

/**
 * Validate a batch of edits against the current index.
 *
 * Pure so the rules are pinned by tests rather than discovered in production:
 * unknown slugs are rejected rather than silently ignored (a typo must not
 * look like a successful reprice), non-integers and out-of-range values are
 * rejected, and a no-op batch is rejected so an empty publish never creates a
 * misleading revision row.
 */
export function validateCostEdits(
  current: Pick<ReportCostRow, "slug" | "credit_cost">[],
  edits: unknown,
): ValidationResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "no_edits" };
  }
  const known = new Map(current.map((r) => [r.slug, r.credit_cost]));
  const seen = new Set<string>();
  const clean: CostEdit[] = [];

  for (const raw of edits) {
    const slug = typeof (raw as CostEdit)?.slug === "string" ? (raw as CostEdit).slug.trim() : "";
    if (!slug) return { ok: false, error: "missing_slug" };
    if (!known.has(slug)) return { ok: false, error: `unknown_report: ${slug}` };
    if (seen.has(slug)) return { ok: false, error: `duplicate_report: ${slug}` };
    seen.add(slug);

    const cost = (raw as CostEdit).credit_cost;
    if (typeof cost !== "number" || !Number.isFinite(cost)) {
      return { ok: false, error: `invalid_cost: ${slug}` };
    }
    if (!Number.isInteger(cost)) return { ok: false, error: `non_integer_cost: ${slug}` };
    if (cost < MIN_CREDIT_COST || cost > MAX_CREDIT_COST) {
      return { ok: false, error: `cost_out_of_range: ${slug}` };
    }
    clean.push({ slug, credit_cost: cost });
  }

  // Drop edits that change nothing, then insist something is left. Publishing
  // a batch where every value already matches would record a revision and
  // cascade to every clone for no reason.
  const changed = clean.filter((e) => known.get(e.slug) !== e.credit_cost);
  if (changed.length === 0) return { ok: false, error: "no_changes" };

  return { ok: true, edits: changed };
}

/** What a batch of edits will move, for the confirmation step and the audit row. */
export function diffCostEdits(
  current: Pick<ReportCostRow, "slug" | "credit_cost">[],
  edits: CostEdit[],
): CostChange[] {
  const known = new Map(current.map((r) => [r.slug, r.credit_cost]));
  return edits
    .map((e) => ({ slug: e.slug, from: known.get(e.slug) ?? 0, to: e.credit_cost }))
    .filter((c) => c.from !== c.to)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The index version clones compare against. Derived from the data rather than
 * kept as a separate counter, so it cannot drift out of step with the rows it
 * describes.
 */
export function indexVersion(rows: Pick<ReportCostRow, "updated_at">[]): string {
  let latest = 0;
  for (const r of rows) {
    const t = r.updated_at ? Date.parse(r.updated_at) : 0;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest > 0 ? new Date(latest).toISOString() : "";
}

export async function listReportCosts(): Promise<ReportCostRow[]> {
  const { data, error } = await adminAny
    .from("report_credit_costs")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`report_costs_list_failed: ${error.message}`);
  return (data ?? []) as ReportCostRow[];
}

export type CascadeTarget = {
  cloneId: string | null;
  name: string;
  delivered: boolean;
  detail?: string;
};

/**
 * Notify every clone that the index moved.
 *
 * Delivery is best-effort by design: the catalog is pull-based, so a clone
 * that misses this still picks the new price up on its next catalog refresh.
 * The per-clone outcome is recorded so an operator can see which workspaces
 * took it immediately and which will lag.
 */
export async function cascadeReportCostIndex(
  version: string,
  changes: CostChange[],
): Promise<CascadeTarget[]> {
  const results: CascadeTarget[] = [];

  const { data: clones } = await adminAny
    .from("clones")
    .select("id, name, slug")
    .order("name", { ascending: true });

  // A null clone_id endpoint is the prime repository — it is a subscriber like
  // any other, so "all clones and prime" is one loop, not two code paths.
  const targets: Array<{ id: string | null; name: string }> = [
    { id: null, name: "Prime (unscoped subscribers)" },
    ...((clones ?? []) as Array<{ id: string; name: string | null; slug: string | null }>).map(
      (c) => ({ id: c.id, name: c.name ?? c.slug ?? c.id }),
    ),
  ];

  for (const target of targets) {
    try {
      await fireTokenWebhook(
        "tokens.alert",
        {
          alert: "report_cost_index_updated",
          version,
          changes,
          // Clones key their local refresh off this; sending the full change
          // set means a subscriber can log exactly what moved without a
          // round-trip back to the catalog.
          changed_slugs: changes.map((c) => c.slug),
        },
        target.id,
      );
      results.push({ cloneId: target.id, name: target.name, delivered: true });
    } catch (err) {
      results.push({
        cloneId: target.id,
        name: target.name,
        delivered: false,
        detail: err instanceof Error ? err.message : "cascade_failed",
      });
    }
  }

  return results;
}

export type PublishResult = {
  ok: true;
  version: string;
  changes: CostChange[];
  cascade: CascadeTarget[];
  revisionId: string | null;
};

/**
 * Apply a validated batch, record the revision, then cascade.
 *
 * Ordering is deliberate: the rows are the source of truth, so they are
 * written first. A cascade failure afterwards is a delivery problem, not a
 * pricing one — the new prices are already live for anyone who polls.
 */
export async function publishReportCosts(
  edits: CostEdit[],
  opts: { publishedBy?: string | null; note?: string | null } = {},
): Promise<PublishResult> {
  const before = await listReportCosts();
  const changes = diffCostEdits(before, edits);

  for (const edit of edits) {
    const { error } = await adminAny
      .from("report_credit_costs")
      .update({ credit_cost: edit.credit_cost, updated_at: new Date().toISOString() })
      .eq("slug", edit.slug);
    if (error) throw new Error(`report_cost_update_failed: ${edit.slug}: ${error.message}`);
  }

  const after = await listReportCosts();
  const version = indexVersion(after);
  const costs = Object.fromEntries(after.map((r) => [r.slug, r.credit_cost]));

  const cascade = await cascadeReportCostIndex(version, changes);

  let revisionId: string | null = null;
  try {
    const { data } = await adminAny
      .from("report_cost_revisions")
      .insert({
        published_by: opts.publishedBy ?? null,
        note: opts.note ?? null,
        costs,
        changes: Object.fromEntries(changes.map((c) => [c.slug, { from: c.from, to: c.to }])),
        cascade_result: { version, targets: cascade },
      })
      .select("id")
      .single();
    revisionId = (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    // The prices are live and the cascade has run; losing the audit row is bad
    // but not a reason to fail the operator's action.
    console.error("[report-cost-index] revision insert failed", err);
  }

  return { ok: true, version, changes, cascade, revisionId };
}
