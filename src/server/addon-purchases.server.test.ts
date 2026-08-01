import { describe, it, expect } from "vitest";
import {
  isKnownAddon,
  mapStripeStatus,
  ENTITLING_STATUSES,
  type AddonStatus,
} from "./addon-purchases.server";
import { MODULES } from "@/lib/pricing/aurixa-catalog";

describe("isKnownAddon", () => {
  it("accepts every slug in the priced catalogue", () => {
    for (const m of MODULES) expect(isKnownAddon(m.slug)).toBe(true);
  });

  it("rejects anything not on the price list", () => {
    // A typo must not create an entitlement for something nobody sells.
    expect(isKnownAddon("market-update")).toBe(false);
    expect(isKnownAddon("")).toBe(false);
    expect(isKnownAddon("platform-core")).toBe(false);
  });
});

describe("ENTITLING_STATUSES", () => {
  it("keeps a past-due add-on entitled", () => {
    // A failed card should not strip features mid-period; dunning decides when
    // the row becomes cancelled, and only then does access stop.
    expect(ENTITLING_STATUSES).toContain("past_due");
    expect(ENTITLING_STATUSES).toContain("active");
  });

  it("does not entitle on cancelled or pending", () => {
    expect(ENTITLING_STATUSES).not.toContain("cancelled");
    expect(ENTITLING_STATUSES).not.toContain("pending");
  });
});

describe("mapStripeStatus", () => {
  const cases: Array<[string | undefined, AddonStatus]> = [
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "past_due"],
    ["unpaid", "past_due"],
    ["incomplete", "pending"],
    ["canceled", "cancelled"],
    ["incomplete_expired", "cancelled"],
  ];

  for (const [stripe, expected] of cases) {
    it(`maps ${stripe} to ${expected}`, () => {
      expect(mapStripeStatus(stripe)).toBe(expected);
    });
  }

  it("never entitles on an unrecognised status", () => {
    // Stripe adds statuses over time. Defaulting to anything entitling would
    // hand out code on a status we have not reasoned about.
    expect(mapStripeStatus("some_future_status")).toBe("pending");
    expect(mapStripeStatus(undefined)).toBe("pending");
    expect(ENTITLING_STATUSES).not.toContain(mapStripeStatus("some_future_status"));
  });

  it("treats a trial as entitling, since the customer has access", () => {
    expect(ENTITLING_STATUSES).toContain(mapStripeStatus("trialing"));
  });
});
