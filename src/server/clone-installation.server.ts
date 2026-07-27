// Resolving a clone's GitHub App installation, tolerantly.
//
// `clones.github_app_installation_id` is added by
// 20260727140000_codex_security_engine_live.sql. Several call sites already
// selected it before it existed, and PostgREST answers a select naming an
// unknown column with a 400 for the WHOLE query — so the rows came back null
// and the callers concluded "no clone", "no repo", or "no fleet". That is how
// a single missing column silently disabled clone scans, clone remediations,
// and the settings page's Actions secret sync at once.
//
// Fetching the column separately keeps one optional field from taking the
// rest of the row down with it: if the column is absent, every clone simply
// resolves to `null`, which is the documented "use GITHUB_APP_INSTALLATION_ID"
// fallback.

/** Logged once per process so a pre-migration deployment isn't spammy. */
let warned = false;

function warnOnce(detail: string) {
  if (warned) return;
  warned = true;
  console.warn(
    `[clone-installation] clones.github_app_installation_id unavailable (${detail}). ` +
      `Falling back to GITHUB_APP_INSTALLATION_ID for every clone. ` +
      `Apply migration 20260727140000_codex_security_engine_live.sql to enable ` +
      `per-clone installations.`,
  );
}

/**
 * Map of clone id → installation id. Clones with no override, and every
 * clone when the column does not exist, are absent from the map.
 */
export async function loadCloneInstallationIds(
  client: any,
  cloneIds?: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    let query = client.from("clones").select("id, github_app_installation_id");
    if (cloneIds?.length) query = query.in("id", cloneIds);
    const { data, error } = await query;
    if (error) {
      warnOnce(error.message);
      return map;
    }
    for (const row of data ?? []) {
      if (row?.id && row.github_app_installation_id) {
        map.set(row.id, String(row.github_app_installation_id));
      }
    }
  } catch (e) {
    warnOnce(e instanceof Error ? e.message : String(e));
  }
  return map;
}

/** Installation id for one clone, or null to use the default installation. */
export async function loadCloneInstallationId(
  client: any,
  cloneId: string,
): Promise<string | null> {
  const map = await loadCloneInstallationIds(client, [cloneId]);
  return map.get(cloneId) ?? null;
}
