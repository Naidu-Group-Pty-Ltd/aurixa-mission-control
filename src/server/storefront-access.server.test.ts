import { describe, expect, it } from "vitest";
import { evaluateGrant, isGrantToken, type GrantRow } from "./storefront-access.server";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  id: "8f14e45f-ceea-4d0d-9c1b-0c0b6b7a1a11",
  label: "Acme Partners",
  revoked_at: null,
  expires_at: null,
  ...over,
});

describe("evaluateGrant", () => {
  it("grants an unexpired, unrevoked grant", () => {
    expect(evaluateGrant(grant(), NOW)).toEqual({
      granted: true,
      reason: "grant",
      label: "Acme Partners",
    });
  });

  it("grants one that expires in the future", () => {
    expect(evaluateGrant(grant({ expires_at: at(7) }), NOW).granted).toBe(true);
  });

  it("denies an expired grant", () => {
    const d = evaluateGrant(grant({ expires_at: at(-1) }), NOW);
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("grant_expired");
  });

  it("treats an expiry of exactly now as expired", () => {
    // A grant good "until noon" should not still work at noon.
    expect(evaluateGrant(grant({ expires_at: NOW.toISOString() }), NOW).granted).toBe(false);
  });

  it("denies a revoked grant", () => {
    const d = evaluateGrant(grant({ revoked_at: at(-2) }), NOW);
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("grant_revoked");
  });

  it("reports revocation ahead of expiry when both apply", () => {
    // The operator revoked it; that is the answer they can act on, and the
    // one that explains why it stopped working when it did.
    const d = evaluateGrant(grant({ revoked_at: at(-2), expires_at: at(-1) }), NOW);
    expect(d.reason).toBe("grant_revoked");
  });

  it("denies an unknown grant, and never invents a label", () => {
    const d = evaluateGrant(null, NOW);
    expect(d).toEqual({ granted: false, reason: "grant_unknown", label: null });
  });

  it("keeps the label on a denial, so an operator can see which grant failed", () => {
    expect(evaluateGrant(grant({ revoked_at: at(-1) }), NOW).label).toBe("Acme Partners");
  });
});

describe("isGrantToken", () => {
  it("accepts a UUID in either case, trimmed", () => {
    expect(isGrantToken("8f14e45f-ceea-4d0d-9c1b-0c0b6b7a1a11")).toBe(true);
    expect(isGrantToken("8F14E45F-CEEA-4D0D-9C1B-0C0B6B7A1A11")).toBe(true);
    expect(isGrantToken("  8f14e45f-ceea-4d0d-9c1b-0c0b6b7a1a11  ")).toBe(true);
  });

  it("rejects anything that is not one, before it reaches the database", () => {
    // A token is a primary key lookup; shapes that cannot be one are refused
    // here rather than handed to Postgres to reject.
    for (const bad of ["", null, undefined, "not-a-uuid", "1", "' OR 1=1 --", "8f14e45f"]) {
      expect(isGrantToken(bad as string)).toBe(false);
    }
  });
});
