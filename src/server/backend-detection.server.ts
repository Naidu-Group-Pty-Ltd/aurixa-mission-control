/**
 * Backend architecture detection.
 *
 * The route-first detector in `module-detection.server.ts` only ever saw the
 * frontend: it globbed `src/routes/**`, followed ES import edges, and stopped
 * at the module boundary. Everything a page actually needs to *run* —
 * the edge functions it invokes, the tables those functions read, the
 * migrations that create those tables, the secrets the functions require —
 * was invisible. Modules cascaded to a clone with UI and no backend.
 *
 * This module supplies the missing half:
 *
 *   1. `classifyBackendPath`      — what kind of backend artifact a path is
 *   2. `parseMigrationObjects`    — DDL objects a migration file declares
 *   3. `parseEdgeFunctionRefs`    — what an edge function touches
 *   4. `parseFrontendBackendRefs` — where frontend code crosses into backend
 *   5. `linkBackendToModules`     — joins the two halves into per-module manifests
 *
 * Everything here is pure and synchronous so it can be unit-tested against
 * real prime-repo source without network or database access. The GitHub and
 * Supabase plumbing lives in `module-detection.server.ts`.
 */

// ─── Path classification ─────────────────────────────────────────────

export type BackendArtifactKind =
  | "edge_function"
  | "edge_shared"
  | "migration"
  | "supabase_config"
  | "seed"
  | "env_template"
  | "workflow"
  | "sidecar_service"
  | "infra_config";

export type BackendPathInfo = {
  kind: BackendArtifactKind;
  /** Edge-function slug, migration filename, service directory name, … */
  identifier: string;
  path: string;
};

const EDGE_PREFIX = "supabase/functions/";
const MIGRATIONS_PREFIX = "supabase/migrations/";

/**
 * Directory names that hold a deployable sidecar service rather than app
 * source. These ship their own runtime (Dockerfile / package.json / requirements)
 * and are part of the backend surface a clone needs.
 */
const SIDECAR_MARKERS =
  /(^|\/)(Dockerfile|requirements\.txt|pyproject\.toml|Procfile|fly\.toml|render\.yaml)$/;

/** Root-level config files that describe deploy/runtime topology. */
const INFRA_CONFIG_FILES = new Set([
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
  "vercel.json",
  "netlify.toml",
  "render.yaml",
  "fly.toml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

/**
 * Classify a repo-relative path as a backend artifact, or return null when the
 * path is frontend/app source (or noise) that the route detector already owns.
 */
export function classifyBackendPath(path: string): BackendPathInfo | null {
  if (typeof path !== "string" || path.length === 0) return null;

  // ── Supabase edge functions ──
  if (path.startsWith(EDGE_PREFIX)) {
    const rel = path.slice(EDGE_PREFIX.length);
    const slash = rel.indexOf("/");
    if (slash === -1) {
      // Root-level file sitting beside the function dirs (import_map.json, deno.json)
      if (/^(import_map\.json|deno\.jsonc?)$/.test(rel)) {
        return { kind: "edge_shared", identifier: rel, path };
      }
      return null;
    }
    const top = rel.slice(0, slash);
    if (top === "_shared") {
      return { kind: "edge_shared", identifier: rel, path };
    }
    return { kind: "edge_function", identifier: top, path };
  }

  // ── Database migrations ──
  if (path.startsWith(MIGRATIONS_PREFIX) && path.endsWith(".sql")) {
    return { kind: "migration", identifier: path.slice(MIGRATIONS_PREFIX.length), path };
  }

  // ── Supabase project config / seed ──
  if (path === "supabase/config.toml") {
    return { kind: "supabase_config", identifier: "config.toml", path };
  }
  if (path === "supabase/seed.sql" || /^supabase\/seeds?\/.+\.sql$/.test(path)) {
    return { kind: "seed", identifier: path.split("/").pop() ?? path, path };
  }

  // ── Env templates (secret *names*, never values) ──
  const base = path.split("/").pop() ?? "";
  if (/^\.env\.(example|template|sample)$/.test(base) || base === ".env.example") {
    return { kind: "env_template", identifier: path, path };
  }

  // ── CI / scheduled workflows ──
  if (/^\.github\/workflows\/.+\.(ya?ml)$/.test(path)) {
    return { kind: "workflow", identifier: base, path };
  }

  // ── Sidecar services (own runtime, deployed separately) ──
  if (SIDECAR_MARKERS.test(path) && path.includes("/")) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const top = dir.split("/")[0];
    if (top && top !== "src" && top !== "supabase" && !top.startsWith(".")) {
      return { kind: "sidecar_service", identifier: top, path };
    }
  }

  // ── Root infra config ──
  if (!path.includes("/") && INFRA_CONFIG_FILES.has(path)) {
    return { kind: "infra_config", identifier: path, path };
  }

  return null;
}

// ─── SQL / migration parsing ─────────────────────────────────────────

export type DbObjectKind =
  | "schema"
  | "table"
  | "view"
  | "materialized_view"
  | "policy"
  | "function"
  | "trigger"
  | "type"
  | "index"
  | "extension"
  | "cron_job"
  | "storage_bucket"
  | "realtime"
  | "publication";

export type DbObject = {
  kind: DbObjectKind;
  /** Fully-qualified where the SQL qualified it, e.g. "aml.cases" or "profiles". */
  name: string;
  /** For policies / triggers / indexes: the table they attach to. */
  table?: string;
};

/**
 * Strip SQL comments and string/dollar-quoted literals so DDL regexes can't
 * match inside prose. The prime repo is full of comments like
 * `-- Create table for storing chart data`, which naive matching turns into
 * phantom tables named "for".
 *
 * Replaces removed spans with equal-length whitespace so offsets stay stable.
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const two = sql.slice(i, i + 2);

    // Line comment
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }

    // Block comment (nestable in Postgres)
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === "*/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    // Dollar-quoted body ($$ … $$ or $tag$ … $tag$) — function bodies.
    if (sql[i] === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? n : close + tag.length;
        // Keep the delimiters as whitespace; body is opaque.
        out += " ".repeat(stop - i);
        i = stop;
        continue;
      }
    }

    // Single-quoted literal (Postgres escapes '' inside)
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      // Preserve the literal so cron.schedule / bucket-id extraction can still
      // see it: those run on the raw SQL, not the stripped copy.
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    out += sql[i];
    i++;
  }

  return out;
}

/** Normalise a possibly-quoted, possibly-qualified identifier. */
function normIdent(raw: string): string {
  return raw
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .join(".");
}

/** Drop an implicit `public.` qualifier so table names join consistently. */
export function unqualifyPublic(name: string): string {
  return name.startsWith("public.") ? name.slice("public.".length) : name;
}

const IDENT = `(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = `(?:${IDENT}\\s*\\.\\s*)?${IDENT}`;

/**
 * Extract the database objects a migration declares. Deliberately permissive
 * about whitespace/casing and tolerant of `IF NOT EXISTS`, `OR REPLACE`, and
 * schema qualification — the prime repo uses every variant.
 */
export function parseMigrationObjects(sql: string): DbObject[] {
  if (typeof sql !== "string" || sql.length === 0) return [];
  const clean = stripSqlNoise(sql);
  const objects: DbObject[] = [];
  const seen = new Set<string>();

  const push = (kind: DbObjectKind, rawName: string, table?: string) => {
    const name = unqualifyPublic(normIdent(rawName));
    if (!name) return;
    const key = `${kind}:${name}:${table ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    objects.push(table ? { kind, name, table: unqualifyPublic(normIdent(table)) } : { kind, name });
  };

  const run = (rx: RegExp, fn: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    rx.lastIndex = 0;
    while ((m = rx.exec(clean)) !== null) fn(m);
  };

  // CREATE TABLE [IF NOT EXISTS] name
  run(
    new RegExp(
      `\\bCREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`,
      "gi",
    ),
    (m) => push("table", m[1]),
  );
  // ALTER TABLE name — a module can own a column added to someone else's table.
  run(
    new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})`, "gi"),
    (m) => push("table", m[1]),
  );
  // CREATE [MATERIALIZED] VIEW
  run(
    new RegExp(
      `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?MATERIALIZED\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`,
      "gi",
    ),
    (m) => push("materialized_view", m[1]),
  );
  run(
    new RegExp(
      `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`,
      "gi",
    ),
    (m) => push("view", m[1]),
  );
  // CREATE POLICY "name" ON table
  run(
    new RegExp(`\\bCREATE\\s+POLICY\\s+("(?:[^"]+)"|${IDENT})\\s+ON\\s+(${QUALIFIED})`, "gi"),
    (m) => push("policy", m[1], m[2]),
  );
  // CREATE FUNCTION / PROCEDURE
  run(
    new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+(${QUALIFIED})`, "gi"),
    (m) => push("function", m[1]),
  );
  // CREATE TRIGGER name ... ON table
  run(
    new RegExp(
      `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+(${IDENT})[\\s\\S]{0,200}?\\bON\\s+(${QUALIFIED})`,
      "gi",
    ),
    (m) => push("trigger", m[1], m[2]),
  );
  // CREATE TYPE name
  run(new RegExp(`\\bCREATE\\s+TYPE\\s+(${QUALIFIED})`, "gi"), (m) => push("type", m[1]));
  // CREATE INDEX [name] ON table
  run(
    new RegExp(
      `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(?:ONLY\\s+)?(${QUALIFIED})`,
      "gi",
    ),
    (m) => push("index", m[1], m[2]),
  );
  // CREATE EXTENSION
  run(new RegExp(`\\bCREATE\\s+EXTENSION\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "gi"), (m) =>
    push("extension", m[1]),
  );
  // CREATE SCHEMA
  run(new RegExp(`\\bCREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "gi"), (m) =>
    push("schema", m[1]),
  );

  // ── Literal-bearing statements: run against RAW sql (stripSqlNoise blanks
  //    string literals, and these carry their payload inside quotes). ──

  // cron.schedule('job-name', '*/5 * * * *', $$ … $$)
  runOn(sql, /\bcron\s*\.\s*schedule\s*\(\s*'([^']+)'/gi, (m) => push("cron_job", m[1]));

  // storage.buckets: insert into storage.buckets (id, …) values ('bucket-name', …)
  runOn(sql, /insert\s+into\s+storage\s*\.\s*buckets[\s\S]{0,400}?values\s*\(\s*'([^']+)'/gi, (m) =>
    push("storage_bucket", m[1]),
  );
  // storage.create_bucket('name')
  runOn(sql, /storage\s*\.\s*create_bucket\s*\(\s*'([^']+)'/gi, (m) =>
    push("storage_bucket", m[1]),
  );

  // ALTER PUBLICATION supabase_realtime ADD TABLE x
  runOn(
    sql,
    new RegExp(`\\bALTER\\s+PUBLICATION\\s+(${IDENT})\\s+ADD\\s+TABLE\\s+(${QUALIFIED})`, "gi"),
    (m) => push("realtime", m[2], m[2]),
  );

  return objects;
}

function runOn(source: string, rx: RegExp, fn: (m: RegExpExecArray) => void) {
  let m: RegExpExecArray | null;
  rx.lastIndex = 0;
  while ((m = rx.exec(source)) !== null) fn(m);
}

// ─── Edge function source parsing ────────────────────────────────────

export type EdgeFunctionRefs = {
  /** Secret names from Deno.env.get("X") — platform-injected SUPABASE_* removed. */
  secrets: string[];
  /** Tables/views read or written, schema-qualified when `.schema()` was used. */
  tables: string[];
  /** Postgres functions called via .rpc("name"). */
  rpcs: string[];
  /** Storage buckets touched via .storage.from("bucket"). */
  buckets: string[];
  /** Paths relative to supabase/functions/, e.g. "_shared/auth.ts". */
  sharedImports: string[];
  /** Sibling edge functions invoked from this one. */
  invokes: string[];
  /** Third-party hosts contacted with fetch(). */
  externalHosts: string[];
};

/** Names Supabase injects into every function runtime — never operator-supplied. */
const AUTO_INJECTED_SECRETS = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_PUBLISHABLE_KEY",
]);

/**
 * Postgrest `.from()` is also used by non-database builders (storage, and some
 * third-party SDKs). We resolve `.storage.from()` first and blank those spans
 * before scanning for tables, so buckets never land in the table list.
 */
function maskStorageFrom(source: string): { masked: string; buckets: string[] } {
  const buckets: string[] = [];
  const masked = source.replace(
    /\.storage\s*\.\s*from\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    (full, bucket: string) => {
      buckets.push(bucket);
      return " ".repeat(full.length);
    },
  );
  return { masked, buckets };
}

function collect(rx: RegExp, source: string, group = 1): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  rx.lastIndex = 0;
  while ((m = rx.exec(source)) !== null) {
    const v = m[group];
    if (v) out.push(v);
  }
  return out;
}

const uniqSorted = (xs: string[]): string[] => Array.from(new Set(xs)).sort();

/**
 * Track the schema a query builder was switched into. Supabase clients do
 * `client.schema("aml").from("cases")`; without this, `cases` would collide
 * with a public table of the same name.
 */
function extractTables(source: string): string[] {
  const out: string[] = [];

  // Schema-qualified: .schema("aml").from("cases")
  const qualified =
    /\.schema\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)\s*\.\s*from\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  const consumed: Array<[number, number]> = [];
  while ((m = qualified.exec(source)) !== null) {
    out.push(`${m[1]}.${m[2]}`);
    consumed.push([m.index, m.index + m[0].length]);
  }

  // Plain .from("table") that wasn't part of a schema-qualified chain.
  const plain = /\.from\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_.]*)["'`]/g;
  while ((m = plain.exec(source)) !== null) {
    const start = m.index;
    if (consumed.some(([a, b]) => start >= a && start < b)) continue;
    out.push(m[1]);
  }

  return out;
}

/** Parse an edge function's source for everything it depends on. */
export function parseEdgeFunctionRefs(source: string): EdgeFunctionRefs {
  if (typeof source !== "string" || source.length === 0) {
    return {
      secrets: [],
      tables: [],
      rpcs: [],
      buckets: [],
      sharedImports: [],
      invokes: [],
      externalHosts: [],
    };
  }

  const { masked, buckets } = maskStorageFrom(source);

  const secrets = collect(
    /Deno\s*\.\s*env\s*\.\s*get\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g,
    source,
  ).filter((n) => !AUTO_INJECTED_SECRETS.has(n) && !n.startsWith("SUPABASE_"));

  // Imports of ../_shared/x.ts (and deeper: ../_shared/aml/y.ts)
  const sharedImports = collect(/["'`](?:\.\.\/)+(_shared\/[A-Za-z0-9_./-]+)["'`]/g, source);

  // Function-to-function calls: invoke("slug") or a direct /functions/v1/slug URL.
  const invokes = [
    ...collect(/\.functions\s*\.\s*invoke\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g, source),
    ...collect(/\/functions\/v1\/([A-Za-z0-9_-]+)/g, source),
  ];

  const externalHosts = collect(
    /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?:[/:]|["'`])/g,
    source,
  ).filter((h) => !h.endsWith(".supabase.co") && h !== "localhost");

  return {
    secrets: uniqSorted(secrets),
    tables: uniqSorted(extractTables(masked)),
    rpcs: uniqSorted(collect(/\.rpc\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g, masked)),
    buckets: uniqSorted(buckets),
    sharedImports: uniqSorted(sharedImports),
    invokes: uniqSorted(invokes),
    externalHosts: uniqSorted(externalHosts),
  };
}

// ─── Frontend → backend boundary parsing ─────────────────────────────

export type FrontendBackendRefs = {
  /** Edge functions invoked through an unambiguous call site. */
  edgeFunctions: string[];
  /**
   * Edge functions matched only by a bare string literal equal to a known
   * slug — the prime routes most calls through helpers like
   * `invokePortalEdge(name)` / `fetch(\`…/functions/v1/${name}\`)`, so the
   * literal is the only place the slug appears. Lower confidence than
   * `edgeFunctions`; tracked separately so the UI can say which is which.
   */
  indirectEdgeFunctions: string[];
  tables: string[];
  rpcs: string[];
  buckets: string[];
  /** Build-time env vars (VITE_*, NEXT_PUBLIC_*, process.env.*). */
  envVars: string[];
};

/**
 * Slugs short enough that a bare string literal match is more likely to be a
 * coincidence (a CSS class, a query key) than a real invocation. Multi-segment
 * kebab-case names are distinctive enough to trust.
 */
function isDistinctiveSlug(slug: string): boolean {
  return slug.includes("-") || slug.length >= 12;
}

/**
 * Recover indirect invocations: every string literal that exactly matches a
 * known edge-function slug. Callers supply the slug set from the backend
 * inventory, so this can only ever resolve to functions that really exist —
 * a query key like `"client-portal-reports"` finds no match and is dropped.
 */
export function matchIndirectEdgeInvocations(
  source: string,
  knownSlugs: ReadonlySet<string>,
): string[] {
  if (typeof source !== "string" || knownSlugs.size === 0) return [];
  const found = new Set<string>();
  const rx = /["'`]([A-Za-z0-9][A-Za-z0-9_-]{2,})["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(source)) !== null) {
    const v = m[1];
    if (knownSlugs.has(v) && isDistinctiveSlug(v)) found.add(v);
  }
  return Array.from(found).sort();
}

/**
 * Find every point where frontend source crosses into the backend. This is the
 * edge the old detector could not traverse: an ES import graph stops at
 * `supabase.functions.invoke("aml-cases")` because the target isn't a file.
 *
 * Pass `knownSlugs` to additionally recover helper-indirected calls.
 */
export function parseFrontendBackendRefs(
  source: string,
  knownSlugs?: ReadonlySet<string>,
): FrontendBackendRefs {
  if (typeof source !== "string" || source.length === 0) {
    return {
      edgeFunctions: [],
      indirectEdgeFunctions: [],
      tables: [],
      rpcs: [],
      buckets: [],
      envVars: [],
    };
  }

  const { masked, buckets } = maskStorageFrom(source);

  const edgeFunctions = [
    ...collect(/\.functions\s*\.\s*invoke\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g, source),
    ...collect(/\/functions\/v1\/([A-Za-z0-9_-]+)/g, source),
  ];

  const envVars = [
    ...collect(/import\s*\.\s*meta\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g, source),
    ...collect(
      /import\s*\.\s*meta\s*\.\s*env\s*\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
      source,
    ),
    ...collect(/process\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g, source),
  ].filter((v) => v !== "MODE" && v !== "DEV" && v !== "PROD" && v !== "SSR" && v !== "BASE_URL");

  const direct = uniqSorted(edgeFunctions);
  const indirect = knownSlugs
    ? matchIndirectEdgeInvocations(source, knownSlugs).filter((s) => !direct.includes(s))
    : [];

  return {
    edgeFunctions: direct,
    indirectEdgeFunctions: indirect,
    tables: uniqSorted(extractTables(masked)),
    rpcs: uniqSorted(collect(/\.rpc\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g, masked)),
    buckets: uniqSorted(buckets),
    envVars: uniqSorted(envVars),
  };
}

// ─── Env template parsing ────────────────────────────────────────────

/**
 * Read secret *names* out of a `.env.example`. Values are ignored entirely —
 * a template may contain placeholders, and we never want a real value to be
 * lifted out of the prime repo into module metadata.
 */
export function parseEnvTemplateNames(content: string): string[] {
  if (typeof content !== "string") return [];
  const names: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(t);
    if (m) names.push(m[1]);
  }
  return uniqSorted(names);
}

// ─── Backend inventory ───────────────────────────────────────────────

export type EdgeFunctionNode = {
  slug: string;
  /** Repo paths belonging to this function's own directory. */
  files: string[];
  entryFile: string | null;
  verifyJwt: boolean;
  refs: EdgeFunctionRefs;
  /** Transitively resolved (own + _shared + invoked siblings). */
  resolvedSecrets: string[];
  resolvedTables: string[];
  resolvedRpcs: string[];
  resolvedBuckets: string[];
  /** `_shared/…` paths this function pulls in, transitively. */
  resolvedShared: string[];
};

export type MigrationNode = {
  /** Filename, e.g. "20260419215311_init.sql" */
  name: string;
  path: string;
  objects: DbObject[];
};

export type BackendInventory = {
  edgeFunctions: Map<string, EdgeFunctionNode>;
  migrations: MigrationNode[];
  /** table name (unqualified for public) → migration paths that declare it */
  tableToMigrations: Map<string, string[]>;
  /** rpc/function name → migration paths */
  rpcToMigrations: Map<string, string[]>;
  /** bucket id → migration paths */
  bucketToMigrations: Map<string, string[]>;
  sharedFiles: string[];
  cronJobs: Array<{ name: string; migrationPath: string }>;
  storageBuckets: string[];
  extensions: string[];
  envTemplateNames: string[];
  sidecarServices: Map<string, string[]>;
  workflows: string[];
};

/**
 * Resolve `_shared` transitive closure for one function: a function that
 * imports `_shared/auth.ts` inherits whatever secrets and tables that file
 * touches, and whatever *it* imports in turn.
 */
function resolveSharedClosure(
  entryShared: string[],
  sharedRefs: Map<string, EdgeFunctionRefs>,
): { shared: string[]; refs: EdgeFunctionRefs[] } {
  const seen = new Set<string>();
  const queue = [...entryShared];
  const refs: EdgeFunctionRefs[] = [];

  while (queue.length > 0) {
    const rel = queue.shift()!;
    // Normalise: `_shared/auth.ts` and `_shared/auth` both resolve.
    const key = rel.replace(/\.(ts|tsx|js|mjs)$/, "");
    if (seen.has(key)) continue;
    seen.add(key);

    const r = sharedRefs.get(rel) ?? sharedRefs.get(`${key}.ts`) ?? sharedRefs.get(key);
    if (!r) continue;
    refs.push(r);
    for (const next of r.sharedImports) queue.push(next);
  }

  return { shared: Array.from(seen).map((k) => `${k}.ts`), refs };
}

export type BuildInventoryInput = {
  /** Every repo path from the git tree. */
  files: string[];
  /** path → text content, for backend files we were able to read. */
  contents: Map<string, string>;
  /** Per-function verify_jwt from supabase/config.toml. */
  functionConfig?: Map<string, { verifyJwt: boolean }>;
};

/**
 * Turn raw repo paths + contents into a resolved backend inventory: edge
 * functions with their transitive dependencies, migrations with the objects
 * they declare, and the reverse indexes that let a table name resolve back to
 * the migrations that create it.
 */
export function buildBackendInventory(input: BuildInventoryInput): BackendInventory {
  const { files, contents, functionConfig } = input;

  // Parse on the way in, then hand off to the shared assembler.
  const migrationObjects = new Map<string, { objects: DbObject[] }>();
  const functionRefs = new Map<string, EdgeFunctionRefs>();
  const envContents = new Map<string, string>();

  for (const path of files) {
    const info = classifyBackendPath(path);
    if (!info) continue;
    const content = contents.get(path);
    if (content === undefined) continue;
    if (info.kind === "migration") {
      migrationObjects.set(path, { objects: parseMigrationObjects(content) });
    } else if (info.kind === "edge_function" || info.kind === "edge_shared") {
      functionRefs.set(path, parseEdgeFunctionRefs(content));
    } else if (info.kind === "env_template") {
      envContents.set(path, content);
    }
  }

  return buildBackendInventoryFromAnalysis({
    files,
    migrationObjects,
    functionRefs,
    functionConfig: functionConfig ?? new Map(),
    envContents,
  });
}

/**
 * Assemble the inventory from already-parsed analysis.
 *
 * The detection engine reads blobs through a SHA-keyed cache, so it holds
 * parse *results* rather than file contents. Re-serialising those back into
 * source text just to re-parse them would defeat the cache entirely.
 */
export function buildBackendInventoryFromAnalysis(input: {
  files: string[];
  migrationObjects: Map<string, { objects: DbObject[] }>;
  functionRefs: Map<string, EdgeFunctionRefs>;
  functionConfig: Map<string, { verifyJwt: boolean }>;
  envContents: Map<string, string>;
}): BackendInventory {
  const { files, migrationObjects, functionRefs, functionConfig, envContents } = input;

  const edgeFiles = new Map<string, string[]>();
  const sharedFiles: string[] = [];
  const migrationPaths: string[] = [];
  const sidecarServices = new Map<string, string[]>();
  const workflows: string[] = [];
  const envTemplates: string[] = [];

  for (const path of files) {
    const info = classifyBackendPath(path);
    if (!info) continue;
    switch (info.kind) {
      case "edge_function": {
        const list = edgeFiles.get(info.identifier) ?? [];
        list.push(path);
        edgeFiles.set(info.identifier, list);
        break;
      }
      case "edge_shared":
        sharedFiles.push(path);
        break;
      case "migration":
        migrationPaths.push(path);
        break;
      case "sidecar_service": {
        const list = sidecarServices.get(info.identifier) ?? [];
        list.push(path);
        sidecarServices.set(info.identifier, list);
        break;
      }
      case "workflow":
        workflows.push(path);
        break;
      case "env_template":
        envTemplates.push(path);
        break;
      default:
        break;
    }
  }

  // ── Shared edge library refs, keyed by "_shared/…" relative path ──
  const sharedRefs = new Map<string, EdgeFunctionRefs>();
  for (const path of sharedFiles) {
    const rel = path.slice(EDGE_PREFIX.length);
    const refs = functionRefs.get(path);
    if (refs) sharedRefs.set(rel, refs);
  }

  // ── Edge functions ──
  const edgeFunctions = new Map<string, EdgeFunctionNode>();
  for (const [slug, paths] of edgeFiles) {
    const ownRefs: EdgeFunctionRefs[] = [];
    for (const p of paths) {
      const refs = functionRefs.get(p);
      if (refs) ownRefs.push(refs);
    }

    const entryFile =
      paths.find((p) => p === `${EDGE_PREFIX}${slug}/index.ts`) ??
      paths.find((p) => /\/index\.(ts|tsx|js)$/.test(p)) ??
      paths.find((p) => /\.(ts|js)$/.test(p)) ??
      null;

    const merged: EdgeFunctionRefs = {
      secrets: uniqSorted(ownRefs.flatMap((r) => r.secrets)),
      tables: uniqSorted(ownRefs.flatMap((r) => r.tables)),
      rpcs: uniqSorted(ownRefs.flatMap((r) => r.rpcs)),
      buckets: uniqSorted(ownRefs.flatMap((r) => r.buckets)),
      sharedImports: uniqSorted(ownRefs.flatMap((r) => r.sharedImports)),
      invokes: uniqSorted(ownRefs.flatMap((r) => r.invokes).filter((s) => s !== slug)),
      externalHosts: uniqSorted(ownRefs.flatMap((r) => r.externalHosts)),
    };

    const closure = resolveSharedClosure(merged.sharedImports, sharedRefs);

    edgeFunctions.set(slug, {
      slug,
      files: paths.sort(),
      entryFile,
      verifyJwt: functionConfig.get(slug)?.verifyJwt ?? true,
      refs: merged,
      resolvedSecrets: uniqSorted([...merged.secrets, ...closure.refs.flatMap((r) => r.secrets)]),
      resolvedTables: uniqSorted([...merged.tables, ...closure.refs.flatMap((r) => r.tables)]),
      resolvedRpcs: uniqSorted([...merged.rpcs, ...closure.refs.flatMap((r) => r.rpcs)]),
      resolvedBuckets: uniqSorted([...merged.buckets, ...closure.refs.flatMap((r) => r.buckets)]),
      resolvedShared: closure.shared.sort(),
    });
  }

  // Second pass: fold invoked siblings' requirements into the caller. A page
  // that invokes `report-orchestrator` needs whatever that fans out to.
  for (const node of edgeFunctions.values()) {
    const seen = new Set<string>([node.slug]);
    const queue = [...node.refs.invokes];
    while (queue.length > 0) {
      const slug = queue.shift()!;
      if (seen.has(slug)) continue;
      seen.add(slug);
      const target = edgeFunctions.get(slug);
      if (!target) continue;
      node.resolvedSecrets = uniqSorted([...node.resolvedSecrets, ...target.resolvedSecrets]);
      node.resolvedTables = uniqSorted([...node.resolvedTables, ...target.resolvedTables]);
      node.resolvedRpcs = uniqSorted([...node.resolvedRpcs, ...target.resolvedRpcs]);
      node.resolvedBuckets = uniqSorted([...node.resolvedBuckets, ...target.resolvedBuckets]);
      for (const next of target.refs.invokes) queue.push(next);
    }
  }

  // ── Migrations ──
  const migrations: MigrationNode[] = [];
  const tableToMigrations = new Map<string, string[]>();
  const rpcToMigrations = new Map<string, string[]>();
  const bucketToMigrations = new Map<string, string[]>();
  const cronJobs: Array<{ name: string; migrationPath: string }> = [];
  const storageBuckets = new Set<string>();
  const extensions = new Set<string>();

  const index = (map: Map<string, string[]>, key: string, path: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(path)) list.push(path);
    map.set(key, list);
  };

  for (const path of migrationPaths.sort()) {
    const parsed = migrationObjects.get(path);
    if (!parsed) continue;
    const objects = parsed.objects;
    migrations.push({ name: path.slice(MIGRATIONS_PREFIX.length), path, objects });

    for (const o of objects) {
      switch (o.kind) {
        case "table":
        case "view":
        case "materialized_view":
          index(tableToMigrations, o.name, path);
          break;
        case "policy":
        case "trigger":
        case "index":
        case "realtime":
          if (o.table) index(tableToMigrations, o.table, path);
          break;
        case "function":
          index(rpcToMigrations, o.name, path);
          break;
        case "storage_bucket":
          index(bucketToMigrations, o.name, path);
          storageBuckets.add(o.name);
          break;
        case "cron_job":
          cronJobs.push({ name: o.name, migrationPath: path });
          break;
        case "extension":
          extensions.add(o.name);
          break;
        default:
          break;
      }
    }
  }

  // ── Env templates ──
  const envTemplateNames = uniqSorted(
    envTemplates.flatMap((p) => parseEnvTemplateNames(envContents.get(p) ?? "")),
  );

  return {
    edgeFunctions,
    migrations,
    tableToMigrations,
    rpcToMigrations,
    bucketToMigrations,
    sharedFiles: sharedFiles.sort(),
    cronJobs,
    storageBuckets: Array.from(storageBuckets).sort(),
    extensions: Array.from(extensions).sort(),
    envTemplateNames,
    sidecarServices,
    workflows: workflows.sort(),
  };
}

// ─── Module linkage ──────────────────────────────────────────────────

export type ModuleBackendManifest = {
  edgeFunctions: string[];
  tables: string[];
  rpcs: string[];
  buckets: string[];
  cronJobs: string[];
  secrets: string[];
  /** Migration paths that declare any of this module's tables/functions. */
  migrations: string[];
  /** Repo globs covering the backend files this module needs. */
  backendGlobs: string[];
  /** Third-party hosts the module's backend talks to. */
  externalHosts: string[];
  /** Human-readable trace of how each edge function was linked. */
  links: Array<{ kind: string; identifier: string; via: string }>;
};

export const EMPTY_MANIFEST: ModuleBackendManifest = {
  edgeFunctions: [],
  tables: [],
  rpcs: [],
  buckets: [],
  cronJobs: [],
  secrets: [],
  migrations: [],
  backendGlobs: [],
  externalHosts: [],
  links: [],
};

export type ModuleFrontendInput = {
  slug: string;
  /** Frontend files the module owns (from import tracing). */
  resolvedFiles: string[];
};

/**
 * A migration touched by more than this many modules is infrastructure, not a
 * module's private schema. We still record it, but it must not be presented as
 * exclusively owned.
 */
export const SHARED_MIGRATION_THRESHOLD = 3;

/**
 * Join frontend modules to the backend inventory.
 *
 * Linkage chain, per module:
 *   frontend file → invoke("slug")        → edge function
 *   edge function → _shared closure       → more tables/secrets
 *   edge function → invoke("other")       → sibling functions
 *   table/rpc/bucket                      → declaring migrations
 */
export function linkBackendToModules(args: {
  modules: ModuleFrontendInput[];
  frontendRefs: Map<string, FrontendBackendRefs>;
  inventory: BackendInventory;
}): Map<string, ModuleBackendManifest> {
  const { modules, frontendRefs, inventory } = args;
  const out = new Map<string, ModuleBackendManifest>();

  for (const mod of modules) {
    const links: ModuleBackendManifest["links"] = [];
    const fnSlugs = new Set<string>();
    const tables = new Set<string>();
    const rpcs = new Set<string>();
    const buckets = new Set<string>();
    const secrets = new Set<string>();
    const hosts = new Set<string>();

    // 1. Direct references from the module's own frontend files.
    for (const file of mod.resolvedFiles) {
      const refs = frontendRefs.get(file);
      if (!refs) continue;
      for (const slug of refs.edgeFunctions) {
        if (!fnSlugs.has(slug) && inventory.edgeFunctions.has(slug)) {
          links.push({ kind: "edge_function", identifier: slug, via: file });
        }
        fnSlugs.add(slug);
      }
      // Helper-indirected calls: the slug only appears as a bare literal.
      for (const slug of refs.indirectEdgeFunctions) {
        if (!fnSlugs.has(slug) && inventory.edgeFunctions.has(slug)) {
          links.push({
            kind: "edge_function_indirect",
            identifier: slug,
            via: `${file} (slug literal)`,
          });
        }
        fnSlugs.add(slug);
      }
      for (const t of refs.tables) tables.add(t);
      for (const r of refs.rpcs) rpcs.add(r);
      for (const b of refs.buckets) buckets.add(b);
      for (const v of refs.envVars) secrets.add(v);
    }

    // 2. Fan out through the edge functions (already transitively resolved).
    const fanout = new Set<string>();
    const queue = [...fnSlugs];
    while (queue.length > 0) {
      const slug = queue.shift()!;
      if (fanout.has(slug)) continue;
      fanout.add(slug);
      const node = inventory.edgeFunctions.get(slug);
      if (!node) continue;
      for (const t of node.resolvedTables) tables.add(t);
      for (const r of node.resolvedRpcs) rpcs.add(r);
      for (const b of node.resolvedBuckets) buckets.add(b);
      for (const s of node.resolvedSecrets) secrets.add(s);
      for (const h of node.refs.externalHosts) hosts.add(h);
      for (const next of node.refs.invokes) {
        if (!fanout.has(next) && inventory.edgeFunctions.has(next)) {
          links.push({ kind: "edge_function", identifier: next, via: `invoked by ${slug}` });
          queue.push(next);
        }
      }
    }

    // 3. Resolve schema: tables/rpcs/buckets → declaring migrations.
    const migrations = new Set<string>();
    for (const t of tables) {
      for (const p of inventory.tableToMigrations.get(t) ?? []) migrations.add(p);
    }
    for (const r of rpcs) {
      for (const p of inventory.rpcToMigrations.get(r) ?? []) migrations.add(p);
    }
    for (const b of buckets) {
      for (const p of inventory.bucketToMigrations.get(b) ?? []) migrations.add(p);
    }

    // 4. Cron jobs defined in this module's migrations.
    const cronJobs = inventory.cronJobs
      .filter((c) => migrations.has(c.migrationPath))
      .map((c) => c.name);

    // 5. Backend globs — what the cascade must actually push to a clone.
    const backendGlobs: string[] = [];
    for (const slug of fanout) {
      if (inventory.edgeFunctions.has(slug)) {
        backendGlobs.push(`${EDGE_PREFIX}${slug}/**`);
      }
    }
    const usesShared = Array.from(fanout).some(
      (s) => (inventory.edgeFunctions.get(s)?.resolvedShared.length ?? 0) > 0,
    );
    if (usesShared) backendGlobs.push(`${EDGE_PREFIX}_shared/**`);

    out.set(mod.slug, {
      edgeFunctions: Array.from(fanout)
        .filter((s) => inventory.edgeFunctions.has(s))
        .sort(),
      tables: Array.from(tables).sort(),
      rpcs: Array.from(rpcs).sort(),
      buckets: Array.from(buckets).sort(),
      cronJobs: uniqSorted(cronJobs),
      secrets: Array.from(secrets).sort(),
      migrations: Array.from(migrations).sort(),
      backendGlobs: uniqSorted(backendGlobs),
      externalHosts: Array.from(hosts).sort(),
      links,
    });
  }

  return out;
}

/**
 * Edge functions no route reaches. These are real, deployable backend surface —
 * cron workers, webhook receivers, provider callbacks — and the old detector
 * filed every one of them under "orphan file" noise. Grouping them into
 * backend-only modules makes them installable and cascadable.
 */
export function synthesizeBackendModules(args: {
  inventory: BackendInventory;
  claimedFunctions: Set<string>;
  /** Max backend-only modules to emit. */
  maxModules?: number;
}): Array<{
  slug: string;
  name: string;
  description: string;
  functions: string[];
  manifest: ModuleBackendManifest;
}> {
  const { inventory, claimedFunctions, maxModules = 40 } = args;

  const unclaimed = Array.from(inventory.edgeFunctions.keys())
    .filter((slug) => !claimedFunctions.has(slug))
    .sort();
  if (unclaimed.length === 0) return [];

  // Group by leading slug segment: `aml-cases`, `aml-risk`, `aml-tenant` →
  // one "aml" backend module. Single-function groups stay standalone.
  const groups = new Map<string, string[]>();
  for (const slug of unclaimed) {
    const prefix = slug.split("-")[0] || slug;
    const list = groups.get(prefix) ?? [];
    list.push(slug);
    groups.set(prefix, list);
  }

  const result: Array<{
    slug: string;
    name: string;
    description: string;
    functions: string[];
    manifest: ModuleBackendManifest;
  }> = [];

  const ordered = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);

  for (const [prefix, slugs] of ordered) {
    if (result.length >= maxModules) break;

    const tables = new Set<string>();
    const rpcs = new Set<string>();
    const buckets = new Set<string>();
    const secrets = new Set<string>();
    const hosts = new Set<string>();
    let usesShared = false;

    for (const slug of slugs) {
      const node = inventory.edgeFunctions.get(slug);
      if (!node) continue;
      for (const t of node.resolvedTables) tables.add(t);
      for (const r of node.resolvedRpcs) rpcs.add(r);
      for (const b of node.resolvedBuckets) buckets.add(b);
      for (const s of node.resolvedSecrets) secrets.add(s);
      for (const h of node.refs.externalHosts) hosts.add(h);
      if (node.resolvedShared.length > 0) usesShared = true;
    }

    const migrations = new Set<string>();
    for (const t of tables) {
      for (const p of inventory.tableToMigrations.get(t) ?? []) migrations.add(p);
    }
    for (const r of rpcs) {
      for (const p of inventory.rpcToMigrations.get(r) ?? []) migrations.add(p);
    }

    const backendGlobs = slugs.map((s) => `${EDGE_PREFIX}${s}/**`);
    if (usesShared) backendGlobs.push(`${EDGE_PREFIX}_shared/**`);

    const cronJobs = inventory.cronJobs
      .filter((c) => migrations.has(c.migrationPath))
      .map((c) => c.name);

    result.push({
      slug: `backend-${prefix}`,
      name: `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)} Services`,
      description:
        slugs.length === 1
          ? `Backend-only module: edge function \`${slugs[0]}\`, not reachable from any route.`
          : `Backend-only module: ${slugs.length} edge functions sharing the \`${prefix}\` prefix, not reachable from any route.`,
      functions: slugs,
      manifest: {
        edgeFunctions: slugs,
        tables: Array.from(tables).sort(),
        rpcs: Array.from(rpcs).sort(),
        buckets: Array.from(buckets).sort(),
        cronJobs: uniqSorted(cronJobs),
        secrets: Array.from(secrets).sort(),
        migrations: Array.from(migrations).sort(),
        backendGlobs: uniqSorted(backendGlobs),
        externalHosts: Array.from(hosts).sort(),
        links: slugs.map((s) => ({
          kind: "edge_function",
          identifier: s,
          via: "unreferenced by any route",
        })),
      },
    });
  }

  return result;
}

/**
 * Count how many modules claim each migration, so the UI can distinguish a
 * module's own schema from repo-wide infrastructure migrations.
 */
export function computeMigrationSharing(
  manifests: Map<string, ModuleBackendManifest>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [slug, m] of manifests) {
    for (const path of m.migrations) {
      const list = out.get(path) ?? [];
      list.push(slug);
      out.set(path, list);
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}
