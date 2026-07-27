// @ts-nocheck
// Thin HTTP client for OpenAI Codex Security. Server-only.
// The public Codex Security API is not yet GA; the client is designed
// around a small, forward-compatible surface: enqueue a scan, fetch
// status, ingest a webhook payload. Base URL and auth header can be
// overridden via env so we can point at staging or a mock server.

export type CodexScanRequest = {
  jobId: string;
  repoFullName: string;
  ref?: string | null;
  pathGlobs?: string[] | null;
  kind: string;
  callbackUrl: string;
  callbackSecret: string;
  metadata?: Record<string, unknown>;
};

export type CodexScanResponse = {
  externalScanId: string;
  status: string;
};

const BASE_URL =
  process.env.CODEX_SECURITY_BASE_URL || "https://api.openai.com/v1/security";

function apiKey(): string {
  const k = process.env.CODEX_SECURITY_API_KEY;
  if (!k) throw new Error("CODEX_SECURITY_API_KEY not configured");
  return k;
}

export async function enqueueCodexScan(
  req: CodexScanRequest,
): Promise<CodexScanResponse> {
  const res = await fetch(`${BASE_URL}/scans`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_job_id: req.jobId,
      repository: req.repoFullName,
      ref: req.ref ?? undefined,
      path_globs: req.pathGlobs ?? undefined,
      kind: req.kind,
      callback_url: req.callbackUrl,
      callback_secret: req.callbackSecret,
      metadata: req.metadata ?? {},
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Codex enqueue failed [${res.status}]: ${text}`);
  }
  const body = (await res.json()) as { id: string; status: string };
  return { externalScanId: body.id, status: body.status };
}

export async function getCodexScan(externalScanId: string) {
  const res = await fetch(`${BASE_URL}/scans/${externalScanId}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Codex status failed [${res.status}]: ${text}`);
  }
  return res.json();
}

// HMAC-SHA256 signature verification for the webhook.
export async function verifyCodexSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = process.env.CODEX_SECURITY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Support "sha256=<hex>" and bare hex forms.
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;
  if (provided.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
