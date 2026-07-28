import { describe, expect, it } from "vitest";
import {
  isMeteringExternalRef,
  rankTenantCandidates,
  type TenantCandidate,
} from "./billing-tenant.server";

const tenant = (over: Partial<TenantCandidate> & { id: string }): TenantCandidate => ({
  external_ref: null,
  billing_user_id: null,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("isMeteringExternalRef", () => {
  it("recognises the tenant_ref shape a clone's token client meters under", () => {
    expect(isMeteringExternalRef("prime:dduzbchuswwbefdunfct")).toBe(true);
    expect(isMeteringExternalRef("clone:npc-property")).toBe(false);
    expect(isMeteringExternalRef(null)).toBe(false);
    expect(isMeteringExternalRef(undefined)).toBe(false);
  });
});

describe("rankTenantCandidates", () => {
  it("prefers the tenant that is actually being metered over a checkout artefact", () => {
    // The exact shape of the bug: a `clone:<slug>` tenant created by a uid
    // checkout, alongside the `prime:<ref>` tenant the clone spends from.
    const ranked = rankTenantCandidates([
      tenant({
        id: "artefact",
        external_ref: "clone:npc-property",
        created_at: "2026-07-01T00:00:00Z",
      }),
      tenant({
        id: "metering",
        external_ref: "prime:abc",
        hasLedgerActivity: true,
        created_at: "2026-02-01T00:00:00Z",
      }),
    ]);
    expect(ranked[0].id).toBe("metering");
  });

  it("lets an explicit billing_user_id match outrank ledger activity", () => {
    // An operator pinning a uid to a workspace is a stronger statement than
    // "this one happens to have history".
    const ranked = rankTenantCandidates(
      [
        tenant({ id: "busy", external_ref: "prime:abc", hasLedgerActivity: true }),
        tenant({ id: "assigned", external_ref: "clone:x", billing_user_id: "npc-prime" }),
      ],
      { billingUserId: "npc-prime" },
    );
    expect(ranked[0].id).toBe("assigned");
  });

  it("ignores a blank or mismatched uid", () => {
    const candidates = [
      tenant({ id: "assigned", billing_user_id: "someone-else" }),
      tenant({ id: "metering", external_ref: "prime:abc", hasLedgerActivity: true }),
    ];
    expect(rankTenantCandidates(candidates, { billingUserId: "  " })[0].id).toBe("metering");
    expect(rankTenantCandidates(candidates, { billingUserId: "npc-prime" })[0].id).toBe("metering");
    expect(rankTenantCandidates(candidates)[0].id).toBe("metering");
  });

  it("falls back to the metering external_ref when neither has ledger history", () => {
    const ranked = rankTenantCandidates([
      tenant({ id: "artefact", external_ref: "clone:npc", created_at: "2026-01-01T00:00:00Z" }),
      tenant({ id: "metering", external_ref: "prime:abc", created_at: "2026-06-01T00:00:00Z" }),
    ]);
    expect(ranked[0].id).toBe("metering");
  });

  it("breaks a true tie on age, then id, so the choice is stable", () => {
    const older = tenant({ id: "b", created_at: "2026-01-01T00:00:00Z" });
    const newer = tenant({ id: "a", created_at: "2026-05-01T00:00:00Z" });
    expect(rankTenantCandidates([newer, older])[0].id).toBe("b");
    expect(rankTenantCandidates([older, newer])[0].id).toBe("b");

    const sameAge = [tenant({ id: "z" }), tenant({ id: "a" })];
    expect(rankTenantCandidates(sameAge)[0].id).toBe("a");
    expect(rankTenantCandidates([...sameAge].reverse())[0].id).toBe("a");
  });

  it("sorts a copy rather than mutating the caller's array", () => {
    const input = [
      tenant({ id: "artefact", external_ref: "clone:x" }),
      tenant({ id: "metering", external_ref: "prime:abc" }),
    ];
    rankTenantCandidates(input);
    expect(input[0].id).toBe("artefact");
  });

  it("handles trivial inputs", () => {
    expect(rankTenantCandidates([])).toEqual([]);
    expect(rankTenantCandidates([tenant({ id: "only" })])[0].id).toBe("only");
    // A missing created_at must not sort ahead of a real one.
    const ranked = rankTenantCandidates([
      tenant({ id: "undated", created_at: null }),
      tenant({ id: "dated", created_at: "2026-03-01T00:00:00Z" }),
    ]);
    expect(ranked[0].id).toBe("dated");
  });
});
