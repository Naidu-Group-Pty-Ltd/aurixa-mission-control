// @ts-nocheck
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type AppRole = Database["public"]["Enums"]["app_role"];

// ─── List all users with their roles ─────────────────────────────────

export const listUsersWithRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;

    // Get all roles
    const { data: roles, error: rolesErr } = await supabase
      .from("user_roles")
      .select("*")
      .order("created_at", { ascending: true });
    if (rolesErr) throw new Error(rolesErr.message);

    // Get all profiles
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, display_name, avatar_url");

    const profileMap = new Map((profiles ?? []).map((p) => [p.user_id, p]));

    // Group roles by user
    const userMap = new Map<
      string,
      {
        user_id: string;
        display_name: string | null;
        roles: Array<{
          id: string;
          role: AppRole;
          assigned_by: string | null;
          assigned_at: string;
          created_at: string;
        }>;
      }
    >();

    for (const r of roles ?? []) {
      if (!userMap.has(r.user_id)) {
        const profile = profileMap.get(r.user_id);
        userMap.set(r.user_id, {
          user_id: r.user_id,
          display_name: profile?.display_name ?? null,
          roles: [],
        });
      }
      userMap.get(r.user_id)!.roles.push({
        id: r.id,
        role: r.role,
        assigned_by: r.assigned_by,
        assigned_at: r.assigned_at,
        created_at: r.created_at,
      });
    }

    return { users: Array.from(userMap.values()) };
  });

// ─── Get current user's highest role level ───────────────────────────

export const getMyRoleLevel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase.rpc("highest_role_level", {
      _user_id: userId,
    });
    return { level: data ?? 0 };
  });

// ─── Assign a role ───────────────────────────────────────────────────

export const assignRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { targetUserId: string; role: AppRole }) => {
    if (!input?.targetUserId) throw new Error("targetUserId required");
    if (!input?.role) throw new Error("role required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Server-side hierarchy check: assigner's level must strictly exceed target role level
    const { data: canAssign } = await supabase.rpc("can_assign_role", {
      _assigner_id: userId,
      _target_role: data.role,
    });
    if (!canAssign) {
      return {
        ok: false as const,
        error: "You don't have sufficient privileges to assign this role",
      };
    }

    // The High King seat is seeded, never assigned. super_admin IS assignable
    // now — but only by someone who outranks it, i.e. the High King (the
    // can_assign_role check above plus the DB trigger both enforce level
    // 1000 > 100).
    if (data.role === "high_king") {
      return {
        ok: false as const,
        error: "The High King seat is singular and seeded — it cannot be assigned",
      };
    }

    // Prevent assigning to self
    if (data.targetUserId === userId) {
      return { ok: false as const, error: "You cannot assign roles to yourself" };
    }

    const { error } = await supabase.from("user_roles").insert({
      user_id: data.targetUserId,
      role: data.role,
      assigned_by: userId,
    });

    if (error) {
      if (error.code === "23505") {
        return { ok: false as const, error: "User already has this role" };
      }
      return { ok: false as const, error: error.message };
    }

    // Audit log
    await supabase.from("audit_log").insert({
      action: "role.assigned",
      entity_type: "user_role",
      actor_user_id: userId,
      metadata: {
        target_user_id: data.targetUserId,
        role: data.role,
      },
    });

    return { ok: true as const };
  });

// ─── Revoke a role ───────────────────────────────────────────────────

export const revokeRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { roleId: string; targetUserId: string; role: string }) => {
    if (!input?.roleId) throw new Error("roleId required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Check can_manage_user
    const { data: canManage } = await supabase.rpc("can_manage_user", {
      _manager_id: userId,
      _target_user_id: data.targetUserId,
    });
    if (!canManage) {
      return {
        ok: false as const,
        error: "You don't have sufficient privileges to manage this user",
      };
    }

    // Server-side guardrail: the High King seat cannot be revoked from the
    // app. Nobody outranks level 1000, and DB triggers (guard_last_high_king,
    // can_manage_user) enforce the same — this is just a clearer error.
    if (data.role === "high_king") {
      return {
        ok: false as const,
        error: "The High King seat cannot be revoked — succession is a database operation",
      };
    }

    // Server-side guardrail: verify assigner outranks the target role
    const { data: assignerLevel } = await supabase.rpc("highest_role_level", {
      _user_id: userId,
    });
    const roleLevels: Record<string, number> = {
      high_king: 1000,
      super_admin: 100,
      admin: 80,
      operator: 50,
      user: 10,
    };
    const targetRoleLevel = roleLevels[data.role] ?? 0;
    if ((assignerLevel ?? 0) <= targetRoleLevel) {
      return {
        ok: false as const,
        error: `Insufficient privileges: your level (${assignerLevel}) must exceed the role level (${targetRoleLevel})`,
      };
    }

    const { error } = await supabase.from("user_roles").delete().eq("id", data.roleId);

    if (error) {
      return { ok: false as const, error: error.message };
    }

    // Audit log
    await supabase.from("audit_log").insert({
      action: "role.revoked",
      entity_type: "user_role",
      actor_user_id: userId,
      metadata: {
        target_user_id: data.targetUserId,
        role: data.role,
        role_id: data.roleId,
      },
    });

    return { ok: true as const };
  });

// ─── Get bootstrap SQL preview ───────────────────────────────────────

export const getBootstrapSqlPreview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getCloneBootstrapSql } = await import("./backend-provisioning.server");
    return { sql: getCloneBootstrapSql() };
  });

// ─── Get role audit entries ──────────────────────────────────────────

export const getRoleAuditLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("audit_log")
      .select("*")
      .in("action", [
        "role.assigned",
        "role.revoked",
        "role.changed",
        "clone.created",
        "invite.created",
        "invite.revoked",
        "invite.accepted",
      ])
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    // Resolve actor and target display names
    const userIds = new Set<string>();
    for (const entry of data ?? []) {
      if (entry.actor_user_id) userIds.add(entry.actor_user_id);
      const meta = entry.metadata as Record<string, unknown>;
      if (meta?.target_user_id && typeof meta.target_user_id === "string") {
        userIds.add(meta.target_user_id);
      }
    }

    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", Array.from(userIds));

    const nameMap = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));

    return {
      entries: (data ?? []).map((e) => ({
        ...e,
        actor_name: e.actor_user_id ? (nameMap.get(e.actor_user_id) ?? null) : null,
        target_name: (() => {
          const meta = e.metadata as Record<string, unknown>;
          const tid = meta?.target_user_id;
          return typeof tid === "string" ? (nameMap.get(tid) ?? null) : null;
        })(),
      })),
    };
  });
