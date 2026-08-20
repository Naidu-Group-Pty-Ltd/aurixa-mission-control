// Server-only helper that mints an installation-scoped Octokit client
// for the Aurixa GitHub App. Cached per installation for the life of the
// Worker isolate to avoid re-signing JWTs on every call.
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import forge from "node-forge";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

const cache = new Map<string, Octokit>();

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Normalize and, if necessary, convert a PEM private key to PKCS#8 format.
 * GitHub's API (via @octokit/auth-app / universal-github-app-jwt) only
 * accepts PKCS#8 (`BEGIN PRIVATE KEY`). Keys downloaded from GitHub App
 * settings are PKCS#1 (`BEGIN RSA PRIVATE KEY`), so we auto-convert.
 */
function normalizePemWhitespace(pem: string): string {
  let p = pem.replace(/\\n/g, "\n").trim();
  // Some secret stores flatten newlines to spaces. If the PEM has no real
  // newlines but does contain BEGIN/END markers, rebuild it: extract the
  // base64 body between the markers and re-wrap at 64 chars per line.
  if (!p.includes("\n")) {
    const m = p.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/);
    if (m) {
      const label = m[1].trim();
      const body = m[2].replace(/\s+/g, "");
      const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
      p = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
    }
  }
  return p;
}

function ensurePkcs8(pem: string): string {
  const normalized = normalizePemWhitespace(pem);

  // Already PKCS#8 — nothing to do
  if (normalized.includes("-----BEGIN PRIVATE KEY-----")) {
    return normalized;
  }

  // PKCS#1 → PKCS#8 conversion using node-forge
  if (normalized.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    try {
      const privateKey = forge.pki.privateKeyFromPem(normalized);
      const asn1 = forge.pki.privateKeyToAsn1(privateKey);
      const wrapped = forge.pki.wrapRsaPrivateKey(asn1);
      const pkcs8Pem = forge.pki.privateKeyInfoToPem(wrapped);
      console.log("[github-app] Auto-converted private key from PKCS#1 to PKCS#8");
      return pkcs8Pem.trim();
    } catch (e) {
      throw new Error(
        `Failed to convert PKCS#1 private key to PKCS#8: ${e instanceof Error ? e.message : String(e)}. ` +
          `Use the PEM Key Helper on the auth page to convert manually, or run: ` +
          `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out converted.pem`,
      );
    }
  }

  // Unknown format — pass through and let the auth library report the error
  return normalized;
}

/**
 * Returns an Octokit client authenticated as a specific installation of the
 * Aurixa GitHub App. If installationId is omitted, falls back to the default
 * installation configured via GITHUB_APP_INSTALLATION_ID.
 */
export function getAppOctokit(installationId?: string | number): Octokit {
  const appId = readEnv("GITHUB_APP_ID");
  const privateKey = ensurePkcs8(readEnv("GITHUB_APP_PRIVATE_KEY"));
  const installation = String(installationId ?? readEnv("GITHUB_APP_INSTALLATION_ID"));
  const cacheKey = `${appId}:${installation}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId: Number(installation),
    },
    request: {
      retries: 0, // we handle retry via withRetry hook below
    },
  });
  // Wrap every request in withRetry for transient 429/5xx/network errors.
  octokit.hook.wrap("request", async (request, options) => {
    return withRetry(async () => request(options), {
      attempts: 3,
      baseMs: 400,
      shouldRetry: (err) => isTransientHttpError(err),
      onRetry: (err, attempt, delay) => {
        const status = (err as { status?: number })?.status;
        console.warn(
          `[github] retry ${attempt} after ${Math.round(delay)}ms (status=${status ?? "?"})`,
        );
      },
    });
  });
  cache.set(cacheKey, octokit);
  return octokit;
}

/** Clear cached Octokit instances (e.g. after secret rotation). */
export function clearAppOctokitCache() {
  cache.clear();
}

export type RepoRef = {
  owner: string;
  repo: string;
  branch: string;
};

/** Convert a list of glob patterns into a deterministic file list by walking
 *  the repo tree at a given ref. Supports `*` and `**` globs.
 */
export async function listFilesMatchingGlobs(
  octokit: Octokit,
  ref: RepoRef,
  globs: string[],
): Promise<string[]> {
  if (globs.length === 0) return [];
  // Defence in depth: even if a caller forgets to run validateModuleGlobs,
  // never build a matcher for a pattern that could escape the module scope.
  const { validateModuleGlobs, isSafeRepoPath } = await import("@/lib/module-globs");
  const { valid, invalid } = validateModuleGlobs(globs);
  if (invalid.length > 0) {
    console.warn(
      `[github-app] rejected ${invalid.length} unsafe glob(s):`,
      invalid.map((i) => `${i.glob} (${i.reason})`).join(", "),
    );
  }
  if (valid.length === 0) return [];
  // Get the commit SHA of the branch
  const { data: branch } = await octokit.repos.getBranch({
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
  });
  const treeSha = branch.commit.commit.tree.sha;
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: treeSha,
    recursive: "true",
  });
  const matchers = valid.map(globToRegex);
  return (tree.tree ?? [])
    .filter((n) => n.type === "blob" && typeof n.path === "string")
    .map((n) => n.path as string)
    .filter((p) => isSafeRepoPath(p) && matchers.some((rx) => rx.test(p)));
}

function globToRegex(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

export async function getFileContent(
  octokit: Octokit,
  ref: RepoRef,
  path: string,
): Promise<{ sha: string; content: string } | null> {
  try {
    const res = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ref: ref.branch,
    });
    const data = res.data as { type?: string; sha?: string; content?: string };
    if (data.type !== "file" || !data.sha) return null;
    const content = data.content ? Buffer.from(data.content, "base64").toString("utf8") : "";
    return { sha: data.sha, content };
  } catch (e: unknown) {
    if ((e as { status?: number })?.status === 404) return null;
    throw e;
  }
}
