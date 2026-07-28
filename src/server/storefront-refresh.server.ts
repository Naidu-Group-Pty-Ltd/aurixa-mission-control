// Refreshes the Aurixa Systems storefront's read mirror, on demand.
//
// The mirror is meant to refresh within seconds of a catalog change: a
// statement trigger on each catalog table calls the storefront's `catalog-sync`
// function, and a 15-minute cron on the storefront side is the backstop. That
// arrangement failed silently — the trigger reads its URL and token from Vault
// secrets that were never created, and no-ops when either is missing — so for
// weeks every catalog change was invisible to the pricing page until the cron
// caught up. The top-up cutover landed at 21:38 and the page kept advertising
// the old packs until 21:45.
//
// The migration alongside this fixes the trigger. This exists because a
// cutover should not depend on it: when an operator presses Apply, the
// storefront should be refreshed by the same action, and the operator should
// be told whether it worked. A backstop nobody can see is how six minutes of
// stale prices went unnoticed.
//
// Note on the token: `catalog-sync` is called with the storefront's PUBLISHABLE
// (anon) key. That key is shipped in the storefront's own browser bundle and is
// public by design — it is here to satisfy the API gateway's JWT check, not to
// authorise anything. The function only ever pulls Mission Control's public
// catalog and writes the storefront mirror; it cannot write back here.

const DEFAULT_SYNC_URL = "https://moeyytuduycrvvncdtme.supabase.co/functions/v1/catalog-sync";

const DEFAULT_SYNC_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vZXl5dHVkdXljcnZ2bmNkdG1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjU0MjUsImV4cCI6MjA5OTYwMTQyNX0.gt65ttGRZJDRPuBlIkBP5RrJHHz1Mex94O62bKPdU8w";

export type RefreshResult = {
  ok: boolean;
  /** Rows mirrored per table, when the sync reported them. */
  counts?: Record<string, number>;
  error?: string;
};

/**
 * How long to wait before giving up.
 *
 * The sync re-pulls six tables and writes them, so it is not instant — but a
 * cutover must not hang on it either. On timeout the catalog change has still
 * happened; only the mirror is behind, and the cron will catch it.
 */
const TIMEOUT_MS = 15_000;

/**
 * Asks the storefront to re-pull the catalog now.
 *
 * Never throws. A refresh failure is not a cutover failure — the prices are
 * already correct in Mission Control, and the mirror is at worst 15 minutes
 * behind — so callers report this alongside their own result rather than
 * treating it as an error.
 */
export async function refreshStorefrontMirror(): Promise<RefreshResult> {
  const url = process.env.STOREFRONT_CATALOG_SYNC_URL || DEFAULT_SYNC_URL;
  const token = process.env.STOREFRONT_CATALOG_SYNC_TOKEN || DEFAULT_SYNC_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
      signal: controller.signal,
    });

    // A non-JSON body means something in front of the function answered — an
    // auth gateway, a proxy, an error page. Say so with the status rather than
    // letting a parse failure surface as "Unexpected token <".
    const raw = await res.text();
    let body: { ok?: boolean; error?: string; counts?: Record<string, number> } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return {
        ok: false,
        error: `storefront_sync_http_${res.status}: ${raw.slice(0, 120)}`,
      };
    }

    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error ?? `storefront_sync_http_${res.status}` };
    }
    return { ok: true, counts: body.counts };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `storefront_sync_timeout after ${TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One line an operator can act on, for either outcome. */
export function describeRefresh(r: RefreshResult, subject = "catalog"): string {
  if (r.ok) {
    const packs = r.counts?.catalog_packs;
    const plans = r.counts?.catalog_plans;
    const detail =
      packs !== undefined || plans !== undefined
        ? ` (${[
            plans !== undefined ? `${plans} plans` : null,
            packs !== undefined ? `${packs} packs` : null,
          ]
            .filter(Boolean)
            .join(", ")})`
        : "";
    return `Storefront pricing page refreshed${detail}.`;
  }
  return `The ${subject} is live here, but the storefront mirror did not refresh: ${r.error}. It will catch up within 15 minutes.`;
}
