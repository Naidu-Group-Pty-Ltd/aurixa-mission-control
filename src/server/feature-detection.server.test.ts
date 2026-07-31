import { describe, it, expect } from "vitest";
import {
  toKebab,
  buildDomainVocabulary,
  canonicalDomain,
  routeDomainOf,
  compactToGlobs,
  buildFeatureModules,
  PLATFORM_CORE_SLUG,
} from "./feature-detection.server";

describe("toKebab", () => {
  it("normalises the spellings the prime actually uses", () => {
    expect(toKebab("FinancePortalAdmin.tsx")).toBe("finance-portal-admin");
    expect(toKebab("templateBuilder")).toBe("template-builder");
    expect(toKebab("PDFImport")).toBe("pdf-import");
    expect(toKebab("cash-flow")).toBe("cash-flow");
    expect(toKebab("call_logs")).toBe("call-logs");
  });
});

describe("buildDomainVocabulary", () => {
  const files = [
    "src/components/aml/CaseList.tsx",
    "src/components/finance-portal/Panel.tsx",
    "src/components/ui/button.tsx",
    "src/components/shared/Address.tsx",
    "src/lib/aml/api.ts",
    "src/pages/admin/UserManagement.tsx",
    "src/pages/portal/Home.tsx",
  ];

  it("harvests domains from directory names", () => {
    const v = buildDomainVocabulary({ files });
    expect(v.terms).toContain("aml");
    expect(v.terms).toContain("finance-portal");
    expect(v.terms).toContain("portal");
  });

  it("excludes infrastructure and routing-bucket directories", () => {
    const v = buildDomainVocabulary({ files });
    expect(v.terms).not.toContain("ui");
    expect(v.terms).not.toContain("shared");
    expect(v.terms).not.toContain("admin");
  });

  it("harvests compound domains from edge-function slug prefixes", () => {
    const v = buildDomainVocabulary({
      files: [],
      edgeFunctionSlugs: [
        "client-portal-login",
        "client-portal-invite",
        "client-portal-verify",
        "solo-function",
      ],
    });
    expect(v.terms).toContain("client-portal");
    // A single function must not mint a domain.
    expect(v.terms).not.toContain("solo");
  });

  it("never turns a whole slug into a domain", () => {
    const v = buildDomainVocabulary({
      files: [],
      edgeFunctionSlugs: ["aml-cases", "aml-risk", "aml-tenant"],
      minPrefixCount: 3,
    });
    expect(v.terms).toContain("aml");
    expect(v.terms).not.toContain("aml-cases");
  });

  it("matches longest term first so compounds beat their prefixes", () => {
    const v = buildDomainVocabulary({
      files: ["src/components/portal/A.tsx", "src/components/finance-portal/B.tsx"],
    });
    expect(v.match("finance-portal-admin")).toBe("finance-portal");
    expect(v.match("portal-home")).toBe("portal");
    expect(v.match("totally-unrelated")).toBeNull();
  });
});

describe("canonicalDomain", () => {
  it("collapses x onto x-portal when both spellings exist", () => {
    const known = new Set(["solicitor", "solicitor-portal"]);
    expect(canonicalDomain("solicitor", known)).toBe("solicitor-portal");
    expect(canonicalDomain("solicitor-portal", known)).toBe("solicitor-portal");
  });

  it("leaves a domain alone when there is no portal variant", () => {
    expect(canonicalDomain("aml", new Set(["aml"]))).toBe("aml");
  });
});

describe("routeDomainOf", () => {
  const vocab = buildDomainVocabulary({
    files: [
      "src/components/aml/A.tsx",
      "src/components/finance-portal/B.tsx",
      "src/lib/pdf-import/C.ts",
    ],
  });

  it("prefers the page name over a routing-bucket directory", () => {
    // The prime files finance-portal work under src/pages/admin/. The directory
    // is a route bucket, not a feature — the name is what identifies it.
    expect(routeDomainOf("src/pages/admin/FinancePortalAdmin.tsx", vocab)).toBe("finance-portal");
    expect(routeDomainOf("src/pages/admin/AmlV3Cutover.tsx", vocab)).toBe("aml");
    expect(routeDomainOf("src/pages/admin/PdfImportDiagnostics.tsx", vocab)).toBe("pdf-import");
  });

  it("uses a genuine feature directory when the name says nothing", () => {
    expect(routeDomainOf("src/pages/aml/Dashboard.tsx", vocab)).toBe("aml");
  });

  it("gives an unrecognised page its own module", () => {
    expect(routeDomainOf("src/pages/CallLogs.tsx", vocab)).toBe("call-logs");
  });
});

describe("compactToGlobs", () => {
  const allFiles = [
    "src/components/aml/A.tsx",
    "src/components/aml/B.tsx",
    "src/components/aml/nested/C.tsx",
    "src/components/other/D.tsx",
    "src/pages/Loose.tsx",
  ];

  it("collapses a fully-owned directory to dir/**", () => {
    const globs = compactToGlobs(
      ["src/components/aml/A.tsx", "src/components/aml/B.tsx", "src/components/aml/nested/C.tsx"],
      allFiles,
    );
    expect(globs).toEqual(["src/components/aml/**"]);
  });

  it("does not collapse a directory it only partly owns", () => {
    const globs = compactToGlobs(["src/components/aml/A.tsx"], allFiles);
    expect(globs).toEqual(["src/components/aml/A.tsx"]);
  });

  it("keeps unmatched leftovers as literal paths", () => {
    const globs = compactToGlobs(
      [
        "src/components/aml/A.tsx",
        "src/components/aml/B.tsx",
        "src/components/aml/nested/C.tsx",
        "src/pages/Loose.tsx",
      ],
      allFiles,
    );
    expect(globs).toContain("src/components/aml/**");
    expect(globs).toContain("src/pages/Loose.tsx");
    expect(globs).toHaveLength(2);
  });

  it("emits nothing for an empty ownership set", () => {
    expect(compactToGlobs([], allFiles)).toEqual([]);
  });

  it("collapses to the shallowest fully-owned directory, never a parent plus its child", () => {
    const repo = ["src/a/1.ts", "src/a/2.ts", "src/a/b/3.ts", "src/a/b/4.ts", "src/z/9.ts"];
    // Owning all of src/a (including src/a/b) yields one glob, not two.
    const globs = compactToGlobs(
      ["src/a/1.ts", "src/a/2.ts", "src/a/b/3.ts", "src/a/b/4.ts"],
      repo,
    );
    expect(globs).toEqual(["src/a/**"]);
  });

  it("collapses only the child when the parent is partly owned by someone else", () => {
    const repo = ["src/a/1.ts", "src/a/b/3.ts", "src/a/b/4.ts"];
    // src/a/1.ts belongs to another module, so src/a/** would over-claim.
    const globs = compactToGlobs(["src/a/b/3.ts", "src/a/b/4.ts"], repo);
    expect(globs).toEqual(["src/a/b/**"]);
  });
});

// ─── Partition over a miniature repo ─────────────────────────────────

const FILES = [
  "src/pages/aml/Dashboard.tsx",
  "src/pages/admin/AmlV3Cutover.tsx",
  "src/pages/Reports.tsx",
  "src/components/aml/CaseList.tsx",
  "src/components/aml/CaseDetail.tsx",
  "src/components/reports/Table.tsx",
  "src/components/ui/button.tsx",
  "src/lib/aml/api.ts",
  "src/lib/format.ts",
];

const IMPORTS: Record<string, string[]> = {
  "src/pages/aml/Dashboard.tsx": [
    "src/components/aml/CaseList.tsx",
    "src/components/ui/button.tsx",
    "src/lib/format.ts",
  ],
  "src/pages/admin/AmlV3Cutover.tsx": ["src/components/aml/CaseDetail.tsx", "src/lib/aml/api.ts"],
  "src/pages/Reports.tsx": [
    "src/components/reports/Table.tsx",
    "src/components/ui/button.tsx",
    "src/lib/format.ts",
  ],
  "src/components/aml/CaseList.tsx": ["src/lib/aml/api.ts"],
};

const result = buildFeatureModules({
  files: FILES,
  routeFiles: [
    "src/pages/aml/Dashboard.tsx",
    "src/pages/admin/AmlV3Cutover.tsx",
    "src/pages/Reports.tsx",
  ],
  edgeFunctionSlugs: ["aml-cases", "aml-risk", "aml-tenant"],
  importsOf: (f) => IMPORTS[f] ?? [],
});

describe("buildFeatureModules", () => {
  const bySlug = new Map(result.modules.map((m) => [m.slug, m]));

  it("groups routes into domains, not one module per page", () => {
    // Two aml routes in different directories collapse into one module.
    expect(bySlug.has("aml")).toBe(true);
    expect(bySlug.get("aml")!.routes).toEqual([
      "src/pages/admin/AmlV3Cutover.tsx",
      "src/pages/aml/Dashboard.tsx",
    ]);
  });

  it("produces a disjoint cover — every file owned exactly once", () => {
    expect(result.stats.overlapFactor).toBe(1);
    const seen = new Map<string, string>();
    for (const m of result.modules) {
      for (const f of m.resolvedFiles) {
        expect(seen.has(f)).toBe(false);
        seen.set(f, m.slug);
      }
    }
  });

  it("assigns a domain's own directories to it", () => {
    const aml = bySlug.get("aml")!;
    expect(aml.resolvedFiles).toContain("src/components/aml/CaseList.tsx");
    expect(aml.resolvedFiles).toContain("src/components/aml/CaseDetail.tsx");
    expect(aml.resolvedFiles).toContain("src/lib/aml/api.ts");
  });

  it("routes files shared by two domains into platform-core", () => {
    const core = bySlug.get(PLATFORM_CORE_SLUG)!;
    expect(core.resolvedFiles).toContain("src/lib/format.ts");
  });

  it("keeps the design system in platform-core even when one domain uses it", () => {
    const core = bySlug.get(PLATFORM_CORE_SLUG)!;
    expect(core.resolvedFiles).toContain("src/components/ui/button.tsx");
  });

  it("compacts a fully-owned directory into a single glob", () => {
    expect(bySlug.get("aml")!.fileGlobs).toContain("src/components/aml/**");
  });

  it("renders acronym domains in caps", () => {
    expect(bySlug.get("aml")!.name).toBe("AML");
  });

  it("marks platform-core as the shared layer and features as frontend", () => {
    expect(bySlug.get(PLATFORM_CORE_SLUG)!.layer).toBe("shared");
    expect(bySlug.get("aml")!.layer).toBe("frontend");
  });

  it("reports partition statistics", () => {
    expect(result.stats.domains).toBeGreaterThan(0);
    expect(result.stats.filesPartitioned).toBeGreaterThan(0);
    expect(result.stats.platformCoreFiles).toBeGreaterThan(0);
    expect(result.stats.globCount).toBeLessThanOrEqual(result.stats.pathCount);
  });

  it("handles a repo with no routes without throwing", () => {
    const empty = buildFeatureModules({ files: FILES, routeFiles: [], importsOf: () => [] });
    expect(empty.modules).toEqual([]);
    expect(empty.stats.filesPartitioned).toBe(0);
  });
});
