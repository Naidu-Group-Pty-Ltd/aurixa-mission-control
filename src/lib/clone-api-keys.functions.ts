import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateApiKey } from "@/server/clone-api-keys.server";
import { fireTokenWebhook } from "@/server/token-webhooks.server";
import { cascadeApiKeyToRepo } from "@/server/clone-credentials.server";

export const listCloneApiKeys = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ cloneId: z.string().uuid().optional() }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("clone_api_keys")
      .select(
        "id, clone_id, label, key_prefix, scopes, revoked_at, revoke_at, rotated_from, rotated_to, last_used_at, first_used_at, created_at, clones:clone_id(id, name, slug)",
      )
      .order("created_at", { ascending: false });
    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { keys: rows ?? [] };
  });

export const createCloneApiKey = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        cloneId: z.string().uuid().nullable().optional(),
        label: z.string().min(1).max(120),
        scopes: z.array(z.string().min(1).max(64)).min(1).max(10).default(["tokens:meter"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { raw, hash, prefix } = generateApiKey();
    const { error } = await supabaseAdmin.from("clone_api_keys").insert({
      clone_id: data.cloneId ?? null,
      label: data.label,
      scopes: data.scopes,
      key_hash: hash,
      key_prefix: prefix,
      created_by: context.userId,
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, key: raw, prefix };
  });

export const revokeCloneApiKey = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: key } = await supabaseAdmin
      .from("clone_api_keys")
      .select("id, clone_id, label, key_prefix")
      .eq("id", data.id)
      .maybeSingle();
    const { error } = await supabaseAdmin
      .from("clone_api_keys")
      .update({ revoked_at: new Date().toISOString(), revoke_at: null })
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    if (key) {
      void fireTokenWebhook(
        "tokens.key.revoked",
        { key_id: key.id, key_prefix: key.key_prefix, label: key.label },
        key.clone_id,
      );
    }
    return { ok: true as const };
  });

export const rotateCloneApiKey = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        oldKeyId: z.string().uuid(),
        graceHours: z
          .number()
          .int()
          .min(0)
          .max(24 * 30)
          .default(24),
        label: z.string().min(1).max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: old, error: oldErr } = await supabaseAdmin
      .from("clone_api_keys")
      .select("id, clone_id, label, scopes")
      .eq("id", data.oldKeyId)
      .maybeSingle();
    if (oldErr) return { ok: false as const, error: oldErr.message };
    if (!old) return { ok: false as const, error: "Original key not found" };

    const { raw, hash, prefix } = generateApiKey();
    const insert = await supabaseAdmin
      .from("clone_api_keys")
      .insert({
        clone_id: old.clone_id,
        label: data.label ?? `${old.label ?? "key"} (rotated)`,
        scopes: old.scopes,
        key_hash: hash,
        key_prefix: prefix,
        created_by: context.userId,
        rotated_from: old.id,
      })
      .select("id")
      .single();
    if (insert.error) return { ok: false as const, error: insert.error.message };

    const newId = insert.data.id;
    const revokeAt = new Date(Date.now() + data.graceHours * 3600_000).toISOString();
    await supabaseAdmin
      .from("clone_api_keys")
      .update({ rotated_to: newId, revoke_at: revokeAt })
      .eq("id", old.id);

    // Re-cascade the new key to the clone's repo (best effort).
    let cascadeResult: {
      ok: boolean;
      path: string;
      error?: string;
      commit_sha?: string | null;
    } | null = null;
    if (old.clone_id) {
      const { data: clone } = await supabaseAdmin
        .from("clones")
        .select("name, github_owner, github_repo, default_branch, github_url")
        .eq("id", old.clone_id)
        .maybeSingle();
      if (clone?.github_url && clone.github_owner && clone.github_repo) {
        cascadeResult = await cascadeApiKeyToRepo({
          owner: clone.github_owner,
          repo: clone.github_repo,
          branch: clone.default_branch || "main",
          apiKey: raw,
          apiKeyPrefix: prefix,
          reason: "rotation",
          metadata: { clone_id: old.clone_id, old_key_id: old.id, source: "mission_control" },
        });
      }

      // Notify Mission Control with the full new key (one-time reveal in the
      // notification drawer) so the operator can confirm the rotation.
      await supabaseAdmin.from("notifications").insert({
        kind: "tokens_key_rotated",
        severity: cascadeResult?.ok === false ? "warning" : "info",
        title: `API key rotated for ${clone?.name ?? "clone"}`,
        body: cascadeResult?.ok
          ? `New prefix ${prefix}… cascaded to repo. Old key revokes at ${new Date(revokeAt).toLocaleString()}.`
          : cascadeResult
            ? `New prefix ${prefix}… created but repo cascade failed: ${cascadeResult.error ?? "unknown"}.`
            : `New prefix ${prefix}… created. Old key revokes at ${new Date(revokeAt).toLocaleString()}.`,
        clone_id: old.clone_id,
        url: `/settings/billing`,
        metadata: {
          old_key_id: old.id,
          new_key_id: newId,
          new_key_prefix: prefix,
          new_key_secret: raw,
          revoke_at: revokeAt,
          grace_hours: data.graceHours,
          repo_cascade: cascadeResult,
          source: "mission_control",
        },
      });
    }

    void fireTokenWebhook(
      "tokens.key.rotated",
      {
        old_key_id: old.id,
        new_key_id: newId,
        new_key_prefix: prefix,
        revoke_at: revokeAt,
        grace_hours: data.graceHours,
        repo_cascade: cascadeResult,
      },
      old.clone_id,
    );

    return { ok: true as const, key: raw, prefix, newId, revokeAt, repoCascade: cascadeResult };
  });
