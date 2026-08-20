// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// G23 — Audit log continuity / outbound audit shipper.
//
// After a handoff cutover, Aurixa loses row-level visibility into the
// client-owned backend. G23 provisions a signed, one-way audit event
// pipeline: the client backend runs a bundled shipper (SQL + pg_cron +
// pg_net) that batches new `audit_log` rows and POSTs them to Mission
// Control's ingest endpoint, signed with a per-handoff HMAC secret.
//
// This module exposes the admin control plane: create/toggle/rotate the
// shipper config, read recent shipped events, and generate the installer
// SQL the operator hands to the client to bootstrap the shipper inside
// their transferred project.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

function siteOrigin() {
  return (
    process.env.SITE_URL ||
    process.env.PUBLIC_SITE_URL ||
    "https://mission-control.aurixasystems.com.au"
  ).replace(/\/+$/, "");
}

function genSecret() {
  return randomBytes(32).toString("hex");
}

export const getAuditShipper = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) => z.object({ handoff_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const [cfg, events, count] = await Promise.all([
      context.supabase
        .from("handoff_audit_shippers")
        .select("*")
        .eq("handoff_id", data.handoff_id)
        .maybeSingle(),
      context.supabase
        .from("handoff_audit_events")
        .select("*")
        .eq("handoff_id", data.handoff_id)
        .order("received_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("handoff_audit_events")
        .select("id", { count: "exact", head: true })
        .eq("handoff_id", data.handoff_id),
    ]);
    return {
      config: cfg.data ?? null,
      events: events.data ?? [],
      total_events: count.count ?? 0,
      ingest_url: `${siteOrigin()}/api/public/handoff/audit-ingest`,
    };
  });

export const upsertAuditShipper = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        enabled: z.boolean().optional(),
        endpoint_url: z.string().url().optional(),
        filter: z.record(z.any()).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: existing } = await context.supabase
      .from("handoff_audit_shippers")
      .select("id, hmac_secret")
      .eq("handoff_id", data.handoff_id)
      .maybeSingle();

    const endpoint = data.endpoint_url || `${siteOrigin()}/api/public/handoff/audit-ingest`;

    if (existing) {
      const patch: Record<string, unknown> = {};
      if (data.enabled !== undefined) patch.enabled = data.enabled;
      if (data.endpoint_url) patch.endpoint_url = data.endpoint_url;
      if (data.filter) patch.filter = data.filter;
      const { data: row, error } = await context.supabase
        .from("handoff_audit_shippers")
        .update(patch)
        .eq("id", existing.id)
        .select("*")
        .single();
      if (error) throw error;
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        event_type: "audit_shipper_updated",
        payload: patch,
      });
      return { ok: true, config: row };
    }

    const { data: row, error } = await context.supabase
      .from("handoff_audit_shippers")
      .insert({
        handoff_id: data.handoff_id,
        enabled: data.enabled ?? false,
        endpoint_url: endpoint,
        hmac_secret: genSecret(),
        filter: data.filter ?? {},
      })
      .select("*")
      .single();
    if (error) throw error;
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      event_type: "audit_shipper_created",
      payload: { endpoint_url: endpoint },
    });
    return { ok: true, config: row };
  });

export const rotateAuditSecret = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) => z.object({ handoff_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_audit_shippers")
      .update({ hmac_secret: genSecret(), last_error: null })
      .eq("handoff_id", data.handoff_id)
      .select("*")
      .single();
    if (error) throw error;
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      event_type: "audit_shipper_secret_rotated",
      payload: {},
    });
    return { ok: true, config: row };
  });

export const getAuditInstallerSQL = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((i) => z.object({ handoff_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: cfg, error } = await context.supabase
      .from("handoff_audit_shippers")
      .select("*")
      .eq("handoff_id", data.handoff_id)
      .maybeSingle();
    if (error) throw error;
    if (!cfg) return { ok: false as const, error: "shipper_not_configured" };

    const url = cfg.endpoint_url;
    const secret = cfg.hmac_secret;
    const handoffId = cfg.handoff_id;

    // Installer SQL for the client-owned backend. Idempotent: safe to run
    // multiple times. Uses pg_net + pg_cron already required by other
    // Aurixa module code, and encode_hmac from pgcrypto.
    const sql = `-- Aurixa Audit Shipper (G23) — install into the client-owned Supabase project.
-- Ships new rows from public.audit_log to Mission Control every minute,
-- signed with a per-handoff HMAC secret. Idempotent.

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS aurixa;

CREATE TABLE IF NOT EXISTS aurixa.audit_shipper_config (
  id INT PRIMARY KEY DEFAULT 1,
  handoff_id UUID NOT NULL,
  endpoint_url TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  last_shipped_id BIGINT NOT NULL DEFAULT 0,
  last_shipped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO aurixa.audit_shipper_config (id, handoff_id, endpoint_url, hmac_secret)
VALUES (1, '${handoffId}'::uuid, ${quoteLit(url)}, ${quoteLit(secret)})
ON CONFLICT (id) DO UPDATE
  SET handoff_id = EXCLUDED.handoff_id,
      endpoint_url = EXCLUDED.endpoint_url,
      hmac_secret = EXCLUDED.hmac_secret,
      updated_at = now();

CREATE OR REPLACE FUNCTION aurixa.ship_audit_events(_batch INT DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, aurixa
AS $fn$
DECLARE
  _cfg aurixa.audit_shipper_config%ROWTYPE;
  _rows jsonb;
  _max_id BIGINT;
  _count INT;
  _body text;
  _sig text;
BEGIN
  SELECT * INTO _cfg FROM aurixa.audit_shipper_config WHERE id = 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_configured'); END IF;

  SELECT jsonb_agg(row_to_json(t) ORDER BY t.id), MAX(t.id), COUNT(*)
    INTO _rows, _max_id, _count
  FROM (
    SELECT id, created_at, action, actor_id, target, metadata
      FROM public.audit_log
     WHERE id > _cfg.last_shipped_id
     ORDER BY id ASC
     LIMIT _batch
  ) t;

  IF _count IS NULL OR _count = 0 THEN
    RETURN jsonb_build_object('ok', true, 'shipped', 0);
  END IF;

  _body := jsonb_build_object(
    'handoff_id', _cfg.handoff_id,
    'project_ref', current_setting('cluster.name', true),
    'events', _rows
  )::text;

  _sig := encode(hmac(_body, _cfg.hmac_secret, 'sha256'), 'hex');

  PERFORM net.http_post(
    url := _cfg.endpoint_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-handoff-id', _cfg.handoff_id::text,
      'x-handoff-signature', _sig
    ),
    body := _body::jsonb
  );

  UPDATE aurixa.audit_shipper_config
     SET last_shipped_id = _max_id,
         last_shipped_at = now(),
         updated_at = now()
   WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'shipped', _count, 'up_to_id', _max_id);
END;
$fn$;

-- Schedule minute-by-minute drain. Unschedule any prior version first.
DO $sched$
BEGIN
  PERFORM cron.unschedule('aurixa-audit-ship') FROM cron.job WHERE jobname = 'aurixa-audit-ship';
  PERFORM cron.schedule('aurixa-audit-ship', '* * * * *', 'SELECT aurixa.ship_audit_events(500);');
END;
$sched$;
`;

    return { ok: true as const, sql, endpoint_url: url, handoff_id: handoffId };
  });

function quoteLit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}
