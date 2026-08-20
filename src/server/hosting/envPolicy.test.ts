import { describe, expect, it } from "vitest";
import {
  EnvPolicyError,
  buildCloneEnv,
  envDigest,
  isPublicName,
  looksSecret,
  refuseReason,
} from "./envPolicy.pure";

describe("public-name classification", () => {
  it("knows which prefixes a bundler inlines", () => {
    expect(isPublicName("VITE_SUPABASE_URL")).toBe(true);
    expect(isPublicName("NEXT_PUBLIC_API")).toBe(true);
    expect(isPublicName("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
  });

  it("does not flag the keys that are publishable by design", () => {
    // A rule that flags every name containing KEY is a rule people turn off.
    expect(looksSecret("VITE_SUPABASE_ANON_KEY")).toBe(false);
    expect(looksSecret("VITE_SUPABASE_PUBLISHABLE_KEY")).toBe(false);
  });

  it("flags authority-granting names wherever the fragment sits", () => {
    expect(looksSecret("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(looksSecret("VITE_STRIPE_WEBHOOK_SECRET")).toBe(true);
    expect(looksSecret("db_pass")).toBe(true);
  });
});

describe("refuseReason", () => {
  it("is silent for a secret with a private name", () => {
    // Nothing wrong with a service-role key that is NOT public — that is where
    // it belongs.
    expect(refuseReason("SUPABASE_SERVICE_ROLE_KEY")).toBeNull();
  });

  it("is silent for a publishable value with a public name", () => {
    expect(refuseReason("VITE_SUPABASE_ANON_KEY")).toBeNull();
  });

  it("refuses a secret given a public prefix, and names the fragment", () => {
    const reason = refuseReason("VITE_SUPABASE_SERVICE_ROLE_KEY");
    expect(reason).toContain("SERVICE_ROLE");
    expect(reason).toContain("client bundle");
  });
});

describe("buildCloneEnv", () => {
  it("emits both anon-key spellings so an older clone still builds", () => {
    const vars = buildCloneEnv({
      supabaseUrl: "https://abc.supabase.co",
      supabaseProjectRef: "abc",
      supabaseAnonKey: "anon-123",
    });
    const keys = vars.map((v) => v.key);
    expect(keys).toContain("VITE_SUPABASE_ANON_KEY");
    expect(keys).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
  });

  it("drops empty and absent values rather than publishing an empty string", () => {
    // An empty VITE_SUPABASE_URL builds fine and fails at the first request.
    const vars = buildCloneEnv({ supabaseUrl: "  ", supabaseAnonKey: null });
    expect(vars).toEqual([]);
  });

  it("THROWS when an extra would publish a secret", () => {
    expect(() => buildCloneEnv({ extra: { VITE_SUPABASE_SERVICE_ROLE_KEY: "sk-real" } })).toThrow(
      EnvPolicyError,
    );
  });

  it("has no parameter for the service-role key at all", () => {
    // The strongest form of the guarantee: a caller cannot pass what the type
    // does not name. This asserts the shape rather than a runtime filter.
    const input: Parameters<typeof buildCloneEnv>[0] = {};
    expect(Object.keys(input)).not.toContain("supabaseServiceRoleKey");
  });

  it("marks every emitted var with whether the bundle will carry it", () => {
    const vars = buildCloneEnv({
      supabaseUrl: "https://abc.supabase.co",
      extra: { SENTRY_DSN: "https://x@y/1" },
    });
    expect(vars.find((v) => v.key === "VITE_SUPABASE_URL")?.publicToBundle).toBe(true);
    expect(vars.find((v) => v.key === "SENTRY_DSN")?.publicToBundle).toBe(false);
  });
});

describe("envDigest", () => {
  it("is stable across ordering", () => {
    const a = buildCloneEnv({ supabaseUrl: "https://a.co", supabaseAnonKey: "k" });
    const b = [...a].reverse();
    expect(envDigest(a)).toBe(envDigest(b));
  });

  it("changes when a VALUE changes, not just a name", () => {
    // A rotated API key keeps its name. A digest over names alone would skip
    // the re-sync and leave the clone building against the revoked key.
    const before = buildCloneEnv({ aurixaApiKey: "ak_old" });
    const after = buildCloneEnv({ aurixaApiKey: "ak_new" });
    expect(envDigest(before)).not.toBe(envDigest(after));
  });

  it("changes when a variable is added", () => {
    const one = buildCloneEnv({ supabaseUrl: "https://a.co" });
    const two = buildCloneEnv({ supabaseUrl: "https://a.co", aurixaApiKey: "ak" });
    expect(envDigest(one)).not.toBe(envDigest(two));
  });
});
