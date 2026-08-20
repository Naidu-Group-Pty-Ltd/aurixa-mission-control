// G7 — per-clone Stripe routing.

//
// A handed-off (or otherwise isolated) clone can point its own Stripe webhook
// at /api/public/stripe/webhook/<cloneId>. This module owns the CRUD +
// rotation surface for those per-clone configs. The webhook secret is
// stored ciphertext-only using the shared encryptSecret helper — the
// plaintext value is passed to Stripe once by the operator and then discarded
// on our side. Only admins may read/write these rows (RLS enforced), and only
// the last-4 characters of the secret are surfaced back to the UI.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import type { Database, Json } from "@/integrations/supabase/types";

type CloneStripeRow = {
  clone_id: string;
  mode: "platform" | "own_account" | "connect";
  stripe_account_id: string | null;
  webhook_secret_last4: string | null;
  forward_url: string | null;
  status: "pending" | "active" | "rotated" | "revoked";
  activated_at: string | null;
  rotated_at: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

function computeWebhookUrl(cloneId: string): string {
  // Prefer explicit env, else fall back to the Lovable published URL.
  const base =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
    process.env.SITE_URL?.replace(/\/$/, "") ||
    "https://aurixa-mission-control.lovable.app";
  return `${base}/api/public/stripe/webhook/${cloneId}`;
}

export const getCloneStripeConfig = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ cloneId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("clone_stripe_configs")
      .select(
        "clone_id, mode, stripe_account_id, webhook_secret_last4, forward_url, status, activated_at, rotated_at, metadata, created_at, updated_at",
      )
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    if (error) throw error;
    return {
      ok: true as const,
      config: (row as CloneStripeRow | null) ?? null,
      webhook_url: computeWebhookUrl(data.cloneId),
    };
  });

export const listCloneStripeConfigs = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("clone_stripe_configs")
      .select(
        "clone_id, mode, stripe_account_id, webhook_secret_last4, forward_url, status, activated_at, rotated_at, updated_at",
      )
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return { ok: true as const, rows: (data ?? []) as CloneStripeRow[] };
  });

export const upsertCloneStripeConfig = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid(),
        mode: z.enum(["platform", "own_account", "connect"]),
        stripe_account_id: z.string().trim().min(1).max(200).nullable().optional(),
        webhook_secret: z.string().min(16).max(512).nullable().optional(),
        forward_url: z.string().url().max(2048).nullable().optional(),
        metadata: z.record(z.any()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Database["public"]["Tables"]["clone_stripe_configs"]["Insert"] = {
      clone_id: data.cloneId,
      mode: data.mode,
      stripe_account_id: data.stripe_account_id ?? null,
      forward_url: data.forward_url ?? null,
      metadata: (data.metadata ?? {}) as Json,
      created_by: context.userId,
    };

    if (data.webhook_secret) {
      const { encryptSecret } = await import("@/server/crypto.server");
      patch.webhook_secret_ciphertext = encryptSecret(data.webhook_secret);
      patch.webhook_secret_last4 = data.webhook_secret.slice(-4);
      patch.status = "active";
      patch.activated_at = new Date().toISOString();
    }

    const { data: row, error } = await context.supabase
      .from("clone_stripe_configs")
      .upsert(patch, { onConflict: "clone_id" })
      .select(
        "clone_id, mode, stripe_account_id, webhook_secret_last4, forward_url, status, activated_at, rotated_at, updated_at",
      )
      .single();
    if (error) throw error;

    await context.supabase.from("audit_log").insert({
      action: "clone_stripe.upsert",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        mode: data.mode,
        rotated_webhook: Boolean(data.webhook_secret),
        forward_url_set: Boolean(data.forward_url),
      },
    });

    return {
      ok: true as const,
      config: row as CloneStripeRow,
      webhook_url: computeWebhookUrl(data.cloneId),
    };
  });

// Marks the current webhook secret rotated and clears the ciphertext so the
// next upsert-with-secret call re-activates the row. Emits a
// handoff_secret_rotations entry when a handoff_id is supplied so the
// cutover orchestrator (round 2) can pick up the follow-through.
export const rotateCloneStripeWebhook = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid(),
        handoffId: z.string().uuid().optional(),
        reason: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const { data: row, error } = await context.supabase
      .from("clone_stripe_configs")
      .update({
        status: "rotated" as const,
        webhook_secret_ciphertext: null,
        webhook_secret_last4: null,
        rotated_at: now,
      })
      .eq("clone_id", data.cloneId)
      .select("clone_id, mode, status")
      .maybeSingle();
    if (error) throw error;
    if (!row) return { ok: false as const, error: "config_not_found" };

    if (data.handoffId) {
      const { error: rotErr } = await context.supabase
        .from("handoff_secret_rotations")
        .insert({
          handoff_id: data.handoffId,
          target: "stripe_endpoint" as const,
          key_ref: computeWebhookUrl(data.cloneId),
          status: "pending" as const,
          metadata: { reason: data.reason ?? null, rotated_at: now },
        });
      if (rotErr) {
        // Non-fatal for the rotate itself — surface but don't undo the flip.
        console.error("stripe rotation ledger insert failed", rotErr);
      }
    }

    await context.supabase.from("audit_log").insert({
      action: "clone_stripe.rotate",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { handoff_id: data.handoffId ?? null, reason: data.reason ?? null },
    });

    return {
      ok: true as const,
      webhook_url: computeWebhookUrl(data.cloneId),
      status: "rotated" as const,
    };
  });

export const revokeCloneStripeConfig = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ cloneId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("clone_stripe_configs")
      .update({
        status: "revoked" as const,
        webhook_secret_ciphertext: null,
        webhook_secret_last4: null,
      })
      .eq("clone_id", data.cloneId);
    if (error) throw error;
    await context.supabase.from("audit_log").insert({
      action: "clone_stripe.revoke",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {},
    });
    return { ok: true as const };
  });
