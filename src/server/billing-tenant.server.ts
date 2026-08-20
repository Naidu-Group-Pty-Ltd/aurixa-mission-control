// Which tenant does a purchase credit?
//
// A tenant is a workspace's billing account: its token balance is what the
// clone reserves against, spends from, and shows on its dashboard. Crediting
// the wrong one is invisible at checkout — Stripe takes the money, the ledger
// row lands, and the workspace's balance simply never moves.
//
// That is exactly what `ensureTenant(cloneId, 'clone:<slug>')` did for
// `?uid=`-scoped purchases. `ensureTenant` matches on (external_ref, clone_id),
// but a clone METERS under `prime:<its-supabase-project-ref>` — the tenant_ref
// hard-coded into every clone's token client. Different external_ref means a
// different row, so a top-up provisioned a SECOND tenant for the clone and
// credited that one, while the clone kept spending from the first.
//
// So: for a clone-scoped purchase, always prefer a tenant the clone ALREADY
// has over inventing one. Only a clone with no tenant at all falls through to
// provisioning, which is the original behaviour for a genuinely new clone.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapWithConcurrency } from "@/lib/concurrency";
import { ensureTenant } from "@/server/clone-api-keys.server";

const adminAny = supabaseAdmin;

export type TenantCandidate = {
  id: string;
  external_ref: string | null;
  billing_user_id: string | null;
  created_at: string | null;
  /** True when this tenant has token ledger history — i.e. it is the one the
   *  clone actually meters against. */
  hasLedgerActivity?: boolean;
};

/**
 * The external_ref shape every clone's token client uses (`AGENCY_TENANT_REF`
 * in the clone repo is `prime:<supabase project ref>`). A tenant carrying it
 * is, by construction, the one the clone reserves and spends against.
 */
export function isMeteringExternalRef(externalRef: string | null | undefined): boolean {
  return typeof externalRef === "string" && externalRef.startsWith("prime:");
}

/**
 * Rank a clone's tenants so the best one to credit comes first. Pure, so the
 * precedence is pinned by tests rather than by whatever the database happened
 * to return first.
 *
 * Precedence, strongest signal first:
 *   1. the operator-assigned billing id the buyer's link carried — an explicit
 *      "this uid means this workspace"
 *   2. has token ledger activity — it is provably the balance being spent
 *   3. a `prime:` external_ref — the shape a clone's token client meters under
 *   4. oldest — the original, not a later duplicate
 */
export function rankTenantCandidates(
  candidates: TenantCandidate[],
  opts: { billingUserId?: string | null } = {},
): TenantCandidate[] {
  const uid = (opts.billingUserId ?? "").trim();
  const score = (t: TenantCandidate): number => {
    let s = 0;
    if (uid && t.billing_user_id === uid) s += 8;
    if (t.hasLedgerActivity) s += 4;
    if (isMeteringExternalRef(t.external_ref)) s += 2;
    return s;
  };
  return [...candidates].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    const at = a.created_at ? Date.parse(a.created_at) : Number.MAX_SAFE_INTEGER;
    const bt = b.created_at ? Date.parse(b.created_at) : Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
}

export type ResolvedBillingTenant =
  | { ok: true; tenantId: string; provisioned: boolean; error?: undefined }
  | { ok: false; error: string; tenantId?: undefined; provisioned?: undefined };

/**
 * Resolve the tenant a clone-scoped purchase should credit.
 *
 * `fallbackExternalRef` / `fallbackDisplayName` are only used when the clone
 * has no tenant yet, preserving the original provisioning behaviour for a
 * brand-new clone.
 */
export async function resolveCloneBillingTenant(
  cloneId: string,
  opts: {
    billingUserId?: string | null;
    fallbackExternalRef: string;
    fallbackDisplayName?: string | null;
  },
): Promise<ResolvedBillingTenant> {
  const { data: rows, error } = await adminAny
    .from("tenants")
    .select("id, external_ref, billing_user_id, created_at")
    .eq("clone_id", cloneId);

  if (error) return { ok: false, error: error.message };

  const candidates = (rows ?? []) as TenantCandidate[];
  if (candidates.length === 0) {
    const ensured = await ensureTenant(cloneId, opts.fallbackExternalRef, opts.fallbackDisplayName);
    if (!ensured.ok) return { ok: false, error: (ensured as { error: string }).error };
    return { ok: true, tenantId: ensured.tenantId, provisioned: true };
  }

  if (candidates.length === 1) {
    return { ok: true, tenantId: candidates[0].id, provisioned: false };
  }

  // Several tenants for one clone — the split this function exists to heal.
  // Ledger activity is the decisive signal, so pay for it only when needed.
  const withActivity = await tenantsWithLedgerActivity(candidates.map((c) => c.id));
  for (const c of candidates) c.hasLedgerActivity = withActivity.has(c.id);

  const ranked = rankTenantCandidates(candidates, { billingUserId: opts.billingUserId });
  return { ok: true, tenantId: ranked[0].id, provisioned: false };
}

/**
 * Which of these tenants have token ledger rows?
 *
 * Asked one tenant at a time, deliberately. The previous form was a single
 * `.in("tenant_id", ids) … .limit(1000)`, which is a membership question
 * answered with a capped scan: `token_ledger` has no retention and grows
 * without bound, PostgREST returns rows in no defined order, so once a busy
 * tenant's rows fill the cap the others come back absent — and absent here
 * means "no ledger activity", which is the decisive signal for WHICH TENANT A
 * CLONE BILLS TO. Getting it wrong attributes a purchase to the wrong tenant.
 *
 * This path only runs when one clone has several tenants — the split it exists
 * to heal — so the list is a handful, and a `limit(1)` existence probe each is
 * both exact and cheaper than the scan it replaces.
 */
async function tenantsWithLedgerActivity(tenantIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (tenantIds.length === 0) return found;
  try {
    const results = await mapWithConcurrency(tenantIds, 4, async (id) => {
      const { data, error } = await adminAny
        .from("token_ledger")
        .select("tenant_id")
        .eq("tenant_id", id)
        .in("kind", ["reserve", "debit", "release"])
        .limit(1);
      // A read that FAILED is not a tenant with no activity. Throwing here puts
      // it on the shared catch below, which leaves the whole set empty rather
      // than quietly reporting one tenant as inactive.
      if (error) throw new Error(error.message);
      return { id, active: (data ?? []).length > 0 };
    });
    for (const r of results) if (r.active) found.add(r.id);
  } catch (err) {
    console.warn("[billing-tenant] ledger activity lookup failed", err);
  }
  return found;
}
