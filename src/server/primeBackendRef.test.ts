import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolvePrimeBackendRef, ownProjectRef } from "./prime-backend.server";

/** Minimal stand-in for the query chain the resolver uses. */
function client(row: Record<string, unknown> | null, error?: { message: string }) {
  return {
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: async () => ({ data: row, error: error ?? null }),
        }),
      }),
    }),
  };
}

const OWN = "aaaaaaaaaaaaaaaaaaaa";
const PRIME = "bbbbbbbbbbbbbbbbbbbb";

describe("resolvePrimeBackendRef", () => {
  const original = process.env.SUPABASE_URL;
  beforeEach(() => {
    process.env.SUPABASE_URL = `https://${OWN}.supabase.co`;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = original;
  });

  it("returns the configured prime backend ref", async () => {
    await expect(resolvePrimeBackendRef(client({ supabase_project_ref: PRIME }))).resolves.toBe(
      PRIME,
    );
  });

  it("refuses when unset rather than falling back to a derivable ref", async () => {
    // The whole defect: SUPABASE_URL is always available, so any fallback
    // silently succeeds against the wrong database.
    await expect(resolvePrimeBackendRef(client({ supabase_project_ref: null }))).rejects.toThrow(
      /not configured/i,
    );
  });

  it("refuses this deployment's own project even when set by hand", async () => {
    await expect(resolvePrimeBackendRef(client({ supabase_project_ref: OWN }))).rejects.toThrow(
      /own project/i,
    );
  });

  it("distinguishes a failed read from an absent row", async () => {
    await expect(
      resolvePrimeBackendRef(client(null, { message: "connection refused" })),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("ownProjectRef", () => {
  const original = process.env.SUPABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = original;
  });

  it("extracts the ref from a project URL", () => {
    process.env.SUPABASE_URL = `https://${OWN}.supabase.co`;
    expect(ownProjectRef()).toBe(OWN);
  });

  it("returns null rather than throwing when unset, so guards degrade open", () => {
    delete process.env.SUPABASE_URL;
    expect(ownProjectRef()).toBeNull();
  });
});
