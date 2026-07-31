import { describe, it, expect } from "vitest";
import {
  classifyBackendPath,
  stripSqlNoise,
  parseMigrationObjects,
  parseEdgeFunctionRefs,
  parseFrontendBackendRefs,
  matchIndirectEdgeInvocations,
  parseEnvTemplateNames,
  buildBackendInventory,
  linkBackendToModules,
  synthesizeBackendModules,
  computeMigrationSharing,
  unqualifyPublic,
} from "./backend-detection.server";

describe("classifyBackendPath", () => {
  it("identifies edge functions by their slug directory", () => {
    expect(classifyBackendPath("supabase/functions/aml-cases/index.ts")).toEqual({
      kind: "edge_function",
      identifier: "aml-cases",
      path: "supabase/functions/aml-cases/index.ts",
    });
    expect(classifyBackendPath("supabase/functions/aml-cases/lib/hash.ts")?.identifier).toBe(
      "aml-cases",
    );
  });

  it("separates the shared edge library from functions", () => {
    const info = classifyBackendPath("supabase/functions/_shared/auth.ts");
    expect(info?.kind).toBe("edge_shared");
    expect(info?.identifier).toBe("_shared/auth.ts");
  });

  it("treats root import maps as shared", () => {
    expect(classifyBackendPath("supabase/functions/import_map.json")?.kind).toBe("edge_shared");
    expect(classifyBackendPath("supabase/functions/deno.json")?.kind).toBe("edge_shared");
  });

  it("identifies migrations, config and seeds", () => {
    expect(classifyBackendPath("supabase/migrations/20260419215311_init.sql")).toEqual({
      kind: "migration",
      identifier: "20260419215311_init.sql",
      path: "supabase/migrations/20260419215311_init.sql",
    });
    expect(classifyBackendPath("supabase/config.toml")?.kind).toBe("supabase_config");
    expect(classifyBackendPath("supabase/seed.sql")?.kind).toBe("seed");
  });

  it("accepts env templates but never a real .env", () => {
    expect(classifyBackendPath(".env.example")?.kind).toBe("env_template");
    expect(classifyBackendPath(".env.template")?.kind).toBe("env_template");
    expect(classifyBackendPath(".env")).toBeNull();
    expect(classifyBackendPath(".env.local")).toBeNull();
  });

  it("identifies workflows, sidecars and infra config", () => {
    expect(classifyBackendPath(".github/workflows/nightly.yml")?.kind).toBe("workflow");
    expect(classifyBackendPath("pdf-parse-service/Dockerfile")).toEqual({
      kind: "sidecar_service",
      identifier: "pdf-parse-service",
      path: "pdf-parse-service/Dockerfile",
    });
    expect(classifyBackendPath("weasyprint-service/requirements.txt")?.identifier).toBe(
      "weasyprint-service",
    );
    expect(classifyBackendPath("wrangler.jsonc")?.kind).toBe("infra_config");
  });

  it("returns null for frontend source the route detector already owns", () => {
    expect(classifyBackendPath("src/routes/dashboard.tsx")).toBeNull();
    expect(classifyBackendPath("src/components/ui/button.tsx")).toBeNull();
    expect(classifyBackendPath("")).toBeNull();
  });
});

describe("stripSqlNoise", () => {
  it("blanks line and block comments", () => {
    const out = stripSqlNoise(
      "-- Create table for storing charts\nCREATE TABLE real_one (id int);",
    );
    expect(out).not.toMatch(/storing/);
    expect(out).toMatch(/CREATE TABLE real_one/);
  });

  it("blanks dollar-quoted function bodies", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ CREATE TABLE decoy (id int); $$ LANGUAGE plpgsql;`;
    const out = stripSqlNoise(sql);
    expect(out).toMatch(/CREATE FUNCTION f/);
    expect(out).not.toMatch(/decoy/);
  });

  it("preserves offsets so nothing shifts", () => {
    const sql = "-- hi\nSELECT 1;";
    expect(stripSqlNoise(sql)).toHaveLength(sql.length);
  });
});

describe("parseMigrationObjects", () => {
  it("extracts tables across the casing/IF NOT EXISTS variants the prime uses", () => {
    const objects = parseMigrationObjects(`
      CREATE TABLE public.modules (id uuid);
      CREATE TABLE IF NOT EXISTS aml.cases (id uuid);
      create table if not exists lower_case_tbl (id uuid);
    `);
    const tables = objects.filter((o) => o.kind === "table").map((o) => o.name);
    expect(tables).toContain("modules");
    expect(tables).toContain("aml.cases");
    expect(tables).toContain("lower_case_tbl");
  });

  it("does not invent tables from prose in comments", () => {
    const objects = parseMigrationObjects(`
      -- Create table for storing portfolio analysis
      -- Create tables for dynamic QuickChart config
      CREATE TABLE genuine (id int);
    `);
    expect(objects.filter((o) => o.kind === "table").map((o) => o.name)).toEqual(["genuine"]);
  });

  it("records ALTER TABLE so column additions still map to a module", () => {
    const objects = parseMigrationObjects(`ALTER TABLE public.modules ADD COLUMN x text;`);
    expect(objects).toContainEqual({ kind: "table", name: "modules" });
  });

  it("attaches policies, triggers and indexes to their table", () => {
    const objects = parseMigrationObjects(`
      CREATE POLICY "Operators can read modules" ON public.modules FOR SELECT USING (true);
      CREATE TRIGGER update_modules_updated_at BEFORE UPDATE ON public.modules
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
      CREATE INDEX idx_modules_layer ON public.modules(layer);
    `);
    expect(objects).toContainEqual({
      kind: "policy",
      name: "Operators can read modules",
      table: "modules",
    });
    expect(objects.find((o) => o.kind === "trigger")?.table).toBe("modules");
    expect(objects.find((o) => o.kind === "index")?.table).toBe("modules");
  });

  it("extracts functions, types, extensions and schemas", () => {
    const objects = parseMigrationObjects(`
      CREATE SCHEMA IF NOT EXISTS aml;
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE TYPE public.module_status AS ENUM ('proposed');
      CREATE OR REPLACE FUNCTION public.is_operator(uid uuid) RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql;
    `);
    expect(objects).toContainEqual({ kind: "schema", name: "aml" });
    expect(objects).toContainEqual({ kind: "extension", name: "pg_cron" });
    expect(objects).toContainEqual({ kind: "type", name: "module_status" });
    expect(objects).toContainEqual({ kind: "function", name: "is_operator" });
  });

  it("extracts cron jobs and storage buckets from string literals", () => {
    const objects = parseMigrationObjects(`
      SELECT cron.schedule('cleanup-stale-calls-hourly', '0 * * * *', $$ SELECT 1 $$);
      INSERT INTO storage.buckets (id, name, public) VALUES ('client-documents', 'client-documents', false);
    `);
    expect(objects).toContainEqual({ kind: "cron_job", name: "cleanup-stale-calls-hourly" });
    expect(objects).toContainEqual({ kind: "storage_bucket", name: "client-documents" });
  });

  it("records realtime publication additions", () => {
    const objects = parseMigrationObjects(
      `ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;`,
    );
    expect(objects).toContainEqual({
      kind: "realtime",
      name: "notifications",
      table: "notifications",
    });
  });

  it("is empty for non-SQL input", () => {
    expect(parseMigrationObjects("")).toEqual([]);
    expect(parseMigrationObjects("just prose, no ddl")).toEqual([]);
  });
});

describe("unqualifyPublic", () => {
  it("drops only the implicit public schema", () => {
    expect(unqualifyPublic("public.modules")).toBe("modules");
    expect(unqualifyPublic("aml.cases")).toBe("aml.cases");
  });
});

describe("parseEdgeFunctionRefs", () => {
  const source = `
    import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";
    import { verifyAuth } from "../_shared/auth.ts";
    import { enforceCsrf } from "../_shared/csrfGuard.ts";

    const key = Deno.env.get("RESEND_API_KEY");
    const url = Deno.env.get("SUPABASE_URL");
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    await client.schema("aml").from("cases").select("*");
    await client.from("profiles").select("id");
    await client.rpc("is_operator", { uid });
    await client.storage.from("client-documents").upload(path, blob);
    await client.functions.invoke("aml-risk", { body: {} });
    await fetch("https://api.resend.com/emails");
  `;

  it("extracts operator-supplied secrets and drops platform-injected ones", () => {
    const refs = parseEdgeFunctionRefs(source);
    expect(refs.secrets).toEqual(["RESEND_API_KEY"]);
  });

  it("keeps schema-qualified tables distinct from public ones", () => {
    const refs = parseEdgeFunctionRefs(source);
    expect(refs.tables).toContain("aml.cases");
    expect(refs.tables).toContain("profiles");
    // The bucket must not leak into the table list.
    expect(refs.tables).not.toContain("client-documents");
  });

  it("separates storage buckets, rpcs, shared imports and invokes", () => {
    const refs = parseEdgeFunctionRefs(source);
    expect(refs.buckets).toEqual(["client-documents"]);
    expect(refs.rpcs).toEqual(["is_operator"]);
    expect(refs.sharedImports).toEqual(["_shared/auth.ts", "_shared/csrfGuard.ts"]);
    expect(refs.invokes).toEqual(["aml-risk"]);
  });

  it("records third-party hosts but not the supabase project host", () => {
    const refs = parseEdgeFunctionRefs(`
      await fetch("https://api.openai.com/v1/chat");
      await fetch("https://abc.supabase.co/rest/v1/x");
    `);
    expect(refs.externalHosts).toEqual(["api.openai.com"]);
  });

  it("handles empty input", () => {
    expect(parseEdgeFunctionRefs("").secrets).toEqual([]);
  });
});

describe("parseFrontendBackendRefs", () => {
  it("finds both invoke() and direct /functions/v1/ URLs", () => {
    const refs = parseFrontendBackendRefs(`
      const { data } = await supabase.functions.invoke('market-qa-share', { body });
      const res = await fetch(\`\${SUPABASE_URL}/functions/v1/google-places-autocomplete\`, {});
    `);
    expect(refs.edgeFunctions).toEqual(["google-places-autocomplete", "market-qa-share"]);
  });

  it("captures tables, rpcs, buckets and build-time env vars", () => {
    const refs = parseFrontendBackendRefs(`
      const { data } = await supabase.from('clients').select('*');
      await supabase.rpc('calculate_score', {});
      await supabase.storage.from('report-pdfs').download(p);
      const url = import.meta.env.VITE_SUPABASE_URL;
    `);
    expect(refs.tables).toEqual(["clients"]);
    expect(refs.rpcs).toEqual(["calculate_score"]);
    expect(refs.buckets).toEqual(["report-pdfs"]);
    expect(refs.envVars).toEqual(["VITE_SUPABASE_URL"]);
  });

  it("ignores vite's own build-mode flags", () => {
    const refs = parseFrontendBackendRefs(`if (import.meta.env.DEV) log();`);
    expect(refs.envVars).toEqual([]);
  });

  it("recovers helper-indirected calls via the known-slug set", () => {
    // The prime routes most calls through wrappers like
    // `invokePortalEdge(name)`, so the slug only ever appears as a literal.
    const source = `await invokePortalEdge('client-portal-login', { email });`;
    const known = new Set(["client-portal-login", "aml-cases"]);
    const refs = parseFrontendBackendRefs(source, known);
    expect(refs.edgeFunctions).toEqual([]);
    expect(refs.indirectEdgeFunctions).toEqual(["client-portal-login"]);
  });

  it("does not double-count a slug already matched directly", () => {
    const known = new Set(["aml-cases"]);
    const refs = parseFrontendBackendRefs(`supabase.functions.invoke('aml-cases', {})`, known);
    expect(refs.edgeFunctions).toEqual(["aml-cases"]);
    expect(refs.indirectEdgeFunctions).toEqual([]);
  });
});

describe("matchIndirectEdgeInvocations", () => {
  const known = new Set(["client-portal-login", "aml-cases", "sync"]);

  it("matches only literals that are real slugs", () => {
    expect(matchIndirectEdgeInvocations(`const k = 'client-portal-reports';`, known)).toEqual([]);
    expect(matchIndirectEdgeInvocations(`const k = 'aml-cases';`, known)).toEqual(["aml-cases"]);
  });

  it("ignores short non-distinctive slugs to avoid coincidental matches", () => {
    // "sync" is a common word — a query key or CSS class could equal it.
    expect(matchIndirectEdgeInvocations(`queryKey: ['sync']`, known)).toEqual([]);
  });

  it("is inert without a slug set", () => {
    expect(matchIndirectEdgeInvocations(`'aml-cases'`, new Set())).toEqual([]);
  });
});

describe("parseEnvTemplateNames", () => {
  it("reads names and never values", () => {
    const names = parseEnvTemplateNames(
      [
        "# comment",
        "RESEND_API_KEY=re_live_abc123",
        "export OPENAI_API_KEY=sk-xyz",
        "",
        "BAD LINE",
      ].join("\n"),
    );
    expect(names).toEqual(["OPENAI_API_KEY", "RESEND_API_KEY"]);
    expect(names.join()).not.toMatch(/re_live|sk-xyz/);
  });
});

// ─── Integration over a miniature repo ───────────────────────────────

const FILES = [
  "src/routes/aml.tsx",
  "src/routes/reports.tsx",
  "supabase/functions/aml-cases/index.ts",
  "supabase/functions/aml-risk/index.ts",
  "supabase/functions/nightly-sweep/index.ts",
  "supabase/functions/_shared/auth.ts",
  "supabase/migrations/20260101000000_aml.sql",
  "supabase/migrations/20260102000000_reports.sql",
  ".env.example",
];

const CONTENTS = new Map<string, string>([
  [
    "supabase/functions/aml-cases/index.ts",
    `import { verifyAuth } from "../_shared/auth.ts";
     const k = Deno.env.get("AML_PROVIDER_KEY");
     await c.schema("aml").from("cases").select();
     await c.functions.invoke("aml-risk", {});`,
  ],
  [
    "supabase/functions/aml-risk/index.ts",
    `const k = Deno.env.get("RISK_ENGINE_URL");
     await c.schema("aml").from("risk_scores").select();`,
  ],
  [
    "supabase/functions/nightly-sweep/index.ts",
    `const k = Deno.env.get("CRON_SECRET");
     await c.from("sweep_log").insert({});`,
  ],
  [
    "supabase/functions/_shared/auth.ts",
    `const j = Deno.env.get("JWT_AUDIENCE");
     await c.from("profiles").select();`,
  ],
  [
    "supabase/migrations/20260101000000_aml.sql",
    `CREATE SCHEMA aml;
     CREATE TABLE aml.cases (id uuid);
     CREATE TABLE aml.risk_scores (id uuid);
     CREATE TABLE public.profiles (id uuid);
     SELECT cron.schedule('aml-nightly', '0 2 * * *', $$ SELECT 1 $$);`,
  ],
  [
    "supabase/migrations/20260102000000_reports.sql",
    `CREATE TABLE public.reports (id uuid);
     CREATE TABLE public.sweep_log (id uuid);`,
  ],
  [".env.example", "AML_PROVIDER_KEY=changeme\nRISK_ENGINE_URL=changeme"],
]);

describe("buildBackendInventory", () => {
  const inv = buildBackendInventory({
    files: FILES,
    contents: CONTENTS,
    functionConfig: new Map([["aml-cases", { verifyJwt: false }]]),
  });

  it("groups every function and indexes every migration", () => {
    expect([...inv.edgeFunctions.keys()].sort()).toEqual([
      "aml-cases",
      "aml-risk",
      "nightly-sweep",
    ]);
    expect(inv.migrations).toHaveLength(2);
  });

  it("carries verify_jwt through from config.toml", () => {
    expect(inv.edgeFunctions.get("aml-cases")!.verifyJwt).toBe(false);
    expect(inv.edgeFunctions.get("aml-risk")!.verifyJwt).toBe(true);
  });

  it("resolves the _shared closure into the function's requirements", () => {
    const fn = inv.edgeFunctions.get("aml-cases")!;
    expect(fn.resolvedSecrets).toContain("AML_PROVIDER_KEY");
    // Inherited from _shared/auth.ts
    expect(fn.resolvedSecrets).toContain("JWT_AUDIENCE");
    expect(fn.resolvedTables).toContain("profiles");
  });

  it("folds an invoked sibling's requirements into the caller", () => {
    const fn = inv.edgeFunctions.get("aml-cases")!;
    expect(fn.resolvedTables).toContain("aml.risk_scores");
    expect(fn.resolvedSecrets).toContain("RISK_ENGINE_URL");
  });

  it("builds a reverse index from table to declaring migration", () => {
    expect(inv.tableToMigrations.get("aml.cases")).toEqual([
      "supabase/migrations/20260101000000_aml.sql",
    ]);
    expect(inv.tableToMigrations.get("sweep_log")).toEqual([
      "supabase/migrations/20260102000000_reports.sql",
    ]);
  });

  it("collects cron jobs and env template names", () => {
    expect(inv.cronJobs.map((c) => c.name)).toEqual(["aml-nightly"]);
    expect(inv.envTemplateNames).toEqual(["AML_PROVIDER_KEY", "RISK_ENGINE_URL"]);
  });
});

describe("linkBackendToModules", () => {
  const inv = buildBackendInventory({ files: FILES, contents: CONTENTS });
  const knownSlugs = new Set(inv.edgeFunctions.keys());

  const frontendRefs = new Map([
    [
      "src/routes/aml.tsx",
      parseFrontendBackendRefs(
        `await supabase.functions.invoke('aml-cases', {});
         await supabase.from('profiles').select();`,
        knownSlugs,
      ),
    ],
    [
      "src/routes/reports.tsx",
      parseFrontendBackendRefs(`await supabase.from('reports').select();`, knownSlugs),
    ],
  ]);

  const manifests = linkBackendToModules({
    modules: [
      { slug: "aml", resolvedFiles: ["src/routes/aml.tsx"] },
      { slug: "reports", resolvedFiles: ["src/routes/reports.tsx"] },
    ],
    frontendRefs,
    inventory: inv,
  });

  it("pulls the invoked function and everything it fans out to", () => {
    const aml = manifests.get("aml")!;
    expect(aml.edgeFunctions).toEqual(["aml-cases", "aml-risk"]);
    expect(aml.tables).toContain("aml.cases");
    expect(aml.tables).toContain("aml.risk_scores");
    expect(aml.secrets).toContain("AML_PROVIDER_KEY");
    expect(aml.secrets).toContain("JWT_AUDIENCE");
  });

  it("resolves the migrations that declare those tables", () => {
    expect(manifests.get("aml")!.migrations).toContain(
      "supabase/migrations/20260101000000_aml.sql",
    );
  });

  it("emits backend globs so the cascade actually ships the function", () => {
    const aml = manifests.get("aml")!;
    expect(aml.backendGlobs).toContain("supabase/functions/aml-cases/**");
    expect(aml.backendGlobs).toContain("supabase/functions/aml-risk/**");
    expect(aml.backendGlobs).toContain("supabase/functions/_shared/**");
  });

  it("attributes cron jobs from the module's own migrations", () => {
    expect(manifests.get("aml")!.cronJobs).toEqual(["aml-nightly"]);
  });

  it("keeps a module with only table access free of edge functions", () => {
    const reports = manifests.get("reports")!;
    expect(reports.edgeFunctions).toEqual([]);
    expect(reports.tables).toEqual(["reports"]);
    expect(reports.migrations).toEqual(["supabase/migrations/20260102000000_reports.sql"]);
  });

  it("records how each link was made", () => {
    const link = manifests.get("aml")!.links.find((l) => l.identifier === "aml-cases");
    expect(link?.via).toBe("src/routes/aml.tsx");
    const chained = manifests.get("aml")!.links.find((l) => l.identifier === "aml-risk");
    expect(chained?.via).toBe("invoked by aml-cases");
  });
});

describe("synthesizeBackendModules", () => {
  const inv = buildBackendInventory({ files: FILES, contents: CONTENTS });

  it("turns unreachable edge functions into installable modules", () => {
    const synth = synthesizeBackendModules({
      inventory: inv,
      claimedFunctions: new Set(["aml-cases", "aml-risk"]),
    });
    expect(synth).toHaveLength(1);
    expect(synth[0].slug).toBe("backend-nightly");
    expect(synth[0].functions).toEqual(["nightly-sweep"]);
    expect(synth[0].manifest.secrets).toContain("CRON_SECRET");
    expect(synth[0].manifest.backendGlobs).toContain("supabase/functions/nightly-sweep/**");
  });

  it("returns nothing when every function is already claimed", () => {
    expect(
      synthesizeBackendModules({
        inventory: inv,
        claimedFunctions: new Set(["aml-cases", "aml-risk", "nightly-sweep"]),
      }),
    ).toEqual([]);
  });

  it("respects the module cap", () => {
    const synth = synthesizeBackendModules({
      inventory: inv,
      claimedFunctions: new Set(),
      maxModules: 1,
    });
    expect(synth).toHaveLength(1);
  });
});

describe("computeMigrationSharing", () => {
  it("reports every module claiming a migration", () => {
    const sharing = computeMigrationSharing(
      new Map([
        ["a", { ...{ ...emptyManifest() }, migrations: ["m1.sql", "m2.sql"] }],
        ["b", { ...{ ...emptyManifest() }, migrations: ["m1.sql"] }],
      ]),
    );
    expect(sharing.get("m1.sql")).toEqual(["a", "b"]);
    expect(sharing.get("m2.sql")).toEqual(["a"]);
  });
});

function emptyManifest() {
  return {
    edgeFunctions: [],
    tables: [],
    rpcs: [],
    buckets: [],
    cronJobs: [],
    secrets: [],
    migrations: [] as string[],
    backendGlobs: [],
    externalHosts: [],
    links: [],
  };
}
