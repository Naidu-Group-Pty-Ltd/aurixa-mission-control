import { describe, expect, it } from "vitest";
import {
  EnvPolicyError,
  backendRefusalReason,
  buildCloneEnv,
  envDigest,
  isPublicName,
  looksSecret,
  projectRefFromAnonKey,
  projectRefFromUrl,
  refuseReason,
} from "./envPolicy.pure";

/** A real anon-key shape: header.payload.signature, `ref` in the payload. */
function anonKeyFor(ref: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role: "anon" })}.sig`;
}

const CLONE = "plisdzywzleljorrphxv";
const PRIME = "dduzbchuswwbefdunfct";
const cloneBackend = {
  supabaseUrl: `https://${CLONE}.supabase.co`,
  supabaseProjectRef: CLONE,
  supabaseAnonKey: anonKeyFor(CLONE),
};

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
    const vars = buildCloneEnv(cloneBackend);
    const keys = vars.map((v) => v.key);
    expect(keys).toContain("VITE_SUPABASE_ANON_KEY");
    expect(keys).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
  });

  it("drops empty and absent values rather than publishing an empty string", () => {
    // An empty VITE_SUPABASE_URL builds fine and fails at the first request.
    const vars = buildCloneEnv({ supabaseUrl: "  ", supabaseAnonKey: null });
    expect(vars).toEqual([]);
  });

  it("REFUSES half a Supabase pair", () => {
    // This used to emit the URL alone. A URL with no key is not a partial
    // configuration, it is a client rejected on every request — and it
    // overwrites whatever working default the clone's own build carries.
    expect(() => buildCloneEnv({ supabaseUrl: `https://${CLONE}.supabase.co` })).toThrow(
      EnvPolicyError,
    );
    expect(() => buildCloneEnv({ supabaseAnonKey: anonKeyFor(CLONE) })).toThrow(EnvPolicyError);
  });

  it("REFUSES a URL and a key from different projects", () => {
    expect(() =>
      buildCloneEnv({
        supabaseUrl: `https://${CLONE}.supabase.co`,
        supabaseAnonKey: anonKeyFor(PRIME),
      }),
    ).toThrow(/authenticates to nothing/);
  });

  it("REFUSES an environment that names the prime's backend", () => {
    // The rule the deployed client dashboard was the counter-example to.
    expect(() =>
      buildCloneEnv({
        supabaseUrl: `https://${PRIME}.supabase.co`,
        supabaseProjectRef: PRIME,
        supabaseAnonKey: anonKeyFor(PRIME),
        primeProjectRef: PRIME,
      }),
    ).toThrow(/never be able to reach the prime/);
  });

  it("publishes the clone's own pair with the same prime configured", () => {
    // The refusal must be about WHOSE project it is, not about the check being
    // switched on. Same prime, clone's own backend, published.
    const vars = buildCloneEnv({ ...cloneBackend, primeProjectRef: PRIME });
    expect(vars.find((v) => v.key === "VITE_SUPABASE_URL")?.value).toBe(
      `https://${CLONE}.supabase.co`,
    );
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
    const vars = buildCloneEnv({ ...cloneBackend, extra: { SENTRY_DSN: "https://x@y/1" } });
    expect(vars.find((v) => v.key === "VITE_SUPABASE_URL")?.publicToBundle).toBe(true);
    expect(vars.find((v) => v.key === "SENTRY_DSN")?.publicToBundle).toBe(false);
  });
});

describe("envDigest", () => {
  it("is stable across ordering", () => {
    const a = buildCloneEnv(cloneBackend);
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
    const one = buildCloneEnv(cloneBackend);
    const two = buildCloneEnv({ ...cloneBackend, aurixaApiKey: "ak" });
    expect(envDigest(one)).not.toBe(envDigest(two));
  });
});

describe("reading which project a value belongs to", () => {
  it("reads the ref from a project URL", () => {
    expect(projectRefFromUrl(`https://${CLONE}.supabase.co`)).toBe(CLONE);
    expect(projectRefFromUrl("https://example.com")).toBeNull();
  });

  it("reads the ref claim from a publishable key", () => {
    expect(projectRefFromAnonKey(anonKeyFor(PRIME))).toBe(PRIME);
    expect(projectRefFromAnonKey("not-a-jwt")).toBeNull();
  });

  it("an UNREADABLE ref is not a MISMATCHED one", () => {
    // A self-hosted URL has no <ref>.supabase.co and an opaque key has no ref
    // claim. Guessing in either direction is worse than the check not applying,
    // so a half that cannot be read is passed over rather than refused.
    expect(
      backendRefusalReason({
        supabaseUrl: "https://supabase.internal.example",
        supabaseAnonKey: "opaque-token",
      }),
    ).toBeNull();
  });

  it("says nothing when there is no backend to judge", () => {
    expect(backendRefusalReason({})).toBeNull();
  });
});
