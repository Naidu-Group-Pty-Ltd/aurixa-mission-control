import { describe, expect, it } from "vitest";
import {
  applySpend,
  expirySchedule,
  forfeitedBalance,
  orderLots,
  resolveIssueExpiry,
  spendableBalance,
  TOKEN_EXPIRY_DAYS,
  type TokenLot,
} from "./token-lots.server";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000).toISOString();

const lot = (over: Partial<TokenLot> & { amount: number }): TokenLot => ({
  expiresAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("orderLots — soonest expiry first", () => {
  it("spends the credit that lapses first, and never-expiring credit last", () => {
    const ordered = orderLots([
      lot({ amount: 10, expiresAt: null, kind: "gift-forever" }),
      lot({ amount: 10, expiresAt: daysFromNow(30), kind: "later" }),
      lot({ amount: 10, expiresAt: daysFromNow(3), kind: "soonest" }),
    ]);
    expect(ordered.map((l) => l.kind)).toEqual(["soonest", "later", "gift-forever"]);
  });

  it("breaks a same-expiry tie on age, and is stable", () => {
    const same = daysFromNow(10);
    const ordered = orderLots([
      lot({ amount: 5, expiresAt: same, createdAt: "2026-07-20T00:00:00.000Z", kind: "newer" }),
      lot({ amount: 5, expiresAt: same, createdAt: "2026-07-02T00:00:00.000Z", kind: "older" }),
    ]);
    expect(ordered.map((l) => l.kind)).toEqual(["older", "newer"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [
      lot({ amount: 1, expiresAt: daysFromNow(9), kind: "b" }),
      lot({ amount: 1, expiresAt: daysFromNow(1), kind: "a" }),
    ];
    orderLots(input);
    expect(input[0].kind).toBe("b");
  });
});

describe("spendableBalance — the bug lot accounting exists to fix", () => {
  it("does not forfeit credit that was already spent from an expired lot", () => {
    // grant +100 (lapsed), topup +50 (live), 30 spent from the grant.
    // Netting the ledger and dropping the expired row gives 20. The honest
    // answer is 50 — only the grant's unspent 70 lapsed.
    const lots = [
      lot({ amount: 100, expiresAt: daysFromNow(-1), createdAt: "2026-06-01T00:00:00.000Z" }),
      lot({ amount: 50, expiresAt: daysFromNow(20), createdAt: "2026-07-25T00:00:00.000Z" }),
    ];
    expect(spendableBalance(lots, 30, NOW)).toBe(50);
    expect(forfeitedBalance(lots, 30, NOW)).toBe(70);
  });

  it("spends the soonest-expiring credit first, so more survives", () => {
    // 40 spent. Taking it from the lot that lapses in 2 days leaves the
    // 60-day lot whole; the other order would have burned the durable credit
    // and let the short-dated one lapse.
    const lots = [
      lot({ amount: 40, expiresAt: daysFromNow(2) }),
      lot({ amount: 100, expiresAt: daysFromNow(60) }),
    ];
    expect(spendableBalance(lots, 40, NOW)).toBe(100);
    expect(forfeitedBalance(lots, 40, NOW)).toBe(0);
  });

  it("handles a partial consumption at the crossover", () => {
    const lots = [
      lot({ amount: 30, expiresAt: daysFromNow(5) }),
      lot({ amount: 30, expiresAt: daysFromNow(15) }),
    ];
    // 45 spent: the first lot is gone, 15 of the second remains.
    expect(spendableBalance(lots, 45, NOW)).toBe(15);
    const remainders = applySpend(lots, 45, NOW);
    expect(remainders.map((r) => r.remaining)).toEqual([0, 15]);
  });

  it("never goes negative when spend exceeds all credit", () => {
    // Overage policies can let a reserve through on an empty balance; that
    // must not become debt against future credit.
    const lots = [lot({ amount: 10, expiresAt: daysFromNow(5) })];
    expect(spendableBalance(lots, 999, NOW)).toBe(0);
  });

  it("treats an unexpired lot with no date as fully spendable", () => {
    expect(spendableBalance([lot({ amount: 25, expiresAt: null })], 0, NOW)).toBe(25);
  });

  it("is zero for no lots, and unaffected by zero spend", () => {
    expect(spendableBalance([], 0, NOW)).toBe(0);
    expect(spendableBalance([], 500, NOW)).toBe(0);
    expect(spendableBalance([lot({ amount: 7, expiresAt: daysFromNow(1) })], 0, NOW)).toBe(7);
  });

  it("counts a lot expiring exactly now as lapsed", () => {
    const lots = [lot({ amount: 10, expiresAt: NOW.toISOString() })];
    expect(spendableBalance(lots, 0, NOW)).toBe(0);
    expect(forfeitedBalance(lots, 0, NOW)).toBe(10);
  });
});

describe("expirySchedule", () => {
  it("reports what lapses inside the warning window and when the next one goes", () => {
    const lots = [
      lot({ amount: 20, expiresAt: daysFromNow(3) }),
      lot({ amount: 50, expiresAt: daysFromNow(25) }),
      lot({ amount: 5, expiresAt: null }),
    ];
    const schedule = expirySchedule(lots, 0, { now: NOW });
    expect(schedule.expiringSoon).toBe(20);
    expect(schedule.nextExpiryAt).toBe(daysFromNow(3));
    expect(schedule.upcoming.map((l) => l.remaining)).toEqual([20, 50, 5]);
  });

  it("counts only what actually survives, not the original lot size", () => {
    // 15 of the 20 that lapses in 3 days is already spent.
    const lots = [
      lot({ amount: 20, expiresAt: daysFromNow(3) }),
      lot({ amount: 50, expiresAt: daysFromNow(25) }),
    ];
    expect(expirySchedule(lots, 15, { now: NOW }).expiringSoon).toBe(5);
  });

  it("excludes lapsed lots and lots with nothing left", () => {
    const lots = [
      lot({ amount: 10, expiresAt: daysFromNow(-2) }),
      lot({ amount: 10, expiresAt: daysFromNow(4) }),
    ];
    const schedule = expirySchedule(lots, 10, { now: NOW });
    // The lapsed lot is gone; the spend came out of it, so the live lot is whole.
    expect(schedule.upcoming).toHaveLength(1);
    expect(schedule.upcoming[0].remaining).toBe(10);
  });

  it("has no next expiry when everything is undated", () => {
    const schedule = expirySchedule([lot({ amount: 10, expiresAt: null })], 0, { now: NOW });
    expect(schedule.nextExpiryAt).toBeNull();
    expect(schedule.expiringSoon).toBe(0);
  });

  it("honours a custom horizon", () => {
    const lots = [lot({ amount: 30, expiresAt: daysFromNow(20) })];
    expect(expirySchedule(lots, 0, { now: NOW, withinDays: 7 }).expiringSoon).toBe(0);
    expect(expirySchedule(lots, 0, { now: NOW, withinDays: 30 }).expiringSoon).toBe(30);
  });
});

describe("resolveIssueExpiry", () => {
  it("gives plan allowances and unbounded packs the platform lifetime", () => {
    expect(resolveIssueExpiry(NOW).toISOString()).toBe(daysFromNow(TOKEN_EXPIRY_DAYS));
    expect(resolveIssueExpiry(NOW, { packDays: null }).toISOString()).toBe(
      daysFromNow(TOKEN_EXPIRY_DAYS),
    );
  });

  it("treats 30 days as a ceiling, so a shorter pack keeps its own window", () => {
    expect(resolveIssueExpiry(NOW, { packDays: 7 }).toISOString()).toBe(daysFromNow(7));
    expect(resolveIssueExpiry(NOW, { packDays: 90 }).toISOString()).toBe(
      daysFromNow(TOKEN_EXPIRY_DAYS),
    );
  });

  it("lets a gift override the date entirely — the only path that can", () => {
    const override = new Date("2027-01-01T00:00:00.000Z");
    expect(resolveIssueExpiry(NOW, { overrideAt: override })).toBe(override);
    // An override wins even against a shorter pack window.
    expect(resolveIssueExpiry(NOW, { overrideAt: override, packDays: 3 })).toBe(override);
  });

  it("is 30 days", () => {
    expect(TOKEN_EXPIRY_DAYS).toBe(30);
  });
});
