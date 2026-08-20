import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DEFAULT_LIMIT = 60; // per minute per key

// `retry_after_seconds` is present on both members (optional on success) so call
// sites can read it after an `if (!rl.ok)` guard without relying on
// discriminated-union narrowing. That was written when the project compiled
// without strictNullChecks and narrowing did not hold; the flag is on now, so
// this shape is belt-and-braces rather than load-bearing. It is only populated
// when `ok` is false.
export type RateLimitResult =
  | { ok: true; count: number; limit: number; retry_after_seconds?: undefined }
  | { ok: false; count: number; limit: number; retry_after_seconds: number };

/**
 * Increment + check the per-key per-minute rate limit. Backed by
 * `public.check_api_rate_limit` so two replicas share state.
 *
 * Fails CLOSED on DB error — better to short-circuit a few legitimate
 * requests than allow unbounded traffic when the limiter store is down.
 */
export async function checkRateLimit(
  keyId: string,
  limit = DEFAULT_LIMIT,
): Promise<RateLimitResult> {
  const { data, error } = await supabaseAdmin.rpc("check_api_rate_limit", {
    _key_id: keyId,
    _limit: limit,
  });
  if (error) {
    console.error("[rate-limit] DB error, failing closed:", error.message);
    return { ok: false, count: 0, limit, retry_after_seconds: 5 };
  }
  return data as RateLimitResult;
}
