/**
 * What may be given a PUBLIC name, and what must never be.
 *
 * Vite inlines every `VITE_`-prefixed variable into the client bundle at build
 * time. Marking it "encrypted" on the hosting provider protects it at rest and
 * not at all in the artefact — the value is a string literal in the JavaScript
 * every visitor downloads. The same is true of `NEXT_PUBLIC_`.
 *
 * That makes one mistake catastrophic and completely silent: give the Supabase
 * SERVICE-ROLE key a `VITE_` name and the build succeeds, the deployment goes
 * live, and a key that bypasses every RLS policy on the clone's database is
 * served to the public. Nothing fails. Nothing logs. The repo already refuses to
 * write `.aurixa/credentials.json` into a non-private repository for the same
 * class of reason (`clone-credentials.server.ts`); this is that guardrail for
 * the deployment path.
 *
 * So the rule is enforced rather than documented: `buildCloneEnv` THROWS when a
 * value whose name matches a secret pattern is about to be published, and the
 * worker imports this module rather than re-deriving the rule at the call site.
 * One implementation, rendered in the operator preview and enforced on the way
 * out — the same shape as `assessPepEvidence` in the property dashboard, where
 * what an operator is asked for and what the server accepts cannot become two
 * standards.
 */

/** Prefixes a bundler inlines into client-side code. */
export const PUBLIC_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_"] as const;

/**
 * Name fragments that mean "this value grants authority".
 *
 * Matched case-insensitively against the WHOLE name, so `VITE_SUPABASE_SERVICE_ROLE_KEY`
 * is caught by `SERVICE_ROLE` even though the name starts with a public prefix.
 * `KEY` alone is deliberately absent — `ANON_KEY` and `PUBLISHABLE_KEY` are
 * publishable by design, and a rule that flags every key is a rule people turn
 * off.
 */
export const SECRET_FRAGMENTS = [
  "SERVICE_ROLE",
  "SERVICE_KEY",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "ACCESS_TOKEN",
  "API_TOKEN",
  "CLIENT_SECRET",
  "WEBHOOK_SECRET",
  "DB_PASS",
  "DATABASE_URL",
  "CONNECTION_STRING",
] as const;

export type EnvTarget = "production" | "preview" | "development";

export type CloneEnvVar = {
  key: string;
  value: string;
  /** True when the bundler will inline this into client-side code. */
  publicToBundle: boolean;
  targets: EnvTarget[];
};

export class EnvPolicyError extends Error {
  constructor(
    message: string,
    public readonly key: string,
  ) {
    super(message);
    this.name = "EnvPolicyError";
  }
}

export function isPublicName(key: string): boolean {
  return PUBLIC_PREFIXES.some((p) => key.startsWith(p));
}

export function looksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_FRAGMENTS.some((f) => upper.includes(f));
}

/**
 * The check, on its own so a preview surface can call it without building the
 * whole environment. Returns the reason a name is refused, or null.
 */
export function refuseReason(key: string): string | null {
  if (!isPublicName(key)) return null;
  if (!looksSecret(key)) return null;
  const fragment = SECRET_FRAGMENTS.find((f) => key.toUpperCase().includes(f));
  return (
    `${key} would be inlined into the client bundle by its prefix, and its name ` +
    `contains "${fragment}". A value that grants authority cannot have a public name.`
  );
}

export type BuildCloneEnvInput = {
  /** The clone's own Supabase project URL, e.g. https://abc.supabase.co */
  supabaseUrl?: string | null;
  /** The clone's own project ref. */
  supabaseProjectRef?: string | null;
  /** The PUBLISHABLE (anon) key. Never the service-role key. */
  supabaseAnonKey?: string | null;
  /** The clone's Mission Control API key, already committed to its private repo. */
  aurixaApiKey?: string | null;
  /** The origin the clone will be served from, once it is known. */
  siteOrigin?: string | null;
  /** Anything else the operator has configured. Classified by the same rule. */
  extra?: Record<string, string | null | undefined>;
};

/**
 * Build the environment for a clone's hosting project.
 *
 * Only values that are publishable by design get a public prefix. The
 * service-role key and the database password are NOT accepted by this function
 * at all — there is no parameter for them, which is a stronger guarantee than
 * filtering them out, because a caller cannot pass what the type does not name.
 */
export function buildCloneEnv(input: BuildCloneEnvInput): CloneEnvVar[] {
  const all: EnvTarget[] = ["production", "preview", "development"];
  const out: CloneEnvVar[] = [];

  const push = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return;
    const trimmed = String(value).trim();
    if (!trimmed) return;
    const reason = refuseReason(key);
    if (reason) throw new EnvPolicyError(reason, key);
    out.push({ key, value: trimmed, publicToBundle: isPublicName(key), targets: all });
  };

  push("VITE_SUPABASE_URL", input.supabaseUrl);
  push("VITE_SUPABASE_PROJECT_ID", input.supabaseProjectRef);
  // Both spellings: the prime reads one and older clones read the other, and a
  // clone that builds against a missing name fails at runtime with an
  // unauthenticated Supabase client rather than at build time.
  push("VITE_SUPABASE_ANON_KEY", input.supabaseAnonKey);
  push("VITE_SUPABASE_PUBLISHABLE_KEY", input.supabaseAnonKey);
  push("VITE_AURIXA_API_KEY", input.aurixaApiKey);
  push("VITE_SITE_URL", input.siteOrigin);

  for (const [key, value] of Object.entries(input.extra ?? {})) push(key, value);

  return out;
}

/**
 * A stable digest of what we last pushed, so a re-sync that would change
 * nothing is skipped rather than burning a rate-limited write per clone per
 * run. Sorted by key, and it covers VALUES as well as names — a rotated API key
 * with the same name has to re-sync, and a digest over names alone would not
 * notice.
 *
 * Not a cryptographic hash and does not need to be: it compares two things we
 * produced ourselves, and a collision costs one skipped sync, not a security
 * property. Written this way because the Workers runtime gives us no
 * synchronous hash and this stays pure and testable.
 */
export function envDigest(vars: CloneEnvVar[]): string {
  const canonical = [...vars]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((v) => `${v.key}=${v.value}`)
    .join("\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
