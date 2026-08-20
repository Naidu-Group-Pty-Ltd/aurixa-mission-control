// Shared authentication for cron / scheduled-hook endpoints (src/routes/hooks.*).
//
// The hooks previously accepted the Supabase *publishable* key, which is PUBLIC
// (it ships in the client bundle), so those privileged endpoints were
// effectively unauthenticated. This requires a dedicated, non-public shared
// secret and compares it in constant time, failing closed if none is set.
//
// Accepts CRON_SECRET (preferred) or DRIFT_REFRESH_TOKEN (the value pg_cron
// injects from Supabase Vault), so either rollout configuration works.
import crypto from "crypto";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time string comparison; a length mismatch returns false up front
// (timingSafeEqual requires equal-length buffers).
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// `response` is present on both members (optional on success) so call sites can
// read `auth.response` after an `if (!auth.ok)` guard without relying on
// discriminated-union narrowing. That was written when the project compiled
// without strictNullChecks and narrowing did not hold; the flag is on now, so
// this shape is belt-and-braces rather than load-bearing. On success it is
// simply absent.
export type CronAuthResult = { ok: true; response?: undefined } | { ok: false; response: Response };

/**
 * Verify a scheduled-hook request carries the shared cron secret as a Bearer
 * token. Returns `{ ok: true }` when authorized, otherwise `{ ok: false,
 * response }` with the 401/500 the handler should return immediately.
 */
export function verifyCronAuth(request: Request): CronAuthResult {
  const secrets = [process.env.CRON_SECRET, process.env.DRIFT_REFRESH_TOKEN].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (secrets.length === 0) {
    return { ok: false, response: jsonResponse({ error: "cron_secret_not_configured" }, 500) };
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || !secrets.some((secret) => timingSafeEqualStr(token, secret))) {
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  }
  return { ok: true };
}
