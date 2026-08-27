// Client agreements server functions — the operator surface behind
// /agreements: create for a converted lead, send via DocuSign, track,
// download the signed document, void.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export type AgreementRow = Database["public"]["Tables"]["client_agreements"]["Row"];

export const AGREEMENT_STATUSES = [
  "draft",
  "sent",
  "delivered",
  "signed",
  "declined",
  "voided",
] as const;

export const SERVICE_TIERS = ["Launch", "Growth", "Scale", "Enterprise"] as const;

/** DocuSign configuration state — which env secrets are still missing. */
export const getAgreementsConfig = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const { docusignConfig } = await import("@/server/agreements.server");
    const config = docusignConfig();
    return {
      configured: config.ready,
      missing: config.missing,
      baseUrl: config.ready ? config.baseUrl : null,
      countersigner: config.countersignerEmail
        ? { name: config.countersignerName, email: config.countersignerEmail }
        : null,
    };
  });

export const listAgreements = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["all", ...AGREEMENT_STATUSES]).default("all"),
        search: z.string().max(120).default(""),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("client_agreements")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.search.trim()) {
      const s = data.search.trim().replace(/[%_]/g, "");
      q = q.or(`client_name.ilike.%${s}%,client_email.ilike.%${s}%,client_org.ilike.%${s}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    return { agreements: (rows ?? []) as AgreementRow[] };
  });

/** Contacts with an email address — the sendable population, with journey stage. */
export const searchAgreementClients = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ search: z.string().max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    const s = data.search.trim().replace(/[%_]/g, "");
    if (!s) return { contacts: [] };
    const { data: rows, error } = await context.supabase
      .from("crm_contacts")
      .select("id, account_id, first_name, last_name, email, crm_accounts(name), crm_client_journeys(stage_key)")
      .not("email", "is", null)
      .or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%`)
      .limit(8);
    if (error) throw error;
    return {
      contacts: (rows ?? []).map((r) => {
        const account = r.crm_accounts as unknown as { name: string } | null;
        const journeys = r.crm_client_journeys as unknown as Array<{ stage_key: string }> | null;
        return {
          id: r.id,
          accountId: r.account_id,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          email: r.email as string,
          org: account?.name ?? null,
          stage: journeys?.[0]?.stage_key ?? null,
        };
      }),
    };
  });

export const createAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        contactId: uuid.optional(),
        clientName: z.string().min(1).max(200),
        clientEmail: z.string().email().max(200),
        clientOrg: z.string().max(200).optional(),
        serviceTier: z.enum(SERVICE_TIERS).optional(),
        commencementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        notes: z.string().max(4000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let accountId: string | null = null;
    if (data.contactId) {
      const { data: contact, error } = await context.supabase
        .from("crm_contacts")
        .select("account_id")
        .eq("id", data.contactId)
        .maybeSingle();
      if (error) throw error;
      accountId = contact?.account_id ?? null;
    }
    const { data: row, error: insertError } = await context.supabase
      .from("client_agreements")
      .insert({
        contact_id: data.contactId ?? null,
        account_id: accountId,
        client_name: data.clientName,
        client_email: data.clientEmail,
        client_org: data.clientOrg ?? null,
        service_tier: data.serviceTier ?? null,
        commencement_date: data.commencementDate ?? null,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    return { id: row.id };
  });

export const sendAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { sendAgreementEnvelope } = await import("@/server/agreements.server");
    return await sendAgreementEnvelope(data.id);
  });

export const refreshAgreementStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { refreshEnvelopeStatus } = await import("@/server/agreements.server");
    return await refreshEnvelopeStatus(data.id);
  });

export const downloadSignedAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { downloadSignedPdf } = await import("@/server/agreements.server");
    return await downloadSignedPdf(data.id);
  });

export const voidAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ id: uuid, reason: z.string().max(500).default("") }).parse(input),
  )
  .handler(async ({ data }) => {
    const { voidEnvelope } = await import("@/server/agreements.server");
    await voidEnvelope(data.id, data.reason);
    return { ok: true };
  });

export const deleteDraftAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("client_agreements")
      .delete()
      .eq("id", data.id)
      .eq("status", "draft");
    if (error) throw error;
    return { ok: true };
  });
