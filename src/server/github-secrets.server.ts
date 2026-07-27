// Server-only helper to write Actions repository secrets via the
// Aurixa GitHub App installation. Uses libsodium sealed box with the
// repo's Actions public key (required by GitHub REST API).
//
// Required GitHub App permission: `Repository → Secrets: Read & write`.
// If the installation lacks this permission, the API returns 403 —
// re-accept the App's updated permissions on the installation.
import sodium from "libsodium-wrappers";
import { getAppOctokit } from "@/server/github-app.server";

let sodiumReady: Promise<void> | null = null;
function ensureSodium(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  return sodiumReady;
}

/**
 * GitHub's own constraint on Actions secret names. Violating it returns a
 * bare 422 with no useful body, so we check up front and say what is wrong.
 */
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function validateSecretName(name: string): string | null {
  if (!SECRET_NAME_PATTERN.test(name)) {
    return "must contain only uppercase letters, digits and underscores, and may not start with a digit";
  }
  if (name.startsWith("GITHUB_")) {
    return "names starting with GITHUB_ are reserved by GitHub Actions";
  }
  return null;
}

/**
 * Turn an Octokit error into something an operator can act on. GitHub's
 * messages for this endpoint are famously ambiguous — a bare "Not Found"
 * covers a missing repo, an uninstalled app, AND a missing permission.
 */
export function describeSecretError(
  err: unknown,
  owner: string,
  repo: string,
): { status: number | null; message: string } {
  const status =
    (err as { status?: number })?.status ??
    (err as { response?: { status?: number } })?.response?.status ??
    null;
  const raw =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  if (status === 404) {
    return {
      status,
      message:
        `404: the Aurixa GitHub App cannot see ${target}. Either the App is not installed ` +
        `on ${owner}, ${target} is not in the installation's repository access list, or the ` +
        `installation lacks the "Secrets: Read & write" permission (GitHub reports that as 404).`,
    };
  }
  if (status === 403) {
    return {
      status,
      message:
        `403: the installation is missing the "Secrets: Read & write" permission for ${target}. ` +
        `Update the App's permissions, then re-accept them on the installation ` +
        `(github.com/settings/installations). Detail: ${raw}`,
    };
  }
  if (status === 401) {
    return {
      status,
      message:
        `401: GitHub rejected the App credentials. GITHUB_APP_PRIVATE_KEY probably does not ` +
        `match GITHUB_APP_ID, or GITHUB_APP_INSTALLATION_ID belongs to a different app. ` +
        `Detail: ${raw}`,
    };
  }
  if (status === 422) {
    return { status, message: `422: GitHub rejected the secret for ${target}: ${raw}` };
  }
  return { status, message: status ? `${status}: ${raw}` : raw };
}

export type PutRepoSecretInput = {
  owner: string;
  repo: string;
  name: string;
  value: string;
  installationId?: string | null;
};

/** Encrypt + upsert a repository Actions secret. Idempotent. */
export async function putRepoSecret(input: PutRepoSecretInput): Promise<void> {
  const nameProblem = validateSecretName(input.name);
  if (nameProblem) {
    throw new Error(`Invalid secret name "${input.name}": ${nameProblem}`);
  }

  await ensureSodium();
  const octokit = getAppOctokit(input.installationId ?? undefined);

  const { data: pk } = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/secrets/public-key",
    { owner: input.owner, repo: input.repo },
  );

  const keyBytes = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(input.value);
  const sealed = sodium.crypto_box_seal(valueBytes, keyBytes);
  const encrypted_value = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

  await octokit.request("PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}", {
    owner: input.owner,
    repo: input.repo,
    secret_name: input.name,
    encrypted_value,
    key_id: pk.key_id,
  });
}

export type SyncSecretsInput = {
  owner: string;
  repo: string;
  installationId?: string | null;
  /** Explicit map of secret name → value. Undefined/empty values are skipped. */
  secrets: Record<string, string | undefined | null>;
};

export type SyncSecretsResult = {
  ok: boolean;
  written: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
  /** True when nothing was written because nothing was configured to write. */
  nothingConfigured: boolean;
};

/**
 * Best-effort push of multiple secrets; never throws.
 *
 * A repo-wide failure (app not installed, missing permission) hits every
 * secret identically, so it is detected once against the first configured
 * secret and short-circuits the rest instead of making N identical failing
 * round trips.
 */
export async function syncRepoSecrets(input: SyncSecretsInput): Promise<SyncSecretsResult> {
  const written: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { name: string; error: string }[] = [];

  const entries = Object.entries(input.secrets);
  const configured = entries.filter(([, value]) => !!value);

  for (const [name] of entries) {
    if (!input.secrets[name]) {
      skipped.push({ name, reason: "not configured in Mission Control" });
    }
  }

  let fatal: string | null = null;

  for (const [name, value] of configured) {
    if (fatal) {
      failed.push({ name, error: fatal });
      continue;
    }
    try {
      await putRepoSecret({
        owner: input.owner,
        repo: input.repo,
        name,
        value: value as string,
        installationId: input.installationId ?? null,
      });
      written.push(name);
    } catch (e) {
      const { status, message } = describeSecretError(e, input.owner, input.repo);
      failed.push({ name, error: message });
      // 401/403/404 are properties of the repo + installation, not of this
      // particular secret — retrying the remaining names cannot succeed.
      if (status === 401 || status === 403 || status === 404) fatal = message;
    }
  }

  return {
    ok: failed.length === 0 && configured.length > 0,
    written,
    skipped,
    failed,
    nothingConfigured: configured.length === 0,
  };
}

/**
 * The canonical set of Actions secrets that every Aurixa-managed repo
 * (Prime and each clone) needs for the Codex Security workflows.
 *
 * The scan and remediation workflows receive their callback URL and HMAC
 * secret as workflow_dispatch inputs, so the only secret they genuinely
 * require in the repo is the model API key. The rest are written for
 * operator convenience and for workflows that run outside a dispatch.
 */
export async function buildCodexRepoSecrets(): Promise<Record<string, string | undefined>> {
  const { remediationCallbackUrl, scanCallbackUrl } =
    await import("@/server/codex-security-client.server");
  return {
    // Authenticates the Codex CLI in both the scan reasoning pass and the
    // remediation patch author. CODEX_SECURITY_API_KEY is the legacy alias.
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.CODEX_SECURITY_API_KEY,
    CODEX_SECURITY_API_KEY: process.env.CODEX_SECURITY_API_KEY,
    CODEX_REMEDIATION_WEBHOOK_SECRET: process.env.CODEX_REMEDIATION_WEBHOOK_SECRET,
    CODEX_SECURITY_WEBHOOK_SECRET: process.env.CODEX_SECURITY_WEBHOOK_SECRET,
    CODEX_CALLBACK_URL: remediationCallbackUrl(),
    CODEX_SCAN_CALLBACK_URL: scanCallbackUrl(),
  };
}

export type SecretPreviewEntry = {
  name: string;
  configured: boolean;
  /** Why it matters, shown next to the name in the settings card. */
  purpose: string;
  required: boolean;
};

const SECRET_PURPOSES: Record<string, { purpose: string; required: boolean }> = {
  OPENAI_API_KEY: {
    purpose: "Codex CLI auth — the scan reasoning pass and every remediation patch",
    required: true,
  },
  CODEX_SECURITY_API_KEY: {
    purpose: "Legacy alias for OPENAI_API_KEY, kept for older workflow revisions",
    required: false,
  },
  CODEX_REMEDIATION_WEBHOOK_SECRET: {
    purpose: "Signs remediation PR callbacks (normally passed as a dispatch input)",
    required: false,
  },
  CODEX_SECURITY_WEBHOOK_SECRET: {
    purpose: "Signs scan result callbacks (normally passed as a dispatch input)",
    required: false,
  },
  CODEX_CALLBACK_URL: {
    purpose: "Remediation callback endpoint",
    required: false,
  },
  CODEX_SCAN_CALLBACK_URL: {
    purpose: "Scan result callback endpoint",
    required: false,
  },
};

/**
 * Which secrets a sync would actually push — names and configured/not only,
 * never values. Lets the settings card explain "0 written" before the
 * operator clicks, instead of reporting a hollow success afterwards.
 */
export async function previewCodexRepoSecrets(): Promise<{
  entries: SecretPreviewEntry[];
  configuredCount: number;
  missingRequired: string[];
}> {
  const secrets = await buildCodexRepoSecrets();
  const entries: SecretPreviewEntry[] = Object.entries(secrets).map(([name, value]) => ({
    name,
    configured: !!value,
    purpose: SECRET_PURPOSES[name]?.purpose ?? "",
    required: SECRET_PURPOSES[name]?.required ?? false,
  }));
  return {
    entries,
    configuredCount: entries.filter((e) => e.configured).length,
    missingRequired: entries.filter((e) => e.required && !e.configured).map((e) => e.name),
  };
}
