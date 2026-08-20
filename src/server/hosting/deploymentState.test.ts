import { describe, expect, it } from "vitest";
import {
  ADVANCE,
  CLAIMABLE,
  DEPLOYMENT_STATUSES,
  backoffSeconds,
  isDormant,
  isRetryable,
  isTerminal,
  reading,
} from "./deploymentState.pure";

describe("the four readings", () => {
  it("never paraphrases 'not requested' as a failure", () => {
    // The whole reason this function returns a reading rather than a boolean.
    const notRequested = reading("not_requested");
    const failed = reading("failed");
    expect(notRequested.reading).toBe("absent");
    expect(failed.reading).toBe("broken");
    expect(notRequested.tone).not.toBe(failed.tone);
    expect(notRequested.label).not.toContain("fail");
    expect(notRequested.detail.toLowerCase()).toContain("not a failure");
  });

  it("keeps 'never asked', 'in flight' and 'broke' apart", () => {
    expect(reading(null).reading).toBe("absent");
    expect(reading("deploying").reading).toBe("working");
    expect(reading("failed").reading).toBe("broken");
    expect(reading("live").reading).toBe("live");
  });

  it("says nothing has been attempted when no provider token exists", () => {
    const dormant = reading("pending_platform", { providerConfigured: false });
    expect(dormant.detail).toContain("Nothing has been attempted");
  });

  it("covers every declared status", () => {
    for (const status of DEPLOYMENT_STATUSES) {
      const r = reading(status);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("the state machine", () => {
  it("reaches live from pending with no orphaned step", () => {
    let s: string | undefined = "pending";
    const seen: string[] = [];
    while (s && ADVANCE[s as keyof typeof ADVANCE]) {
      seen.push(s);
      s = ADVANCE[s as keyof typeof ADVANCE];
    }
    expect(s).toBe("live");
    expect(seen).toEqual([
      "pending",
      "creating_project",
      "linking_repo",
      "syncing_env",
      "deploying",
      "attaching_domain",
      "verifying_domain",
    ]);
  });

  it("claims exactly the non-terminal, non-dormant states", () => {
    const expected = DEPLOYMENT_STATUSES.filter((s) => !isTerminal(s) && !isDormant(s));
    expect([...CLAIMABLE].sort()).toEqual([...expected].sort());
  });

  it("treats dormant and terminal as different things", () => {
    // A dormant row resumes when the platform is configured; a terminal one
    // does not resume on its own. Collapsing them strands one or spins the other.
    expect(isDormant("pending_platform")).toBe(true);
    expect(isTerminal("pending_platform")).toBe(false);
    expect(isTerminal("failed")).toBe(true);
    expect(isDormant("failed")).toBe(false);
  });
});

describe("retry policy", () => {
  it("does not retry a request that was wrong", () => {
    // Repeating a 400 five times arrives at the same answer an hour later.
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it("retries rate limits and server faults", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it("retries an error with no status — a network failure is not a verdict", () => {
    expect(isRetryable(null)).toBe(true);
    expect(isRetryable({})).toBe(true);
  });

  it("backs off exponentially and caps at an hour", () => {
    expect(backoffSeconds(0)).toBe(15);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(99)).toBe(3600);
  });
});
