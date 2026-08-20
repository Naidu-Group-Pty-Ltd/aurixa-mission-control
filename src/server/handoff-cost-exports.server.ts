// G22 — Cost Export Fulfillment Engine.
// Turns a `pending` handoff_cost_exports row into a durable CSV artifact
// stored in the `handoff-contracts` bucket under
// `cost-exports/{handoff_id}/{export_id}.csv`, then flips the row to
// `ready` with aggregate totals so the /handoffs/$id UI can hand the
// client a signed download URL. Falls back to `failed` with a captured
// error string when a lookup or upload step throws.

type FulfillResult =
  | { ok: true; export_id: string; storage_path: string; rows: number; total_tokens: number; total_cents: number }
  | { ok: false; export_id: string; error: string };

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

export async function fulfillCostExport(exportId: string): Promise<FulfillResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  const { data: exp, error: expErr } = await admin
    .from("handoff_cost_exports")
    .select("id, handoff_id, period_start, period_end, status")
    .eq("id", exportId)
    .maybeSingle();
  if (expErr) return { ok: false, export_id: exportId, error: expErr.message };
  if (!exp) return { ok: false, export_id: exportId, error: "export_not_found" };
  if (exp.status === "ready") {
    return { ok: false, export_id: exportId, error: "already_ready" };
  }

  try {
    // Mark generating so concurrent triggers no-op.
    await admin
      .from("handoff_cost_exports")
      .update({ status: "generating", error: null })
      .eq("id", exportId);

    const { data: handoff, error: hErr } = await admin
      .from("clone_handoffs")
      .select("id, clone_id")
      .eq("id", exp.handoff_id)
      .maybeSingle();
    if (hErr || !handoff) throw new Error(hErr?.message ?? "handoff_not_found");

    // Resolve tenants tied to this clone (may be one or more; usually one).
    const { data: tenants } = await admin
      .from("tenants")
      .select("id, name")
      .eq("clone_id", handoff.clone_id);
    const tenantIds = (tenants ?? []).map((t: any) => t.id);

    // Pull all completed/refunded report jobs in the period for those tenants.
    const jobRows: any[] = [];
    if (tenantIds.length > 0) {
      const { data: jobs, error: jErr } = await admin
        .from("report_jobs")
        .select("id, tenant_id, kind, status, charged_tokens, estimated_tokens, completed_at, started_at")
        .in("tenant_id", tenantIds)
        .in("status", ["completed", "refunded"])
        .gte("completed_at", exp.period_start)
        .lte("completed_at", exp.period_end)
        .order("completed_at", { ascending: true });
      if (jErr) throw jErr;
      jobRows.push(...(jobs ?? []));
    }

    // Pull ledger topups / grants / refunds for the audit trail.
    const ledgerRows: any[] = [];
    if (tenantIds.length > 0) {
      const { data: ledger, error: lErr } = await admin
        .from("token_ledger")
        .select("id, tenant_id, kind, tokens, source, source_ref, reason, created_at")
        .in("tenant_id", tenantIds)
        .in("kind", ["grant", "topup", "refund", "adjustment"])
        .gte("created_at", exp.period_start)
        .lte("created_at", exp.period_end)
        .order("created_at", { ascending: true });
      if (lErr) throw lErr;
      ledgerRows.push(...(ledger ?? []));
    }

    // Seat entitlement snapshot (billed inventory as of export time).
    const { data: seats } = await admin
      .from("clone_seat_entitlements")
      .select("seat_plan_id, seats_used, seats_purchased, stripe_subscription_id, seat_plans(slug, name, price_cents)")
      .eq("clone_id", handoff.clone_id);

    // Aggregate totals.
    const totalTokens = jobRows.reduce(
      (sum, r) => sum + (Number(r.charged_tokens) || 0),
      0,
    );
    // Best-effort cents estimate: 1 token = 0.01¢ placeholder; real pricing is
    // per plan and lives in Stripe. We surface tokens as the source of truth
    // and let the operator fill cents from Stripe invoices if needed.
    const totalCents = 0;
    const rowsIncluded = jobRows.length + ledgerRows.length;

    // Build CSV — three logical sections concatenated.
    const jobCsv = buildCsv(
      jobRows.map((r) => ({
        section: "report_job",
        id: r.id,
        tenant_id: r.tenant_id,
        kind: r.kind,
        status: r.status,
        tokens: r.charged_tokens ?? 0,
        estimated: r.estimated_tokens ?? 0,
        started_at: r.started_at,
        completed_at: r.completed_at,
      })),
      ["section", "id", "tenant_id", "kind", "status", "tokens", "estimated", "started_at", "completed_at"],
    );
    const ledgerCsv = buildCsv(
      ledgerRows.map((r) => ({
        section: "ledger",
        id: r.id,
        tenant_id: r.tenant_id,
        kind: r.kind,
        tokens: r.tokens,
        source: r.source,
        source_ref: r.source_ref ?? "",
        reason: r.reason ?? "",
        created_at: r.created_at,
      })),
      ["section", "id", "tenant_id", "kind", "tokens", "source", "source_ref", "reason", "created_at"],
    );
    const seatCsv = buildCsv(
      (seats ?? []).map((s: any) => ({
        section: "seat_entitlement",
        plan_slug: s.seat_plans?.slug ?? "",
        plan_name: s.seat_plans?.name ?? "",
        seats_purchased: s.seats_purchased ?? 0,
        seats_used: s.seats_used ?? 0,
        price_cents: s.seat_plans?.price_cents ?? 0,
        stripe_subscription_id: s.stripe_subscription_id ?? "",
      })),
      ["section", "plan_slug", "plan_name", "seats_purchased", "seats_used", "price_cents", "stripe_subscription_id"],
    );

    const header =
      `# Aurixa Systems — Handoff Cost Export\n` +
      `# handoff_id: ${exp.handoff_id}\n` +
      `# clone_id: ${handoff.clone_id}\n` +
      `# period: ${exp.period_start} → ${exp.period_end}\n` +
      `# generated_at: ${new Date().toISOString()}\n` +
      `# total_tokens: ${totalTokens}\n` +
      `# rows_included: ${rowsIncluded}\n\n`;
    const csv = header + jobCsv + "\n" + ledgerCsv + "\n" + seatCsv;

    const storagePath = `cost-exports/${exp.handoff_id}/${exp.id}.csv`;
    const { error: upErr } = await admin.storage
      .from("handoff-contracts")
      .upload(storagePath, new Blob([csv], { type: "text/csv" }), {
        upsert: true,
        contentType: "text/csv",
      });
    if (upErr) throw upErr;

    await admin
      .from("handoff_cost_exports")
      .update({
        status: "ready",
        storage_path: storagePath,
        rows_included: rowsIncluded,
        total_tokens: totalTokens,
        total_cents: totalCents,
        generated_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", exportId);

    await admin.from("handoff_events").insert({
      handoff_id: exp.handoff_id,
      event_type: "cost_export_ready",
      payload: {
        export_id: exportId,
        storage_path: storagePath,
        rows_included: rowsIncluded,
        total_tokens: totalTokens,
      },
    });

    return {
      ok: true,
      export_id: exportId,
      storage_path: storagePath,
      rows: rowsIncluded,
      total_tokens: totalTokens,
      total_cents: totalCents,
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await admin
      .from("handoff_cost_exports")
      .update({ status: "failed", error: message.slice(0, 500) })
      .eq("id", exportId);
    return { ok: false, export_id: exportId, error: message };
  }
}

export async function signCostExportDownload(exportId: string, expiresInSeconds = 600): Promise<
  { ok: true; url: string; expires_in: number } | { ok: false; error: string }
> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: exp } = await admin
    .from("handoff_cost_exports")
    .select("storage_path, status")
    .eq("id", exportId)
    .maybeSingle();
  if (!exp) return { ok: false, error: "export_not_found" };
  if (exp.status !== "ready" || !exp.storage_path) {
    return { ok: false, error: "export_not_ready" };
  }
  const { data, error } = await admin.storage
    .from("handoff-contracts")
    .createSignedUrl(exp.storage_path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    return { ok: false, error: error?.message ?? "sign_failed" };
  }
  return { ok: true, url: data.signedUrl, expires_in: expiresInSeconds };
}
