import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appPublicOrigin,
  dispatchCodexScan,
  remediationCallbackUrl,
  resolveScanEngine,
  scanCallbackUrl,
  scanWorkflowFile,
  signCodexPayload,
  verifyCodexSignature,
  verifyHmacSignature,
} from "@/server/codex-security-client.server";

const TOUCHED = [
  "CODEX_SECURITY_ENGINE",
  "CODEX_SCAN_WORKFLOW_FILE",
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

describe("resolveScanEngine", () => {
  it("defaults to the GitHub Actions engine", () => {
    // The HTTP engine points at a vendor API that does not exist; defaulting
    // to it is what made every scan fail before it started.
    expect(resolveScanEngine()).toBe("github_actions");
  });

  it("honours an explicit http opt-in", () => {
    process.env.CODEX_SECURITY_ENGINE = "http";
    expect(resolveScanEngine()).toBe("http");
    process.env.CODEX_SECURITY_ENGINE = "API";
    expect(resolveScanEngine()).toBe("http");
  });

  it("falls back to GitHub Actions for an unrecognised value", () => {
    process.env.CODEX_SECURITY_ENGINE = "carrier-pigeon";
    expect(resolveScanEngine()).toBe("github_actions");
  });
});

describe("appPublicOrigin", () => {
  it("accepts either spelling of the origin variable", () => {
    // The code read APP_PUBLIC_URL while .env.example documented
    // PUBLIC_APP_URL, so callbacks silently went to the hardcoded default.
    process.env.PUBLIC_APP_URL = "https://documented.example";
    expect(appPublicOrigin()).toBe("https://documented.example");

    process.env.APP_PUBLIC_URL = "https://code.example";
    expect(appPublicOrigin()).toBe("https://code.example");
  });

  it("strips trailing slashes so callback URLs never double up", () => {
    process.env.APP_PUBLIC_URL = "https://mc.example///";
    expect(appPublicOrigin()).toBe("https://mc.example");
    expect(scanCallbackUrl()).toBe("https://mc.example/api/public/hooks/codex-security");
    expect(remediationCallbackUrl()).toBe("https://mc.example/api/public/hooks/codex-remediation");
  });

  it("falls back to the production origin when nothing is configured", () => {
    expect(appPublicOrigin()).toBe("https://mission-control.aurixasystems.com.au");
  });
});

describe("scanWorkflowFile", () => {
  it("defaults to the scan workflow and is overridable", () => {
    expect(scanWorkflowFile()).toBe("codex-security-scan.yml");
    process.env.CODEX_SCAN_WORKFLOW_FILE = "custom-scan.yml";
    expect(scanWorkflowFile()).toBe("custom-scan.yml");
  });
});

describe("signCodexPayload / verifyHmacSignature", () => {
  const body = JSON.stringify({ client_job_id: "abc", event: "scan.completed" });

  it("round-trips a signature it produced", async () => {
    const sig = await signCodexPayload("s3cret", body);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(await verifyHmacSignature(body, sig, ["s3cret"])).toBe(true);
  });

  it("accepts a bare hex signature without the sha256= prefix", async () => {
    const sig = await signCodexPayload("s3cret", body);
    expect(await verifyHmacSignature(body, sig.slice(7), ["s3cret"])).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = await signCodexPayload("s3cret", body);
    expect(await verifyHmacSignature(body + " ", sig, ["s3cret"])).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const sig = await signCodexPayload("s3cret", body);
    expect(await verifyHmacSignature(body, sig, ["other"])).toBe(false);
  });

  it("accepts either key during a rotation", async () => {
    const oldSig = await signCodexPayload("old-key", body);
    const newSig = await signCodexPayload("new-key", body);
    expect(await verifyHmacSignature(body, oldSig, ["new-key", "old-key"])).toBe(true);
    expect(await verifyHmacSignature(body, newSig, ["new-key", "old-key"])).toBe(true);
  });

  it("fails closed with no header and with no configured secrets", async () => {
    const sig = await signCodexPayload("s3cret", body);
    expect(await verifyHmacSignature(body, null, ["s3cret"])).toBe(false);
    expect(await verifyHmacSignature(body, sig, [])).toBe(false);
    expect(await verifyHmacSignature(body, sig, [undefined, null, ""])).toBe(false);
  });

  it("rejects a truncated signature rather than prefix-matching it", async () => {
    const sig = await signCodexPayload("s3cret", body);
    expect(await verifyHmacSignature(body, sig.slice(0, 20), ["s3cret"])).toBe(false);
  });
});

describe("verifyCodexSignature", () => {
  const body = '{"event":"scan.started"}';

  it("uses the env secret", async () => {
    process.env.CODEX_SECURITY_WEBHOOK_SECRET = "env-secret";
    const sig = await signCodexPayload("env-secret", body);
    expect(await verifyCodexSignature(body, sig)).toBe(true);
  });

  it("accepts the intake-source fallback secret when no env var is set", async () => {
    const sig = await signCodexPayload("db-secret", body);
    expect(await verifyCodexSignature(body, sig, ["db-secret"])).toBe(true);
  });

  it("rejects everything when no secret is available anywhere", async () => {
    const sig = await signCodexPayload("anything", body);
    expect(await verifyCodexSignature(body, sig)).toBe(false);
  });
});

describe("dispatchCodexScan", () => {
  it("refuses to dispatch without a callback secret", async () => {
    // Dispatching here would start a scan that can never report results,
    // leaving the job hung until the sweeper times it out.
    await expect(
      dispatchCodexScan({
        jobId: "00000000-0000-0000-0000-000000000000",
        repoFullName: "acme/widgets",
        kind: "manual",
        callbackUrl: "https://mc.example/api/public/hooks/codex-security",
        callbackSecret: "",
      }),
    ).rejects.toThrow(/CODEX_SECURITY_WEBHOOK_SECRET/);
  });
});
