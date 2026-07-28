import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

// Controllable state for the mocked Supabase admin client, mirroring the
// pattern in clone-api-keys.test.ts. `row`/`error` drive maybeSingle();
// `inserts`/`upserts`/`updates` capture writes for assertions.
const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
  inserts: [] as { table: string; values: unknown }[],
  upserts: [] as { table: string; values: unknown; options: unknown }[],
  updates: [] as { table: string; values: unknown }[],
  insertError: null as { message: string } | null,
  // Errors returned one per write, oldest first, so a test can reproduce a
  // database that rejects the first attempt and accepts a later one.
  errorQueue: [] as ({ message: string } | null)[],
}));

const nextWriteError = () =>
  state.errorQueue.length ? state.errorQueue.shift()! : state.insertError;

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      maybeSingle: async () => ({ data: state.row, error: state.error }),
      insert: async (values: unknown) => {
        state.inserts.push({ table, values });
        return { error: nextWriteError() };
      },
      upsert: async (values: unknown, options: unknown) => {
        state.upserts.push({ table, values, options });
        return { error: nextWriteError() };
      },
      update: (values: unknown) => {
        state.updates.push({ table, values });
        return b;
      },
    };
    return b;
  };
  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

import {
  OPERATOR_SOURCE,
  unknownColumnFromError,
  attributionFromMetadata,
  attributionMetadata,
  finalizePurchaseFromSession,
  loadValidHandoff,
  purchaseRowFromSession,
  recordPurchaseInitiated,
} from "./purchases.server";

beforeEach(() => {
  state.row = null;
  state.error = null;
  state.inserts = [];
  state.upserts = [];
  state.updates = [];
  state.insertError = null;
  state.errorQueue = [];
});

const attribution = {
  originUserId: "user-123",
  originUsername: "Jess",
  originSource: "clone:npc",
  handoffId: "0f3a2b1c-0000-4000-8000-000000000001",
};

function makeSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_abc",
    amount_total: 4900,
    currency: "aud",
    payment_status: "paid",
    payment_intent: "pi_123",
    subscription: null,
    metadata: {
      mode: "topup",
      item_id: "11111111-1111-4111-8111-111111111111",
      item_slug: "pack-small",
      tenant_id: "22222222-2222-4222-8222-222222222222",
      clone_id: "33333333-3333-4333-8333-333333333333",
      quantity: "2",
      ...attributionMetadata(attribution),
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

describe("attributionMetadata / attributionFromMetadata", () => {
  it("round-trips all attribution fields through string metadata", () => {
    expect(attributionFromMetadata(attributionMetadata(attribution))).toEqual(attribution);
  });

  it("treats empty strings and missing keys as null (pre-feature sessions)", () => {
    expect(attributionFromMetadata({})).toEqual({
      originUserId: null,
      originUsername: null,
      originSource: OPERATOR_SOURCE,
      handoffId: null,
    });
    expect(attributionFromMetadata({ origin_user_id: "", origin_source: "" })).toEqual({
      originUserId: null,
      originUsername: null,
      originSource: OPERATOR_SOURCE,
      handoffId: null,
    });
    expect(attributionFromMetadata(null)).toMatchObject({ originSource: OPERATOR_SOURCE });
  });
});

describe("purchaseRowFromSession", () => {
  it("maps a completed topup session onto a purchases row", () => {
    const row = purchaseRowFromSession(makeSession(), "completed");
    expect(row).toMatchObject({
      stripe_checkout_session_id: "cs_test_abc",
      stripe_payment_intent_id: "pi_123",
      stripe_subscription_id: null,
      mode: "topup",
      item_slug: "pack-small",
      quantity: 2,
      clone_id: "33333333-3333-4333-8333-333333333333",
      tenant_id: "22222222-2222-4222-8222-222222222222",
      origin_user_id: "user-123",
      origin_username: "Jess",
      origin_source: "clone:npc",
      handoff_id: attribution.handoffId,
      amount_cents: 4900,
      currency: "AUD",
      payment_status: "paid",
      status: "completed",
    });
    expect(row.completed_at).toBeTruthy();
  });

  it("unwraps expanded payment_intent/subscription objects", () => {
    const row = purchaseRowFromSession(
      makeSession({
        payment_intent: { id: "pi_exp" } as never,
        subscription: { id: "sub_exp" } as never,
      }),
      "completed",
    );
    expect(row.stripe_payment_intent_id).toBe("pi_exp");
    expect(row.stripe_subscription_id).toBe("sub_exp");
  });

  it("records failure status with the fulfilment error and no completed_at", () => {
    const row = purchaseRowFromSession(makeSession(), "failed", "pack_not_found");
    expect(row.status).toBe("failed");
    expect(row.completed_at).toBeNull();
    expect(row.metadata).toEqual({ fulfilment_error: "pack_not_found" });
  });

  it("tolerates sessions with no metadata (defaults, quantity 1)", () => {
    const row = purchaseRowFromSession(makeSession({ metadata: null }), "completed");
    expect(row).toMatchObject({
      mode: "unknown",
      quantity: 1,
      clone_id: null,
      tenant_id: null,
      origin_user_id: null,
      origin_source: OPERATOR_SOURCE,
    });
  });
});

describe("recordPurchaseInitiated", () => {
  it("inserts an 'initiated' row with attribution", async () => {
    await recordPurchaseInitiated({
      sessionId: "cs_1",
      mode: "topup",
      itemId: "item-1",
      itemSlug: "pack-small",
      quantity: 1,
      cloneId: "clone-1",
      tenantId: "tenant-1",
      attribution,
    });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].table).toBe("purchases");
    expect(state.inserts[0].values).toMatchObject({
      stripe_checkout_session_id: "cs_1",
      status: "initiated",
      origin_user_id: "user-123",
      origin_source: "clone:npc",
    });
  });

  it("never throws when the insert fails (checkout must not be blocked)", async () => {
    state.insertError = { message: "boom" };
    await expect(
      recordPurchaseInitiated({
        sessionId: "cs_1",
        mode: "topup",
        itemId: "item-1",
        itemSlug: null,
        quantity: 1,
        cloneId: null,
        tenantId: null,
        attribution,
      }),
    ).resolves.toBeUndefined();
    // Failure is recorded on the audit log (second captured insert).
    expect(state.inserts.some((i) => i.table === "audit_log")).toBe(true);
  });
});

describe("finalizePurchaseFromSession", () => {
  it("upserts on the checkout session id (idempotent for webhook replays)", async () => {
    await finalizePurchaseFromSession(makeSession(), "completed");
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].table).toBe("purchases");
    expect(state.upserts[0].options).toEqual({ onConflict: "stripe_checkout_session_id" });
  });

  it("throws on DB errors so the webhook retries", async () => {
    state.insertError = { message: "db down" };
    await expect(finalizePurchaseFromSession(makeSession(), "completed")).rejects.toThrow(
      /finalize_purchase_failed/,
    );
  });
});

describe("loadValidHandoff", () => {
  const base = {
    id: "h1",
    clone_id: "c1",
    tenant_id: "t1",
    origin_user_id: "user-123",
    origin_username: "Jess",
    origin_source: "clone:npc",
    intent: null,
    return_url: null,
    consumed_at: null,
  };

  it("returns an unexpired, unconsumed handoff", async () => {
    state.row = { ...base, expires_at: new Date(Date.now() + 60_000).toISOString() };
    expect(await loadValidHandoff("h1")).toMatchObject({ id: "h1", origin_user_id: "user-123" });
  });

  it("rejects expired tokens", async () => {
    state.row = { ...base, expires_at: new Date(Date.now() - 1_000).toISOString() };
    expect(await loadValidHandoff("h1")).toBeNull();
  });

  it("rejects consumed tokens", async () => {
    state.row = {
      ...base,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: new Date().toISOString(),
    };
    expect(await loadValidHandoff("h1")).toBeNull();
  });

  it("rejects unknown tokens and query errors", async () => {
    state.row = null;
    expect(await loadValidHandoff("nope")).toBeNull();
    state.error = { message: "boom" };
    expect(await loadValidHandoff("h1")).toBeNull();
  });
});

describe("unknownColumnFromError", () => {
  it("reads the column out of a Postgres 42703", () => {
    expect(
      unknownColumnFromError({ code: "42703", message: "column purchases.item_name does not exist" }),
    ).toBe("item_name");
  });

  it("reads the column out of a PostgREST schema-cache miss", () => {
    expect(
      unknownColumnFromError({
        code: "PGRST204",
        message: "Could not find the 'item_name' column of 'purchases' in the schema cache",
      }),
    ).toBe("item_name");
  });

  it("returns null for anything else, so real errors are never mistaken for drift", () => {
    expect(unknownColumnFromError({ message: "duplicate key value violates unique constraint" })).toBeNull();
    expect(unknownColumnFromError({ message: "" })).toBeNull();
    expect(unknownColumnFromError(null)).toBeNull();
  });
});

// The 2026-07-25 outage: migration 20260725150000 only partly applied, so
// `purchases.item_name` did not exist while the code was sending it. Every
// insert failed on that one descriptive column and the ledger silently stopped.
describe("schema drift must cost the column, not the purchase", () => {
  const missingItemName = { message: "column purchases.item_name does not exist" };

  it("still records the purchase when item_name does not exist", async () => {
    state.errorQueue = [missingItemName, null];
    await recordPurchaseInitiated({
      sessionId: "cs_drift",
      mode: "topup",
      itemId: "item-1",
      itemSlug: "pack-small",
      itemName: "100 Credit Pack",
      quantity: 1,
      cloneId: "clone-1",
      tenantId: "tenant-1",
      attribution,
    });

    const writes = state.inserts.filter((i) => i.table === "purchases");
    expect(writes).toHaveLength(2);
    expect(writes[0].values).toHaveProperty("item_name");
    // The retry keeps everything that identifies the purchase.
    expect(writes[1].values).not.toHaveProperty("item_name");
    expect(writes[1].values).toMatchObject({
      stripe_checkout_session_id: "cs_drift",
      status: "initiated",
      item_slug: "pack-small",
      tenant_id: "tenant-1",
      origin_source: "clone:npc",
    });
    // Succeeded on the retry, so nothing is logged as a failure.
    expect(state.inserts.some((i) => i.table === "audit_log")).toBe(false);
  });

  it("finalises a completed purchase rather than throwing the webhook into retry", async () => {
    state.errorQueue = [missingItemName, null];
    await expect(finalizePurchaseFromSession(makeSession(), "completed")).resolves.toBeUndefined();
    expect(state.upserts).toHaveLength(2);
    expect(state.upserts[1].values).not.toHaveProperty("item_name");
    expect(state.upserts[1].values).toMatchObject({
      stripe_checkout_session_id: "cs_test_abc",
      status: "completed",
    });
  });

  it("refuses to write a row stripped of what identifies it", async () => {
    // A rejected identity column is not drift we can degrade around — a
    // purchase with no session id answers none of the questions the ledger
    // exists to answer, so it must fail loudly instead.
    state.errorQueue = [
      { message: "column purchases.stripe_checkout_session_id does not exist" },
      null,
    ];
    await expect(finalizePurchaseFromSession(makeSession(), "completed")).rejects.toThrow(
      /finalize_purchase_failed/,
    );
    expect(state.upserts).toHaveLength(1);
  });

  it("drops each unknown column in turn, then gives up rather than looping", async () => {
    state.errorQueue = [
      { message: "column purchases.item_name does not exist" },
      { message: "column purchases.quantity does not exist" },
      null,
    ];
    await recordPurchaseInitiated({
      sessionId: "cs_two",
      mode: "topup",
      itemId: "item-1",
      itemSlug: null,
      itemName: "Pack",
      quantity: 1,
      cloneId: null,
      tenantId: null,
      attribution,
    });
    const writes = state.inserts.filter((i) => i.table === "purchases");
    expect(writes).toHaveLength(3);
    expect(writes[2].values).not.toHaveProperty("item_name");
    expect(writes[2].values).not.toHaveProperty("quantity");
    expect(writes[2].values).toMatchObject({ stripe_checkout_session_id: "cs_two" });
  });

  it("does not retry an error that is not about a column", async () => {
    state.errorQueue = [{ message: "permission denied for table purchases" }, null];
    await expect(finalizePurchaseFromSession(makeSession(), "completed")).rejects.toThrow(
      /permission denied/,
    );
    expect(state.upserts).toHaveLength(1);
  });
});
