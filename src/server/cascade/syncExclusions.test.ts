import { describe, expect, it } from "vitest";
import {
  assertMirrorPolicy,
  DEFAULT_MIRROR_EXCLUSIONS,
  MissingExclusionPolicyError,
  partitionCascadePaths,
  reportableHeld,
  requireExclusions,
  type SyncExclusion,
} from "./syncExclusions.pure";

const BACKEND_IDENTITY = "src/integrations/supabase/env.ts";

describe("the guarantee", () => {
  it("never writes the file that decides which backend a clone talks to", () => {
    const { write, held } = partitionCascadePaths(
      [BACKEND_IDENTITY, "src/pages/Index.tsx"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    expect(write).toEqual(["src/pages/Index.tsx"]);
    expect(held.map((h) => h.path)).toContain(BACKEND_IDENTITY);
  });

  it("keeps that file in the default set — the set cannot be trimmed to nothing", () => {
    // The regression this guards is a quiet one: an operator tidying the
    // exclusion list, or a future refactor rebuilding the defaults, drops the
    // one entry whose absence points a customer's dashboard at another
    // tenant's database. Nothing downstream of the commit can tell that apart
    // from a correct sync.
    const patterns = DEFAULT_MIRROR_EXCLUSIONS.map((e) => e.pattern);
    expect(patterns).toContain(BACKEND_IDENTITY);
    expect(patterns).toContain("supabase/config.toml");
    expect(patterns).toContain("supabase/.temp/**");
    for (const e of DEFAULT_MIRROR_EXCLUSIONS) {
      expect(e.pattern.trim()).not.toBe("");
    }
  });
});

describe("fail closed", () => {
  it("throws when the policy read errored", () => {
    expect(() => requireExclusions("c1", null, { message: "connection reset" })).toThrow(
      MissingExclusionPolicyError,
    );
  });

  it("throws when nothing came back at all", () => {
    expect(() => requireExclusions("c1", null)).toThrow(MissingExclusionPolicyError);
    expect(() => requireExclusions("c1", undefined)).toThrow(MissingExclusionPolicyError);
  });

  it("accepts an empty set that was actually read", () => {
    // A module-scoped clone legitimately has no exclusions. The distinction is
    // between "read, and empty" and "not read".
    expect(requireExclusions("c1", [])).toEqual([]);
  });

  it("reports the error it was given, so the failure is diagnosable", () => {
    expect(() => requireExclusions("c1", null, { message: "connection reset" })).toThrow(
      /connection reset/,
    );
  });
});

describe("partitioning", () => {
  const rules: SyncExclusion[] = [
    { pattern: "src/App.tsx", reason: "manual_reconcile", note: "superset" },
    { pattern: "src/**", reason: "protected", note: "everything under src" },
  ];

  it("attributes a doubly-matched path to protected, the stronger reason", () => {
    const { held } = partitionCascadePaths(["src/App.tsx"], rules);
    expect(held).toHaveLength(1);
    expect(held[0].reason).toBe("protected");
  });

  it("reports manual_reconcile paths and stays quiet about protected ones", () => {
    const { held } = partitionCascadePaths(
      [BACKEND_IDENTITY, "src/App.tsx"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    const reportable = reportableHeld(held).map((h) => h.path);
    expect(reportable).toEqual(["src/App.tsx"]);
    expect(reportable).not.toContain(BACKEND_IDENTITY);
  });

  it("carries the note through, so a pull request can say why", () => {
    const { held } = partitionCascadePaths(["src/App.tsx"], DEFAULT_MIRROR_EXCLUSIONS);
    expect(held[0].note).toMatch(/RouteExcludedFromBuild/);
  });

  it("withholds a path that is not a safe repo path regardless of the rules", () => {
    const { write, held } = partitionCascadePaths(["../../etc/passwd", "ok.ts"], []);
    expect(write).toEqual(["ok.ts"]);
    expect(held[0].reason).toBe("protected");
  });

  it("writes everything when a clone has no exclusions", () => {
    const { write, held } = partitionCascadePaths(["a.ts", "b/c.ts"], []);
    expect(write).toEqual(["a.ts", "b/c.ts"]);
    expect(held).toEqual([]);
  });
});

describe("glob semantics match the file selector", () => {
  it("** crosses directory separators", () => {
    const { write } = partitionCascadePaths(
      ["supabase/.temp/linked-project.json", "supabase/config.toml", "supabase/functions/x/i.ts"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    expect(write).toEqual(["supabase/functions/x/i.ts"]);
  });

  it("* does not cross them", () => {
    const rules: SyncExclusion[] = [{ pattern: "docs/*.md", reason: "protected" }];
    const { write } = partitionCascadePaths(["docs/a.md", "docs/nested/b.md"], rules);
    expect(write).toEqual(["docs/nested/b.md"]);
  });

  it("anchors — a pattern matches the whole path, not a fragment of it", () => {
    const rules: SyncExclusion[] = [{ pattern: "vercel.json", reason: "protected" }];
    const { write } = partitionCascadePaths(["packages/x/vercel.json", "vercel.json"], rules);
    expect(write).toEqual(["packages/x/vercel.json"]);
  });
});

describe("a mirror must have a policy", () => {
  it("refuses to cascade a whole tree with no exclusions", () => {
    expect(() => assertMirrorPolicy("c1", [])).toThrow(MissingExclusionPolicyError);
    expect(() => assertMirrorPolicy("c1", [])).toThrow(/would overwrite this clone's backend identity/);
  });

  it("accepts one that has been seeded", () => {
    expect(() => assertMirrorPolicy("c1", DEFAULT_MIRROR_EXCLUSIONS)).not.toThrow();
  });

  it("does not constrain module-scoped clones — the engine only asks for mirrors", () => {
    // An empty set stays valid on the read path; it is the mirror-specific
    // assertion that rejects it.
    expect(requireExclusions("c1", [])).toEqual([]);
  });
});
