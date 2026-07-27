import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexRepoSecrets,
  describeSecretError,
  previewCodexRepoSecrets,
  validateSecretName,
} from "@/server/github-secrets.server";

const TOUCHED = [
  "OPENAI_API_KEY",
  "CODEX_SECURITY_API_KEY",
  "CODEX_REMEDIATION_WEBHOOK_SECRET",
  "CODEX_SECURITY_WEBHOOK_SECRET",
  "APP_PUBLIC_URL",
  "PUBLIC_APP_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("validateSecretName", () => {
  it("accepts GitHub's allowed shape", () => {
    for (const name of ["OPENAI_API_KEY", "_PRIVATE", "A1_B2"]) {
      expect(validateSecretName(name)).toBeNull();
    }
  });

  it("rejects names GitHub would 422 on, with a reason", () => {
    // GitHub answers these with a bare 422 and no useful body, so catching
    // them locally is the difference between a fix and a mystery.
    expect(validateSecretName("lowercase")).toMatch(/uppercase/);
    expect(validateSecretName("HAS-DASH")).toMatch(/uppercase/);
    expect(validateSecretName("1STARTS_WITH_DIGIT")).toMatch(/uppercase/);
    expect(validateSecretName("HAS SPACE")).toMatch(/uppercase/);
  });

  it("rejects the reserved GITHUB_ prefix", () => {
    expect(validateSecretName("GITHUB_TOKEN")).toMatch(/reserved/);
  });
});

describe("describeSecretError", () => {
  it("explains that a 404 may be a permission problem, not a missing repo", () => {
    // GitHub returns 404 for a missing repo, an uninstalled app, AND a
    // missing Secrets permission — an operator cannot guess which.
    const { status, message } = describeSecretError({ status: 404 }, "acme", "widgets");
    expect(status).toBe(404);
    expect(message).toContain("acme/widgets");
    expect(message).toContain("not installed");
    expect(message).toContain("Secrets: Read & write");
  });

  it("names the exact permission for a 403", () => {
    const { message } = describeSecretError(
      { status: 403, response: { data: { message: "Resource not accessible" } } },
      "acme",
      "widgets",
    );
    expect(message).toContain("Secrets: Read & write");
    expect(message).toContain("Resource not accessible");
  });

  it("points a 401 at the App credentials", () => {
    const { message } = describeSecretError({ status: 401 }, "acme", "widgets");
    expect(message).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(message).toContain("GITHUB_APP_ID");
  });

  it("falls back to the raw message for unclassified errors", () => {
    const { status, message } = describeSecretError(new Error("socket hang up"), "a", "b");
    expect(status).toBeNull();
    expect(message).toBe("socket hang up");
  });
});

describe("buildCodexRepoSecrets", () => {
  it("uses CODEX_SECURITY_API_KEY as the legacy alias for OPENAI_API_KEY", async () => {
    process.env.CODEX_SECURITY_API_KEY = "legacy-key";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.OPENAI_API_KEY).toBe("legacy-key");
  });

  it("prefers OPENAI_API_KEY when both are set", async () => {
    process.env.OPENAI_API_KEY = "new-key";
    process.env.CODEX_SECURITY_API_KEY = "legacy-key";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.OPENAI_API_KEY).toBe("new-key");
  });

  it("derives callback URLs from the configured origin", async () => {
    process.env.PUBLIC_APP_URL = "https://mc.example/";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.CODEX_CALLBACK_URL).toBe(
      "https://mc.example/api/public/hooks/codex-remediation",
    );
    expect(secrets.CODEX_SCAN_CALLBACK_URL).toBe(
      "https://mc.example/api/public/hooks/codex-security",
    );
  });
});

describe("previewCodexRepoSecrets", () => {
  it("reports nothing configured when no secret env vars are set", async () => {
    const preview = await previewCodexRepoSecrets();
    // Callback URLs are always derivable, so they count as configured; the
    // point is that the required model key is flagged as missing.
    expect(preview.missingRequired).toContain("OPENAI_API_KEY");
    expect(preview.entries.find((e) => e.name === "OPENAI_API_KEY")?.configured).toBe(false);
  });

  it("clears the required-missing list once the key is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const preview = await previewCodexRepoSecrets();
    expect(preview.missingRequired).toEqual([]);
    expect(preview.configuredCount).toBeGreaterThan(0);
  });

  it("never returns a secret value", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret";
    const preview = await previewCodexRepoSecrets();
    expect(JSON.stringify(preview)).not.toContain("sk-super-secret");
  });
});
