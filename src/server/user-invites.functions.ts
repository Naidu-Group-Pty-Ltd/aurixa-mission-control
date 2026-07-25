// @ts-nocheck
// Closed-system membership invites.
//
// Self-serve sign-up is deprecated: the only way into Mission Control is an
// outbound invite link minted by a super_admin (or the High King). The raw
// token is shown exactly once at mint time — only its SHA-256 hash is stored.
// Redemption happens server-side with the service-role client, so anonymous
// Supabase sign-up never has to be enabled.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { requireSuperAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

type AppRole = Database["public"]["Enums"]["app_role"];

// Roles an invite may grant. high_king is deliberately absent — the seat is
// seeded, never granted (also enforced by a DB CHECK constraint).
const INVITABLE_ROLES = ["user", "operator", "admin", "super_admin"] as const;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

function inviteStatus(row: {
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}): InviteStatus {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

// ─── Mint an invite (super_admin+) ───────────────────────────────────

export const createUserInvite = createServerFn({ method: "POST" })
  .middleware([requireSuperAdmin])
  .inputValidator((input: unknown) =>
    z
      .object({
        role: z.enum(INVITABLE_ROLES).default("user"),
        email: z.string().email().max(200).optional(),
        note: z.string().max(500).optional(),
        ttlHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .default(24 * 7),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Hierarchy check: an invite may only grant a role the issuer could assign
    // directly (issuer level must strictly exceed the granted role's level).
    // RLS re-enforces this on insert; checking first gives a clean error.
    const { data: canAssign } = await supabase.rpc("can_assign_role", {
      _assigner_id: userId,
      _target_role: data.role,
    });
    if (!canAssign) {
      return {
        ok: false as const,
        error: `You cannot issue an invite granting '${data.role}' — it is not below your own level`,
      };
    }

    // 32-byte URL-safe token, shown once.
    const token = `aui_${randomBytes(32).toString("base64url")}`;
    const expires_at = new Date(Date.now() + data.ttlHours * 3600 * 1000).toISOString();

    // Insert through the user-scoped client so the RLS policy
    // ("Super admins can issue invites within their rank") is enforced.
    const { data: row, error } = await supabase
      .from("user_invites")
      .insert({
        token_hash: hashToken(token),
        token_prefix: token.slice(0, 10),
        email: data.email?.toLowerCase() ?? null,
        role: data.role,
        note: data.note ?? null,
        invited_by: userId,
        expires_at,
      })
      .select("id, token_prefix, expires_at")
      .single();
    if (error) return { ok: false as const, error: error.message };

    await supabase.from("audit_log").insert({
      action: "invite.created",
      entity_type: "user_invite",
      entity_id: row.id,
      actor_user_id: userId,
      metadata: {
        role: data.role,
        email: data.email ?? null,
        token_prefix: row.token_prefix,
        expires_at: row.expires_at,
      },
    });

    return {
      ok: true as const,
      id: row.id,
      // Returned exactly once — the client must copy the link now.
      token,
      token_prefix: row.token_prefix,
      expires_at: row.expires_at,
    };
  });

// ─── List invites (super_admin+) ─────────────────────────────────────

export const listUserInvites = createServerFn({ method: "GET" })
  .middleware([requireSuperAdmin])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("user_invites")
      .select(
        "id, token_prefix, email, role, note, invited_by, expires_at, accepted_at, accepted_user_id, revoked_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const userIds = new Set<string>();
    for (const r of rows ?? []) {
      userIds.add(r.invited_by);
      if (r.accepted_user_id) userIds.add(r.accepted_user_id);
    }
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", Array.from(userIds));
    const names = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));

    return {
      invites: (rows ?? []).map((r) => ({
        ...r,
        status: inviteStatus(r),
        invited_by_name: names.get(r.invited_by) ?? null,
        accepted_by_name: r.accepted_user_id ? (names.get(r.accepted_user_id) ?? null) : null,
      })),
    };
  });

// ─── Revoke an invite (super_admin+) ─────────────────────────────────

export const revokeUserInvite = createServerFn({ method: "POST" })
  .middleware([requireSuperAdmin])
  .inputValidator((input: unknown) => z.object({ inviteId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("user_invites")
      .update({ revoked_at: new Date().toISOString(), revoked_by: userId })
      .eq("id", data.inviteId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id, token_prefix")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!row) {
      return {
        ok: false as const,
        error: "Invite not found, already accepted, or already revoked",
      };
    }

    await supabase.from("audit_log").insert({
      action: "invite.revoked",
      entity_type: "user_invite",
      entity_id: row.id,
      actor_user_id: userId,
      metadata: { token_prefix: row.token_prefix },
    });

    return { ok: true as const };
  });

// ─── Public: validate an invite token (the token IS the credential) ──

export const validateUserInvite = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ token: z.string().min(20).max(200) }).parse(input))
  .handler(async ({ data }) => {
    const { data: invite } = await supabaseAdmin
      .from("user_invites")
      .select("id, email, role, expires_at, accepted_at, revoked_at, invited_by")
      .eq("token_hash", hashToken(data.token))
      .maybeSingle();

    if (!invite) return { ok: false as const, reason: "not_found" as const };
    const status = inviteStatus(invite);
    if (status !== "pending") {
      return { ok: false as const, reason: status as "accepted" | "revoked" | "expired" };
    }

    const { data: inviter } = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("user_id", invite.invited_by)
      .maybeSingle();

    return {
      ok: true as const,
      email: invite.email,
      role: invite.role,
      expires_at: invite.expires_at,
      invited_by_name: inviter?.display_name ?? null,
    };
  });

// ─── Public: accept an invite → account creation (service role) ──────

export const acceptUserInvite = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        token: z.string().min(20).max(200),
        email: z.string().email().max(200),
        password: z.string().min(8).max(200),
        displayName: z.string().min(1).max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const token_hash = hashToken(data.token);
    const email = data.email.toLowerCase();

    const { data: invite } = await supabaseAdmin
      .from("user_invites")
      .select("id, email, role, expires_at, accepted_at, revoked_at, invited_by, token_prefix")
      .eq("token_hash", token_hash)
      .maybeSingle();
    if (!invite) return { ok: false as const, error: "Invite not found" };

    const status = inviteStatus(invite);
    if (status !== "pending") {
      const msg: Record<string, string> = {
        accepted: "This invite has already been used",
        revoked: "This invite has been revoked",
        expired: "This invite has expired",
      };
      return { ok: false as const, error: msg[status] ?? "Invite is no longer valid" };
    }

    // Email lock: when the issuer pinned the invite to an address, only that
    // address may redeem it.
    if (invite.email && invite.email !== email) {
      return { ok: false as const, error: "This invite was issued for a different email address" };
    }

    // Claim the invite BEFORE creating the account so two concurrent submits
    // can't both mint users. The .is("accepted_at", null) makes this atomic;
    // the loser sees zero rows updated.
    const { data: claimed } = await supabaseAdmin
      .from("user_invites")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invite.id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) return { ok: false as const, error: "This invite has already been used" };

    // Create the account with the service role — no anonymous sign-up path.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: true,
      user_metadata: data.displayName ? { display_name: data.displayName } : undefined,
    });
    if (createErr || !created?.user) {
      // Roll the claim back so the invite remains redeemable.
      await supabaseAdmin.from("user_invites").update({ accepted_at: null }).eq("id", invite.id);
      const duplicate = /already|exists|registered/i.test(createErr?.message ?? "");
      return {
        ok: false as const,
        error: duplicate
          ? "An account already exists for this email — sign in instead"
          : (createErr?.message ?? "Account creation failed"),
      };
    }

    // Grant the invited role, attributed to the issuer. The DB trigger
    // enforce_role_hierarchy re-validates that the issuer still outranks the
    // granted role; if they were demoted since minting, fall back to the
    // baseline 'user' role rather than leaving a locked-out account.
    let grantedRole: AppRole = invite.role;
    const { error: roleErr } = await supabaseAdmin.from("user_roles").insert({
      user_id: created.user.id,
      role: invite.role,
      assigned_by: invite.invited_by,
    });
    if (roleErr) {
      grantedRole = "user";
      await supabaseAdmin.from("user_roles").insert({
        user_id: created.user.id,
        role: "user",
      });
    }

    await supabaseAdmin
      .from("user_invites")
      .update({ accepted_user_id: created.user.id })
      .eq("id", invite.id);

    await supabaseAdmin.from("audit_log").insert({
      action: "invite.accepted",
      entity_type: "user_invite",
      entity_id: invite.id,
      actor_user_id: created.user.id,
      metadata: {
        token_prefix: invite.token_prefix,
        invited_by: invite.invited_by,
        invited_role: invite.role,
        granted_role: grantedRole,
        downgraded: grantedRole !== invite.role,
      },
    });

    return { ok: true as const, role: grantedRole };
  });
