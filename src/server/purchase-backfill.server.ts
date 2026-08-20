// Rebuilds `purchases` rows from Stripe for a window where the write failed.
//
// Written for the 2026-07-25 outage (migration 20260725150000 only partly
// applied, so every insert failed on `purchases.item_name`), but deliberately
// general: Stripe holds the authoritative record of every checkout session and
// all of our metadata travels on it, so any window where our ledger write was
// broken can be reconstructed from their side.
//
// Three rules this obeys, and they are the whole design:
//
//   1. It NEVER fulfils. No credits, no seats, no invoices — this writes
//      reporting rows and nothing else. Sessions in the affected window were
//      already fulfilled by the webhook (fulfilment runs BEFORE the ledger
//      write that was failing), so fulfilling here would double-credit.
//   2. It NEVER overwrites. Only sessions with no row at all are inserted, so
//      a later refund or a hand-corrected row cannot be clobbered by a replay.
//      That also makes it idempotent: run it twice, the second run writes zero.
//   3. It preserves WHEN. `created_at` is taken from the Stripe session, not
//      from now() — otherwise restored history all bunches up on the day of
//      the repair and the ledger tells a story that never happened.
import { asRow } from "@/lib/json-cast";
import type { TablesInsert } from "@/integrations/supabase/types";
import type Stripe from "stripe";
import { getStripe } from "@/server/stripe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  PURCHASE_IDENTITY_COLUMNS,
  purchaseRowFromSession,
  writeToleratingSchemaDrift,
  type PurchaseStatus,
} from "@/server/purchases.server";

const adminAny = supabaseAdmin;

/**
 * What a session's final state means for the ledger. Pure — unit tested.
 *
 * `abandoned` has been in the `purchases.status` CHECK constraint since the
 * table was created but nothing ever wrote it; an expired Stripe session is
 * exactly what it was reserved for. Distinguishing it from `initiated` is the
 * difference between "this customer walked away" and "this checkout is still
 * live", which is the question the ledger is usually being asked.
 */
export function purchaseStatusFromSession(session: {
  status?: string | null;
  payment_status?: string | null;
}): PurchaseStatus {
  if (session.status === "expired") return "abandoned";
  if (session.status === "complete") {
    // A delayed payment method completes the session before the money lands.
    // Calling that 'completed' would show a paid purchase for funds that may
    // never clear — the same rule the webhook applies.
    return session.payment_status === "paid" || session.payment_status === "no_payment_required"
      ? "completed"
      : "initiated";
  }
  return "initiated";
}

/**
 * Card-save sessions vault a payment method; no money moves and no catalog item
 * is bought, so they are not purchases and never had a row.
 */
export function isPurchaseSession(session: { mode?: string | null }): boolean {
  return session.mode === "payment" || session.mode === "subscription";
}

export type BackfillReport = {
  scanned: number;
  skippedNotPurchase: number;
  alreadyRecorded: number;
  inserted: number;
  failed: Array<{ sessionId: string; error: string }>;
  droppedColumns: string[];
  rows: Array<{
    sessionId: string;
    createdAt: string;
    mode: string;
    itemName: string | null;
    amountCents: number | null;
    currency: string | null;
    status: PurchaseStatus;
    originUsername: string | null;
  }>;
};

/** A foreign key the row points at no longer exists. */
export function isForeignKeyViolation(
  error: { message?: string | null; code?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "23503") return true;
  return /violates foreign key constraint/i.test(error.message ?? "");
}

/**
 * Inserts a purchase row, surviving a handoff that is no longer there.
 *
 * `purchases.handoff_id` references `billing_handoffs`, and handoffs are
 * single-use and short-lived — by the time a window is reconstructed, days
 * later, the row it pointed at may well have been cleaned up. That link is a
 * convenience: who initiated the purchase is already carried by
 * `origin_user_id` and `origin_username`, which are plain text and always
 * survive. So a dangling handoff costs the link, not the record.
 */
async function insertPurchaseRow(row: Record<string, unknown>) {
  const first = await adminAny.from("purchases").insert(asRow<TablesInsert<"purchases">>(row));
  if (!isForeignKeyViolation(first.error) || row.handoff_id == null) return first;

  console.warn(
    "[purchase-backfill] handoff no longer exists; inserting without the link",
    row.stripe_checkout_session_id,
  );
  return await adminAny
    .from("purchases")
    .insert(asRow<TablesInsert<"purchases">>({ ...row, handoff_id: null }));
}

/** Which of these session ids already have a purchases row. */
async function existingSessionIds(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  // Chunked: the id list goes into the query string, and a long window can
  // hold more sessions than one URL should carry.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await adminAny
      .from("purchases")
      .select("stripe_checkout_session_id")
      .in("stripe_checkout_session_id", chunk);
    if (error) throw new Error(`purchases_lookup_failed: ${error.message}`);
    for (const row of data ?? [])
      if (row.stripe_checkout_session_id) found.add(row.stripe_checkout_session_id);
  }
  return found;
}

/**
 * Walks Stripe checkout sessions created in [since, until) and inserts a
 * `purchases` row for any that has none.
 *
 * `dryRun` reports exactly what would be written without writing it, and is
 * the default at every call site — a ledger repair should be inspected before
 * it runs.
 */
export async function reconcilePurchasesFromStripe(input: {
  since: Date;
  until?: Date;
  dryRun?: boolean;
  maxSessions?: number;
}): Promise<BackfillReport> {
  const dryRun = input.dryRun ?? true;
  const maxSessions = input.maxSessions ?? 500;
  const stripe = getStripe();

  const report: BackfillReport = {
    scanned: 0,
    skippedNotPurchase: 0,
    alreadyRecorded: 0,
    inserted: 0,
    failed: [],
    droppedColumns: [],
    rows: [],
  };

  const candidates: Stripe.Checkout.Session[] = [];
  const query: Stripe.Checkout.SessionListParams = {
    limit: 100,
    created: {
      gte: Math.floor(input.since.getTime() / 1000),
      ...(input.until ? { lt: Math.floor(input.until.getTime() / 1000) } : {}),
    },
  };

  for await (const session of stripe.checkout.sessions.list(query)) {
    report.scanned++;
    if (!isPurchaseSession(session)) {
      report.skippedNotPurchase++;
    } else {
      candidates.push(session);
    }
    if (report.scanned >= maxSessions) break;
  }

  if (!candidates.length) return report;

  const already = await existingSessionIds(candidates.map((s) => s.id));

  for (const session of candidates) {
    if (already.has(session.id)) {
      report.alreadyRecorded++;
      continue;
    }

    const status = purchaseStatusFromSession(session);
    const createdAt = new Date(session.created * 1000).toISOString();
    const row = {
      ...purchaseRowFromSession(session, status),
      // The session's own timestamp, so restored history sits where it happened.
      created_at: createdAt,
      // completed_at is stamped with now() by purchaseRowFromSession; for a
      // reconstruction the honest value is when Stripe completed it.
      completed_at: status === "completed" ? createdAt : null,
    };

    const md = (session.metadata ?? {}) as Record<string, string>;
    report.rows.push({
      sessionId: session.id,
      createdAt,
      mode: md.mode ?? session.mode ?? "unknown",
      itemName: md.item_name || null,
      amountCents: session.amount_total ?? null,
      currency: session.currency ? session.currency.toUpperCase() : null,
      status,
      originUsername: md.origin_username || null,
    });

    if (dryRun) continue;

    try {
      const { dropped } = await writeToleratingSchemaDrift(
        (r) => insertPurchaseRow(r),
        row,
        PURCHASE_IDENTITY_COLUMNS,
      );
      for (const c of dropped) {
        if (!report.droppedColumns.includes(c)) report.droppedColumns.push(c);
      }
      report.inserted++;
    } catch (err) {
      report.failed.push({
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
