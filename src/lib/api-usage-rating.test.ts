import { describe, it, expect } from "vitest";
import {
  resolveBillingReason,
  isBillable,
  rateEvent,
  microsToCents,
  settleLines,
  normalizeEvent,
  MAX_QUANTITY,
  MAX_BACKDATE_DAYS,
  type RollupLine,
} from "./api-usage-rating";

const base = {
  cloneId: "clone-1",
  secretStatus: "inherited" as const,
  rateExists: true,
  rateIsBillable: true,
  callStatus: "success" as const,
};

describe("resolveBillingReason", () => {
  it("charges a clone running on our forwarded key", () => {
    expect(resolveBillingReason(base)).toBe("inherited");
    expect(isBillable("inherited")).toBe(true);
  });

  it("does not charge a clone that supplied its own key", () => {
    // The headline promise: change the key, stop paying for that key.
    const reason = resolveBillingReason({ ...base, secretStatus: "set" });
    expect(reason).toBe("byok");
    expect(isBillable(reason)).toBe(false);
  });

  it("does not charge when no key ever landed on the clone", () => {
    expect(resolveBillingReason({ ...base, secretStatus: "missing" })).toBe("no_key");
    expect(resolveBillingReason({ ...base, secretStatus: "failed" })).toBe("no_key");
  });

  it("never charges on a guess when we have no record of lending the key", () => {
    const reason = resolveBillingReason({ ...base, secretStatus: null });
    expect(reason).toBe("unknown_secret");
    expect(isBillable(reason)).toBe(false);
  });

  it("treats a tenant with no clone as the prime's own usage", () => {
    // The prime runs on its own project and its own keys — nothing to recharge,
    // even though its secret status would never be 'set'.
    expect(resolveBillingReason({ ...base, cloneId: null })).toBe("no_key");
  });

  it("does not charge for a failed vendor call", () => {
    expect(resolveBillingReason({ ...base, callStatus: "error" })).toBe("error_call");
  });

  it("does not charge for keys flagged as platform overhead", () => {
    expect(resolveBillingReason({ ...base, rateIsBillable: false })).toBe("not_billable");
  });

  it("surfaces an uncatalogued secret rather than charging it", () => {
    expect(resolveBillingReason({ ...base, rateExists: false })).toBe("rate_missing");
  });

  it("puts the catalog checks ahead of the piggyback check", () => {
    // An un-priced key on a BYOK clone is still primarily a catalog gap, and
    // the dashboard needs to see it as one.
    expect(resolveBillingReason({ ...base, rateExists: false, secretStatus: "set" })).toBe(
      "rate_missing",
    );
  });

  it("only ever returns billable for 'inherited'", () => {
    const reasons = [
      "byok",
      "no_key",
      "unknown_secret",
      "not_billable",
      "error_call",
      "rate_missing",
    ] as const;
    for (const r of reasons) expect(isBillable(r)).toBe(false);
  });
});

describe("rateEvent", () => {
  it("multiplies quantity by the per-unit rate", () => {
    expect(rateEvent(1000, 0.6)).toBe(600);
  });

  it("floors nonsense inputs at zero rather than producing a negative charge", () => {
    expect(rateEvent(-5, 100)).toBe(0);
    expect(rateEvent(10, -100)).toBe(0);
    expect(rateEvent(Number.NaN, 100)).toBe(0);
  });

  it("keeps sub-cent per-token rates instead of rounding them away", () => {
    // 12,500 Gemini Flash tokens at 0.6 micros. In cents this is 0.75c —
    // rounding at the event would meter it as free.
    expect(rateEvent(12_500, 0.6)).toBe(7500);
  });
});

describe("microsToCents", () => {
  it("converts at 10,000 micros to the cent", () => {
    expect(microsToCents(10_000)).toBe(1);
    expect(microsToCents(4_126_000)).toBe(413);
  });

  it("rounds half up", () => {
    expect(microsToCents(5_000)).toBe(1);
    expect(microsToCents(4_999)).toBe(0);
  });

  it("returns zero for nothing owed", () => {
    expect(microsToCents(0)).toBe(0);
    expect(microsToCents(-1)).toBe(0);
    expect(microsToCents(Number.NaN)).toBe(0);
  });
});

function line(over: Partial<RollupLine> = {}): RollupLine {
  return {
    secret_name: "OPENAI_API_KEY",
    provider: "openai",
    display_name: "OpenAI",
    unit: "token",
    billable_quantity: 0,
    byok_quantity: 0,
    included_free_units: 0,
    resale_micros_per_unit: 1.8,
    ...over,
  };
}

describe("settleLines", () => {
  it("rates the billable quantity", () => {
    const out = settleLines([line({ billable_quantity: 100_000 })]);
    expect(out.totalMicros).toBe(180_000);
    expect(out.totalCents).toBe(18);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].charged_quantity).toBe(100_000);
  });

  it("applies the free allowance once per period, not per call", () => {
    const out = settleLines([line({ billable_quantity: 150_000, included_free_units: 100_000 })]);
    expect(out.lines[0].free_units_applied).toBe(100_000);
    expect(out.lines[0].charged_quantity).toBe(50_000);
    expect(out.totalMicros).toBe(90_000);
  });

  it("never forgives more than was used", () => {
    const out = settleLines([line({ billable_quantity: 30, included_free_units: 100 })]);
    expect(out.lines).toHaveLength(0); // nothing charged, nothing saved via BYOK
    expect(out.totalMicros).toBe(0);
  });

  it("keeps a line that only shows a BYOK saving", () => {
    // The tenant swapped in their own key. There is nothing to charge, but the
    // statement should still show what their key covered.
    const out = settleLines([line({ billable_quantity: 0, byok_quantity: 400_000 })]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].charged_quantity).toBe(0);
    expect(out.lines[0].byok_quantity).toBe(400_000);
    expect(out.totalCents).toBe(0);
  });

  it("sums sub-cent lines before converting, so they do not each round to zero", () => {
    // Three lines worth 0.4c each. Rounding per line gives 0c; rounding the
    // total gives 1c, which is what we actually owe the vendor.
    const lines = Array.from({ length: 3 }, (_, i) =>
      line({ secret_name: `K${i}`, billable_quantity: 4_000, resale_micros_per_unit: 1 }),
    );
    const out = settleLines(lines);
    expect(out.totalMicros).toBe(12_000);
    expect(out.totalCents).toBe(1);
  });

  it("totals a mixed period across providers", () => {
    const out = settleLines([
      line({ secret_name: "OPENAI_API_KEY", billable_quantity: 500_000 }), // 900_000
      line({
        secret_name: "COTALITY_API_KEY",
        provider: "cotality",
        unit: "lookup",
        billable_quantity: 12,
        resale_micros_per_unit: 90_000,
      }), // 1_080_000
      line({
        secret_name: "RESEND_API_KEY",
        provider: "resend",
        unit: "email",
        billable_quantity: 260,
        included_free_units: 100,
        resale_micros_per_unit: 900,
      }), // 160 × 900 = 144_000
    ]);
    expect(out.totalMicros).toBe(2_124_000);
    expect(out.totalCents).toBe(212);
    expect(out.lines).toHaveLength(3);
  });
});

describe("normalizeEvent", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");
  const ok = { secret_name: "OPENAI_API_KEY", quantity: 10, idempotency_key: "abc" };

  it("accepts a well-formed event", () => {
    const r = normalizeEvent(ok, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.status).toBe("success");
      expect(r.event.occurred_at).toBe(now.toISOString());
    }
  });

  it("rejects a secret name that is not an env-var name", () => {
    // A reporter sending a provider slug where a secret name belongs would
    // otherwise meter under a name the provisioner never lends.
    expect(normalizeEvent({ ...ok, secret_name: "openai" }, now)).toEqual({
      ok: false,
      error: "invalid_secret_name: openai",
    });
  });

  it("requires an idempotency key so a retried batch cannot double-charge", () => {
    expect(normalizeEvent({ ...ok, idempotency_key: "" }, now).ok).toBe(false);
  });

  it("rejects quantities that are missing, negative or implausible", () => {
    expect(normalizeEvent({ ...ok, quantity: undefined }, now).ok).toBe(false);
    expect(normalizeEvent({ ...ok, quantity: -1 }, now).ok).toBe(false);
    expect(normalizeEvent({ ...ok, quantity: MAX_QUANTITY + 1 }, now).ok).toBe(false);
  });

  it("clamps a fast clone clock to now rather than booking a future period", () => {
    const r = normalizeEvent({ ...ok, occurred_at: "2026-09-01T00:00:00.000Z" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.occurred_at).toBe(now.toISOString());
  });

  it("refuses to backdate past a settled period", () => {
    const old = new Date(now.getTime() - (MAX_BACKDATE_DAYS + 1) * 86_400_000);
    const r = normalizeEvent({ ...ok, occurred_at: old.toISOString() }, now);
    expect(r.ok).toBe(false);
  });

  it("keeps a legitimate late retry", () => {
    const yesterday = new Date(now.getTime() - 86_400_000);
    const r = normalizeEvent({ ...ok, occurred_at: yesterday.toISOString() }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.occurred_at).toBe(yesterday.toISOString());
  });

  it("marks a failed vendor call so ingest can decline to charge it", () => {
    const r = normalizeEvent({ ...ok, status: "error" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.status).toBe("error");
  });
});
