// Subdomain hosting server functions.
// Runs dormant until platform_hosting_config.cloudflare_zone_id and
// CLOUDFLARE_API_TOKEN are populated: enqueue calls still succeed and mark
// the clone `pending_platform`, so the moment Cloudflare comes online the
// backlog drains automatically.
//
// Admin-gated. All actual DNS writes flow through the existing
// edge_provisioning_jobs queue + /hooks/edge-drain worker (see
// worker action handlers).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import crypto from "crypto";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cloudflareApi, CloudflareError } from "@/server/cloudflare/client";

const admin = supabaseAdmin as any;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function payloadHash(p: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(p ?? {}))
    .digest("hex");
}

async function loadPlatformConfig() {
  const { data } = await admin
    .from("platform_hosting_config")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();
  return data as any;
}

// ── Platform config (admin) ─────────────────────────────────────────────────
export const getPlatformHostingConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const cfg = await loadPlatformConfig();
    return {
      config: cfg ?? null,
      cloudflareTokenConfigured: Boolean(process.env.CLOUDFLARE_API_TOKEN),
      ready: Boolean(cfg?.cloudflare_zone_id && process.env.CLOUDFLARE_API_TOKEN),
    };
  });

export const updatePlatformHostingConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        primary_domain: z.string().min(3).max(253).optional(),
        cloudflare_account_id: z.string().nullable().optional(),
        cloudflare_zone_id: z.string().nullable().optional(),
        cloudflare_zone_name: z.string().nullable().optional(),
        target_type: z.enum(["a", "cname"]).optional(),
        target_value: z.string().min(1).optional(),
        proxied: z.boolean().optional(),
        auto_provision: z.boolean().optional(),
        subdomain_pattern: z.string().optional(),
        reserved_slugs: z.array(z.string()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {
      ...data,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    };
    const { data: row, error } = await admin
      .from("platform_hosting_config")
      .update(patch)
      .eq("singleton", true)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, config: row };
  });

// ── Availability check ──────────────────────────────────────────────────────
export const checkSubdomainAvailability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { slug: string; excludeCloneId?: string }) =>
    z
      .object({ slug: z.string().min(1).max(63), excludeCloneId: z.string().uuid().optional() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const slug = data.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      return { ok: false as const, reason: "invalid_format" };
    }
    const cfg = await loadPlatformConfig();
    const reserved: string[] = cfg?.reserved_slugs ?? [];
    if (reserved.includes(slug)) return { ok: false as const, reason: "reserved" };
    const q = admin.from("clones").select("id, subdomain").eq("subdomain", slug);
    const { data: hits } = await q;
    const conflict = (hits ?? []).find((r: any) => r.id !== data.excludeCloneId);
    if (conflict) return { ok: false as const, reason: "taken" };
    return {
      ok: true as const,
      fqdn: cfg ? `${slug}.${cfg.primary_domain}` : `${slug}.aurixasystems.com.au`,
    };
  });

// ── Enqueue subdomain provisioning ──────────────────────────────────────────
// Idempotent by (clone_id, action, payload_hash). Also stamps the desired
// subdomain onto the clone row so the UI shows intent even before CF is live.
export const requestCloneSubdomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string; slug: string }) =>
    z.object({ cloneId: z.string().uuid(), slug: z.string().min(1).max(63) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const slug = data.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error("invalid_subdomain");
    const cfg = await loadPlatformConfig();
    if (!cfg) throw new Error("platform_hosting_config_missing");
    if ((cfg.reserved_slugs ?? []).includes(slug)) throw new Error("subdomain_reserved");

    const fqdn = `${slug}.${cfg.primary_domain}`;
    const ready = Boolean(cfg.cloudflare_zone_id && process.env.CLOUDFLARE_API_TOKEN);

    const { error: upErr } = await admin
      .from("clones")
      .update({
        subdomain: slug,
        subdomain_fqdn: fqdn,
        subdomain_status: ready ? "queued" : "pending_platform",
      })
      .eq("id", data.cloneId);
    if (upErr) throw new Error(upErr.message);

    if (!ready) {
      // Dormant: don't enqueue a job we know will fail; the settings-page
      // "reconcile" action fans out once the token + zone land.
      return { ok: true as const, status: "pending_platform" as const, fqdn };
    }

    const payload = {
      subdomain: slug,
      fqdn,
      zoneId: cfg.cloudflare_zone_id,
      recordType: cfg.target_type === "cname" ? "CNAME" : "A",
      recordContent: cfg.target_value,
      proxied: cfg.proxied,
    };
    const hash = payloadHash(payload);
    const { data: job, error } = await admin
      .from("edge_provisioning_jobs")
      .upsert(
        {
          clone_id: data.cloneId,
          provider_slug: "cloudflare",
          action: "provision_subdomain",
          payload,
          payload_hash: hash,
          status: "queued",
          created_by: context.userId,
        },
        { onConflict: "clone_id,provider_slug,action,payload_hash" },
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, status: "queued" as const, fqdn, jobId: job?.id };
  });

// ── Detach subdomain ────────────────────────────────────────────────────────
export const detachCloneSubdomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const cfg = await loadPlatformConfig();
    const ready = Boolean(cfg?.cloudflare_zone_id && process.env.CLOUDFLARE_API_TOKEN);
    if (!ready) {
      await admin
        .from("clones")
        .update({ subdomain: null, subdomain_fqdn: null, subdomain_status: "detached" })
        .eq("id", data.cloneId);
      return { ok: true as const, status: "detached" as const };
    }
    const payload = { zoneId: cfg.cloudflare_zone_id };
    const { data: job, error } = await admin
      .from("edge_provisioning_jobs")
      .upsert(
        {
          clone_id: data.cloneId,
          provider_slug: "cloudflare",
          action: "deprovision_subdomain",
          payload,
          payload_hash: payloadHash(payload),
          status: "queued",
          created_by: context.userId,
        },
        { onConflict: "clone_id,provider_slug,action,payload_hash" },
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, status: "queued" as const, jobId: job?.id };
  });

// ── Reconcile: called after CF token/zone is populated, fans out pending
//    subdomains into real jobs.
export const reconcilePendingSubdomains = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async ({ context }) => {
    const cfg = await loadPlatformConfig();
    if (!cfg?.cloudflare_zone_id || !process.env.CLOUDFLARE_API_TOKEN) {
      return { ok: false as const, error: "platform_not_ready" };
    }
    const { data: pending } = await admin
      .from("clones")
      .select("id, subdomain, subdomain_fqdn")
      .eq("subdomain_status", "pending_platform");
    let enqueued = 0;
    for (const row of pending ?? []) {
      const payload = {
        subdomain: row.subdomain,
        fqdn: row.subdomain_fqdn ?? `${row.subdomain}.${cfg.primary_domain}`,
        zoneId: cfg.cloudflare_zone_id,
        recordType: cfg.target_type === "cname" ? "CNAME" : "A",
        recordContent: cfg.target_value,
        proxied: cfg.proxied,
      };
      await admin.from("edge_provisioning_jobs").upsert(
        {
          clone_id: row.id,
          provider_slug: "cloudflare",
          action: "provision_subdomain",
          payload,
          payload_hash: payloadHash(payload),
          status: "queued",
          created_by: context.userId,
        },
        { onConflict: "clone_id,provider_slug,action,payload_hash" },
      );
      await admin.from("clones").update({ subdomain_status: "queued" }).eq("id", row.id);
      enqueued++;
    }
    return { ok: true as const, enqueued };
  });

export const listCloneSubdomains = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data } = await admin
      .from("clones")
      .select("id, name, slug, subdomain, subdomain_fqdn, subdomain_status")
      .not("subdomain", "is", null)
      .order("subdomain", { ascending: true });
    return { rows: data ?? [] };
  });

// ── Cutover verification ────────────────────────────────────────────────────
// Runs three live checks against Cloudflare so operators can see exactly
// which cutover step is complete before hitting "Reconcile pending":
//   1. token present + valid (verify endpoint)
//   2. Zone:Read scope (get zone by id)
//   3. DNS:Edit scope (list DNS records for the zone — read-list is under DNS:Edit)
// Non-destructive: no writes are performed. Returns per-step status so the
// UI can render green/red pips instead of one opaque "Live" badge.
export const verifyCloudflareSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const cfg = await loadPlatformConfig();
    const tokenPresent = Boolean(process.env.CLOUDFLARE_API_TOKEN);

    const steps = {
      token: { ok: false as boolean, detail: "" as string },
      zoneRead: { ok: false as boolean, detail: "" as string },
      dnsEdit: { ok: false as boolean, detail: "" as string },
    };

    if (!tokenPresent) {
      steps.token.detail = "CLOUDFLARE_API_TOKEN secret not configured";
      return { ok: false as const, ready: false, steps, config: cfg };
    }

    try {
      const v = await cloudflareApi.verifyToken();
      steps.token.ok = v.status === "active";
      steps.token.detail = v.status === "active" ? "Token active" : `Token status: ${v.status}`;
    } catch (e) {
      steps.token.detail = e instanceof CloudflareError ? e.message : "Token verification failed";
      return { ok: false as const, ready: false, steps, config: cfg };
    }

    if (!cfg?.cloudflare_zone_id) {
      steps.zoneRead.detail = "Zone ID not set in platform config";
      steps.dnsEdit.detail = "Zone ID required to test DNS scope";
      return { ok: false as const, ready: false, steps, config: cfg };
    }

    try {
      const zone = await cloudflareApi.getZone(cfg.cloudflare_zone_id);
      steps.zoneRead.ok = true;
      steps.zoneRead.detail = `Zone: ${zone.name} (${zone.status})`;
    } catch (e) {
      steps.zoneRead.detail =
        e instanceof CloudflareError ? e.message : "Zone read failed — check Zone:Read scope";
      return { ok: false as const, ready: false, steps, config: cfg };
    }

    try {
      const records = await cloudflareApi.listDnsRecords(cfg.cloudflare_zone_id);
      steps.dnsEdit.ok = true;
      steps.dnsEdit.detail = `DNS API reachable (${Array.isArray(records) ? records.length : 0} record(s) sampled)`;
    } catch (e) {
      steps.dnsEdit.detail =
        e instanceof CloudflareError ? e.message : "DNS list failed — check DNS:Edit scope";
      return { ok: false as const, ready: false, steps, config: cfg };
    }

    return {
      ok: true as const,
      ready: steps.token.ok && steps.zoneRead.ok && steps.dnsEdit.ok,
      steps,
      config: cfg,
    };
  });

// Count of clones sitting in pending_platform — powers the reconcile CTA.
export const countPendingSubdomains = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const { count } = await admin
      .from("clones")
      .select("id", { count: "exact", head: true })
      .eq("subdomain_status", "pending_platform");
    return { pending: count ?? 0 };
  });
