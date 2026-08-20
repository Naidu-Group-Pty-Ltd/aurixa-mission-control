// @ts-nocheck
// G10 — Org capacity preflight surface.
// Exposes the `checkOrgCapacity` helper as an admin-only server function so
// operators can inspect Supabase org headroom before starting provisioning
// or a twin build. Also supports pointing at a client org via decrypted PAT
// from `client_supabase_accounts` (used by the handoff twin provisioner).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

export const getPrimeOrgCapacity = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { checkOrgCapacity } = await import("@/server/backend-provisioning.server");
    return checkOrgCapacity();
  });

export const getClientOrgCapacity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ client_account_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: acct, error } = await context.supabase
      .from("client_supabase_accounts")
      .select("id, org_id, org_slug, pat_ciphertext")
      .eq("id", data.client_account_id)
      .maybeSingle();
    if (error) throw error;
    if (!acct) throw new Error("Client Supabase account not found");
    if (!acct.pat_ciphertext) throw new Error("Client account has no PAT captured yet");

    const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
    const pat = decryptSecret(decodeBytea(acct.pat_ciphertext));
    const { checkOrgCapacity } = await import("@/server/backend-provisioning.server");
    return checkOrgCapacity({
      token: pat,
      orgId: acct.org_id ?? acct.org_slug ?? undefined,
    });
  });

export const auditFleetOrgCapacity = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { checkOrgCapacity } = await import("@/server/backend-provisioning.server");
    const prime = await checkOrgCapacity().catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    }));

    // Write to audit_log so the operator has a durable trail.
    if (!(prime as { error?: string }).error) {
      await context.supabase.from("audit_log").insert({
        actor_id: context.userId,
        action: "org_capacity_audit",
        target_type: "supabase_org",
        target_id: (prime as { orgId: string }).orgId,
        metadata: prime as unknown as Record<string, unknown>,
      });
    }

    return { prime };
  });
