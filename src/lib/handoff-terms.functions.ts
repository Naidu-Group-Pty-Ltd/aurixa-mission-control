// G13 — Canonical terms-versions registry for signed handoff records.
// Admin-only CRUD. Exactly one active version at a time (enforced by a
// partial unique index on the underlying table).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash } from "crypto";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export const listHandoffTermsVersions = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("handoff_terms_versions")
      .select(
        "id, version, title, terms_hash, is_active, effective_at, retired_at, created_at, updated_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    return { ok: true as const, versions: data ?? [] };
  });

export const getHandoffTermsVersion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_terms_versions")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    return { ok: true as const, version: row };
  });

export const getActiveHandoffTermsVersion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("handoff_terms_versions")
      .select("id, version, title, body_md, terms_hash, effective_at")
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    return { ok: true as const, version: data };
  });

export const createHandoffTermsVersion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        version: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9._-]+$/),
        title: z.string().min(1).max(200),
        body_md: z.string().min(20),
        activate: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const terms_hash = hashBody(data.body_md);

    // If activating, deactivate the currently active version first so the
    // partial-unique index stays happy.
    if (data.activate) {
      await context.supabase
        .from("handoff_terms_versions")
        .update({ is_active: false, retired_at: new Date().toISOString() })
        .eq("is_active", true);
    }

    const { data: row, error } = await context.supabase
      .from("handoff_terms_versions")
      .insert({
        version: data.version,
        title: data.title,
        body_md: data.body_md,
        terms_hash,
        is_active: data.activate,
        effective_at: data.activate ? new Date().toISOString() : null,
        created_by: context.userId,
      })
      .select("id, version, terms_hash, is_active")
      .single();
    if (error) throw error;
    return { ok: true as const, ...row };
  });

export const activateHandoffTermsVersion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Retire whatever is active now.
    await context.supabase
      .from("handoff_terms_versions")
      .update({ is_active: false, retired_at: new Date().toISOString() })
      .eq("is_active", true)
      .neq("id", data.id);

    const { data: row, error } = await context.supabase
      .from("handoff_terms_versions")
      .update({
        is_active: true,
        effective_at: new Date().toISOString(),
        retired_at: null,
      })
      .eq("id", data.id)
      .select("id, version, terms_hash")
      .single();
    if (error) throw error;
    return { ok: true as const, ...row };
  });

export const retireHandoffTermsVersion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("handoff_terms_versions")
      .update({ is_active: false, retired_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true as const };
  });

// Signed-URL fetch for a contract's stored document (admin only).
export const getHandoffContractDocumentUrl = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        contract_id: z.string().uuid(),
        expires_in: z.number().int().min(30).max(3600).default(300),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: contract, error } = await context.supabase
      .from("handoff_contracts")
      .select("id, document_storage_path")
      .eq("id", data.contract_id)
      .maybeSingle();
    if (error) throw error;
    if (!contract?.document_storage_path) return { ok: false as const, error: "no_document" };
    const { data: signed, error: sErr } = await context.supabase.storage
      .from("handoff-contracts")
      .createSignedUrl(contract.document_storage_path, data.expires_in);
    if (sErr) throw sErr;
    return { ok: true as const, url: signed.signedUrl };
  });
