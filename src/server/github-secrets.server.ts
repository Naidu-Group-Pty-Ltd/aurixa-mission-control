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

export type PutRepoSecretInput = {
  owner: string;
  repo: string;
  name: string;
  value: string;
  installationId?: string | null;
};

/** Encrypt + upsert a repository Actions secret. Idempotent. */
export async function putRepoSecret(input: PutRepoSecretInput): Promise<void> {
  await ensureSodium();
  const octokit = getAppOctokit(input.installationId ?? undefined);

  const { data: pk } = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/secrets/public-key",
    { owner: input.owner, repo: input.repo },
  );

  const keyBytes = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(input.value);
  const sealed = sodium.crypto_box_seal(valueBytes, keyBytes);
  const encrypted_value = sodium.to_base64(
    sealed,
    sodium.base64_variants.ORIGINAL,
  );

  await octokit.request(
    "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
    {
      owner: input.owner,
      repo: input.repo,
      secret_name: input.name,
      encrypted_value,
      key_id: pk.key_id,
    },
  );
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
};

/** Best-effort push of multiple secrets; never throws. */
export async function syncRepoSecrets(
  input: SyncSecretsInput,
): Promise<SyncSecretsResult> {
  const written: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const [name, value] of Object.entries(input.secrets)) {
    if (!value) {
      skipped.push({ name, reason: "not configured in Mission Control" });
      continue;
    }
    try {
      await putRepoSecret({
        owner: input.owner,
        repo: input.repo,
        name,
        value,
        installationId: input.installationId ?? null,
      });
      written.push(name);
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const msg =
        e?.response?.data?.message ??
        (e instanceof Error ? e.message : String(e));
      failed.push({ name, error: status ? `${status}: ${msg}` : msg });
    }
  }

  return { ok: failed.length === 0, written, skipped, failed };
}

/**
 * The canonical set of Actions secrets that every Aurixa-managed repo
 * (Prime and each clone) needs for Codex Security remediation workflows.
 */
export function buildCodexRepoSecrets(): Record<string, string | undefined> {
  const appBase =
    process.env.APP_PUBLIC_URL ?? "https://mission-control.aurixasystems.com.au";
  return {
    CODEX_SECURITY_API_KEY: process.env.CODEX_SECURITY_API_KEY,
    CODEX_REMEDIATION_WEBHOOK_SECRET:
      process.env.CODEX_REMEDIATION_WEBHOOK_SECRET,
    CODEX_CALLBACK_URL: `${appBase.replace(/\/$/, "")}/api/public/hooks/codex-remediation`,
  };
}
