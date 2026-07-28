// The two pure decisions in the allowance path, both of which have already
// caused real bugs in their top-up equivalents: which workspace gets credited,
// and what counts as the same change happening twice.
import { describe, expect, it } from "vitest";
import { billingHintFromMetadata, planChangeRef } from "./plan-allowance.server";

describe("billingHintFromMetadata", () => {
  it("prefers the billing id checkout already resolved", () => {
    expect(
      billingHintFromMetadata({ billing_user_id: "bu_1", origin_user_id: "uid_2" }),
    ).toBe("bu_1");
  });

  it("falls back to the uid a storefront link carried", () => {
    // Checkout only auto-resolves a tenant for top-ups and setup packages, so
    // a seat plan usually arrives with billing_user_id empty. Losing the uid
    // here would leave the webhook guessing which of a clone's tenants to
    // credit — the same mistake that once sent top-ups to a second tenant the
    // dashboard never read.
    expect(
      billingHintFromMetadata({
        billing_user_id: "",
        origin_source: "storefront_uid",
        origin_user_id: "uid_2",
      }),
    ).toBe("uid_2");
  });

  it("ignores an origin id that is not an operator-assigned billing id", () => {
    // A handoff's origin_user_id is a person in the clone, not a billing id.
    expect(
      billingHintFromMetadata({ origin_source: "handoff", origin_user_id: "person_9" }),
    ).toBeNull();
  });

  it("is null rather than empty string when nothing is known", () => {
    expect(billingHintFromMetadata({})).toBeNull();
    expect(billingHintFromMetadata(null)).toBeNull();
    expect(billingHintFromMetadata({ billing_user_id: "" })).toBeNull();
  });
});

describe("planChangeRef", () => {
  it("is stable, so a redelivered webhook is the same change", () => {
    expect(planChangeRef("session", "cs_1", "plan_a")).toBe(
      planChangeRef("session", "cs_1", "plan_a"),
    );
  });

  it("separates a plan switch from a routine subscription update", () => {
    // Both arrive as customer.subscription.updated on the same subscription.
    // Only the one that changed plan should credit a new allowance, so the
    // plan is part of the key.
    expect(planChangeRef("subscription", "sub_1", "growth")).not.toBe(
      planChangeRef("subscription", "sub_1", "scale"),
    );
  });

  it("does not confuse a checkout with the subscription it created", () => {
    // Buying a plan fires both checkout.session.completed and
    // customer.subscription.updated. Sharing a key would make the second a
    // no-op replay of the first — which is fine — but sharing it ACROSS
    // different ids would suppress a genuine later change.
    expect(planChangeRef("session", "x", "p")).not.toBe(planChangeRef("subscription", "x", "p"));
  });
});
