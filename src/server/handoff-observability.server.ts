// G20 — Post-handoff observability engine.
// Uses the client-org PAT stored in `client_supabase_accounts` to hit the
// Supabase Management API and snapshot the target project's health into
// `clone_health_beacons`. Called from the /handoffs/$id UI and from the
// hourly cron drain.

const MGMT_API = "https://api.supabase.com/v1";

async function fetchJson(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  let json: any = null;
  try { json = body ? JSON.parse(body) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, body: json, raw: body };
}

export async function pollClientBackendHealth(handoffId: string): Promise<{
  ok: boolean;
  status?: string;
  beacon_id?: string;
  error?: string;
  detail?: string;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  const { data: cfg } = await admin
    .from("handoff_observability_configs")
    .select("id, handoff_id, clone_id, mode, poll_interval_seconds")
    .eq("handoff_id", handoffId)
    .maybeSingle();
  if (!cfg) return { ok: false, error: "config_missing" };
  if (cfg.mode !== "pat_polling") return { ok: false, error: "mode_not_pat_polling" };

  const { data: handoff } = await admin
    .from("clone_handoffs")
    .select("id, clone_id, backend_id, client_account_id")
    .eq("id", handoffId)
    .maybeSingle();
  if (!handoff) return { ok: false, error: "handoff_missing" };

  // Resolve project ref (target twin, else current backend).
  let projectRef: string | null = null;
  if (handoff.backend_id) {
    const { data: be } = await admin
      .from("clone_backends")
      .select("supabase_project_ref")
      .eq("id", handoff.backend_id)
      .maybeSingle();
    projectRef = be?.supabase_project_ref ?? null;
  }
  if (!projectRef) {
    const md = (handoff as any).metadata ?? {};
    projectRef = md?.target_project_ref ?? null;
  }
  if (!projectRef) return { ok: false, error: "project_ref_missing" };

  if (!handoff.client_account_id) return { ok: false, error: "client_account_missing" };
  const { data: acct } = await admin
    .from("client_supabase_accounts")
    .select("pat_ciphertext")
    .eq("id", handoff.client_account_id)
    .maybeSingle();
  if (!acct?.pat_ciphertext) return { ok: false, error: "pat_missing" };

  let pat: string;
  try {
    const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
    pat = decryptSecret(decodeBytea(acct.pat_ciphertext));
  } catch (e: any) {
    return { ok: false, error: "pat_decrypt_failed", detail: String(e?.message ?? e) };
  }

  // Fan out a few Management API reads. Any failure is captured on the
  // beacon; we still record a row so the operator sees the trend.
  const [projectRes, healthRes, usageRes] = await Promise.all([
    fetchJson(`${MGMT_API}/projects/${projectRef}`, pat),
    fetchJson(`${MGMT_API}/projects/${projectRef}/health`, pat),
    fetchJson(`${MGMT_API}/projects/${projectRef}/usage`, pat).catch(() => ({ ok: false, status: 0, body: null, raw: "" })),
  ]);

  const projectStatus = projectRes.body?.status ?? projectRes.body?.state ?? null;
  const dbSize = projectRes.body?.database?.size_bytes ?? usageRes.body?.database?.size ?? null;
  const conns = healthRes.body?.database?.connections ?? healthRes.body?.connections ?? null;
  const storageUsed = usageRes.body?.storage?.size ?? null;
  const invocations = usageRes.body?.edge_functions?.invocations ?? null;

  let severity: "ok" | "warn" | "critical" = "ok";
  const problems: string[] = [];
  if (!projectRes.ok) { severity = "critical"; problems.push(`project=${projectRes.status}`); }
  if (!healthRes.ok) { if (severity !== "critical") severity = "warn"; problems.push(`health=${healthRes.status}`); }
  if (projectStatus && !["ACTIVE_HEALTHY", "ACTIVE", "HEALTHY"].includes(String(projectStatus).toUpperCase())) {
    severity = "warn";
    problems.push(`project_status=${projectStatus}`);
  }

  const message = problems.length ? problems.join(" · ") : "healthy";

  const { data: beacon, error: insertErr } = await admin
    .from("clone_health_beacons")
    .insert({
      clone_id: cfg.clone_id,
      handoff_id: cfg.handoff_id,
      source: "pat_poll",
      project_ref: projectRef,
      project_status: projectStatus ? String(projectStatus) : null,
      db_size_bytes: dbSize ?? null,
      active_connections: conns ?? null,
      storage_used_bytes: storageUsed ?? null,
      edge_invocations_24h: invocations ?? null,
      severity,
      message,
      payload: {
        project: projectRes.body,
        health: healthRes.body,
        usage: usageRes.body,
      },
    })
    .select("id")
    .single();
  if (insertErr) return { ok: false, error: "beacon_insert_failed", detail: insertErr.message };

  const nextPoll = new Date(Date.now() + (cfg.poll_interval_seconds ?? 900) * 1000).toISOString();
  await admin
    .from("handoff_observability_configs")
    .update({
      last_poll_at: new Date().toISOString(),
      next_poll_at: nextPoll,
      last_status: severity,
      last_error: severity === "ok" ? null : message,
      last_snapshot: { project_ref: projectRef, project_status: projectStatus, severity, message },
    })
    .eq("id", cfg.id);

  await admin.from("handoff_events").insert({
    handoff_id: handoffId,
    kind: "observability.polled",
    details: { severity, project_ref: projectRef, project_status: projectStatus, message },
  });

  return { ok: true, status: severity, beacon_id: beacon.id };
}

export async function drainDueObservabilityPolls(limit = 20): Promise<{
  ok: true;
  attempted: number;
  succeeded: number;
  failed: number;
  results: Array<{ handoff_id: string; ok: boolean; error?: string; status?: string }>;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  const { data: due } = await admin
    .from("handoff_observability_configs")
    .select("handoff_id")
    .eq("mode", "pat_polling")
    .or(`next_poll_at.is.null,next_poll_at.lte.${new Date().toISOString()}`)
    .limit(limit);

  const rows = (due ?? []) as Array<{ handoff_id: string }>;
  let succeeded = 0;
  let failed = 0;
  const results: Array<{ handoff_id: string; ok: boolean; error?: string; status?: string }> = [];
  for (const r of rows) {
    try {
      const res = await pollClientBackendHealth(r.handoff_id);
      if (res.ok) { succeeded++; results.push({ handoff_id: r.handoff_id, ok: true, status: res.status }); }
      else { failed++; results.push({ handoff_id: r.handoff_id, ok: false, error: res.error }); }
    } catch (e: any) {
      failed++;
      results.push({ handoff_id: r.handoff_id, ok: false, error: String(e?.message ?? e) });
    }
  }
  return { ok: true, attempted: rows.length, succeeded, failed, results };
}
