import { describe, expect, it } from "vitest";
import { isPurchaseSession, purchaseStatusFromSession } from "./purchase-backfill.server";

describe("purchaseStatusFromSession", () => {
  it("records a paid, complete session as completed", () => {
    expect(purchaseStatusFromSession({ status: "complete", payment_status: "paid" })).toBe(
      "completed",
    );
  });

  it("treats a zero-value complete session as completed", () => {
    expect(
      purchaseStatusFromSession({ status: "complete", payment_status: "no_payment_required" }),
    ).toBe("completed");
  });

  it("does not call a delayed payment completed before the money lands", () => {
    // Same rule the webhook applies: marking this completed would show a paid
    // purchase for funds that may never clear.
    expect(purchaseStatusFromSession({ status: "complete", payment_status: "unpaid" })).toBe(
      "initiated",
    );
  });

  it("records an expired session as abandoned, not initiated", () => {
    // This is the case the outage window is full of — a checkout the customer
    // opened and walked away from. 'initiated' would imply it is still live.
    expect(purchaseStatusFromSession({ status: "expired", payment_status: "unpaid" })).toBe(
      "abandoned",
    );
  });

  it("leaves a still-open session as initiated", () => {
    expect(purchaseStatusFromSession({ status: "open", payment_status: "unpaid" })).toBe(
      "initiated",
    );
  });

  it("falls back to initiated for an unknown or missing status", () => {
    expect(purchaseStatusFromSession({})).toBe("initiated");
    expect(purchaseStatusFromSession({ status: null, payment_status: null })).toBe("initiated");
  });
});

describe("isPurchaseSession", () => {
  it("accepts the two modes that buy something", () => {
    expect(isPurchaseSession({ mode: "payment" })).toBe(true);
    expect(isPurchaseSession({ mode: "subscription" })).toBe(true);
  });

  it("rejects card-save sessions, which are not purchases", () => {
    // setup mode vaults a payment method: no money, no catalog item, and it
    // never had a purchases row to restore.
    expect(isPurchaseSession({ mode: "setup" })).toBe(false);
    expect(isPurchaseSession({})).toBe(false);
  });
});
