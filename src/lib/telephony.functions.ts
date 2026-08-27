// Operator softphone server functions — token minting, registration
// heartbeats, and the phone-call ledger behind /voice/phone.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export type PhoneCallRow = Database["public"]["Tables"]["phone_calls"]["Row"];
export type TelephonyRegistrationRow =
  Database["public"]["Tables"]["telephony_registrations"]["Row"];

/**
 * Everything the softphone needs to boot: whether Twilio is configured (and
 * which secrets are missing, so the page can say exactly what to add), this
 * operator's identity, and who else is currently registered to ring.
 */
export const getTelephonyStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { telephonyConfig, identityForUser, REGISTRATION_FRESH_MINUTES } = await import(
      "@/server/telephony.server"
    );
    const config = telephonyConfig();
    const cutoff = new Date(Date.now() - REGISTRATION_FRESH_MINUTES * 60_000).toISOString();
    const { data: registrations, error } = await context.supabase
      .from("telephony_registrations")
      .select("identity, display_name, ring_enabled, last_seen_at")
      .order("last_seen_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return {
      configured: config.ready,
      missing: config.missing,
      callerId: config.ready ? config.callerId : null,
      identity: identityForUser(context.userId),
      registrations: (registrations ?? []).map((r) => ({
        ...r,
        fresh: r.last_seen_at >= cutoff,
      })),
    };
  });

/**
 * Mint a Voice access token for this operator's browser and register the
 * identity as ringable. Refused (as `configured: false`) until the Twilio
 * secrets exist — the UI treats that as a state, not an error.
 */
export const issueTelephonyToken = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ displayName: z.string().max(120).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { telephonyConfig, mintVoiceToken, upsertRegistration, TOKEN_TTL_SECONDS } =
      await import("@/server/telephony.server");
    const config = telephonyConfig();
    if (!config.ready) {
      return { configured: false as const, missing: config.missing };
    }
    const { identity } = await upsertRegistration({
      userId: context.userId,
      displayName: data.displayName ?? null,
    });
    const token = await mintVoiceToken(config, identity);
    return { configured: true as const, identity, token, ttlSeconds: TOKEN_TTL_SECONDS };
  });

/** Keep this operator's registration fresh (the inbound ring window). */
export const telephonyHeartbeat = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { upsertRegistration } = await import("@/server/telephony.server");
    const { identity } = await upsertRegistration({ userId: context.userId });
    return { identity };
  });

/** Toggle whether inbound calls ring this operator. */
export const setTelephonyRinging = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ ringEnabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { upsertRegistration } = await import("@/server/telephony.server");
    const { identity } = await upsertRegistration({
      userId: context.userId,
      ringEnabled: data.ringEnabled,
    });
    return { identity, ringEnabled: data.ringEnabled };
  });

export const listPhoneCalls = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        direction: z.enum(["all", "inbound", "outbound"]).default("all"),
        search: z.string().max(120).default(""),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("phone_calls")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.direction !== "all") q = q.eq("direction", data.direction);
    if (data.search.trim()) {
      const s = data.search.trim().replace(/[%_]/g, "");
      q = q.or(`phone_number.ilike.%${s}%,customer_name.ilike.%${s}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    return { calls: (rows ?? []) as PhoneCallRow[] };
  });

export const updatePhoneCallNotes = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ id: uuid, notes: z.string().max(4000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("phone_calls")
      .update({ notes: data.notes || null })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/** Contact quick-search for click-to-call. */
export const searchDialableContacts = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ search: z.string().max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    const s = data.search.trim().replace(/[%_]/g, "");
    if (!s) return { contacts: [] };
    const { data: rows, error } = await context.supabase
      .from("crm_contacts")
      .select("id, account_id, first_name, last_name, phone")
      .not("phone", "is", null)
      .or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,phone.ilike.%${s}%`)
      .limit(8);
    if (error) throw error;
    return { contacts: rows ?? [] };
  });
