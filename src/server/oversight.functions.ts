// @ts-nocheck
// High King oversight — the sovereign view over every tier.
//
// The High King seat (level 1000) has full visibility of all actions taken by
// all user tiers: the append-only audit_log, the realm roster (who holds which
// tier), and the invite pipeline. Both functions are gated by requireHighKing;
// everyone else gets a 403 regardless of what the UI shows.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireHighKing } from "@/integrations/supabase/role-middleware";
import { ROLE_LEVELS, type RoleName } from "@/integrations/supabase/roles";
import type { Database } from "@/integrations/supabase/types";

type AppRole = Database["public"]["Enums"]["app_role"];

function topRole(roles: readonly string[]): AppRole | null {
  let best: AppRole | null = null;
  let bestLevel = -1;
  for (const r of roles) {
    const lvl = ROLE_LEVELS[r as RoleName] ?? 0;
    if (lvl > bestLevel) {
      best = r as AppRole;
      bestLevel = lvl;
    }
  }
  return best;
}

// ─── Overview: roster, tier counts, activity pulse, invite pipeline ──

export const getOversightOverview = createServerFn({ method: "GET" })
  .middleware([requireHighKing])
  .handler(async ({ context }) => {
    const { supabase } = context;

    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const [rolesRes, profilesRes, invitesRes, dayCountRes, weekCountRes] = await Promise.all([
      supabase.from("user_roles").select("user_id, role, assigned_at, assigned_by"),
      supabase.from("profiles").select("user_id, display_name, created_at"),
      supabase.from("user_invites").select("id, accepted_at, revoked_at, expires_at"),
      supabase
        .from("audit_log")
        .select("*", { count: "exact", head: true })
        .gte("created_at", dayAgo),
      supabase
        .from("audit_log")
        .select("*", { count: "exact", head: true })
        .gte("created_at", weekAgo),
    ]);
    if (rolesRes.error) throw new Error(rolesRes.error.message);

    const profileMap = new Map((profilesRes.data ?? []).map((p) => [p.user_id, p]));

    // Group role rows per user, then classify by top tier.
    const byUser = new Map<string, string[]>();
    for (const r of rolesRes.data ?? []) {
      const list = byUser.get(r.user_id) ?? [];
      list.push(r.role);
      byUser.set(r.user_id, list);
    }

    const tierCounts: Record<string, number> = {};
    const roster: Array<{
      user_id: string;
      display_name: string | null;
      top_role: AppRole | null;
      roles: string[];
      joined_at: string | null;
    }> = [];
    for (const [userId, roles] of byUser) {
      const top = topRole(roles);
      if (top) tierCounts[top] = (tierCounts[top] ?? 0) + 1;
      const profile = profileMap.get(userId);
      roster.push({
        user_id: userId,
        display_name: profile?.display_name ?? null,
        top_role: top,
        roles,
        joined_at: profile?.created_at ?? null,
      });
    }
    roster.sort(
      (a, b) =>
        (ROLE_LEVELS[(b.top_role ?? "") as RoleName] ?? 0) -
        (ROLE_LEVELS[(a.top_role ?? "") as RoleName] ?? 0),
    );

    const now = Date.now();
    const invites = invitesRes.data ?? [];
    const invitePipeline = {
      pending: invites.filter(
        (i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at).getTime() >= now,
      ).length,
      accepted: invites.filter((i) => i.accepted_at).length,
      revoked: invites.filter((i) => i.revoked_at && !i.accepted_at).length,
      expired: invites.filter(
        (i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at).getTime() < now,
      ).length,
    };

    return {
      roster,
      tierCounts,
      totalUsers: byUser.size,
      actions24h: dayCountRes.count ?? 0,
      actions7d: weekCountRes.count ?? 0,
      invitePipeline,
    };
  });

// ─── Feed: every audited action, annotated with the actor's tier ─────

export const getOversightFeed = createServerFn({ method: "GET" })
  .middleware([requireHighKing])
  .inputValidator((input: unknown) =>
    z
      .object({
        // Action prefix filter, e.g. "role." or "invite." — empty = everything.
        actionPrefix: z.string().max(60).optional(),
        actorUserId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(500).default(300),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    let query = supabase
      .from("audit_log")
      .select("id, action, entity_type, entity_id, actor_user_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.actionPrefix) query = query.like("action", `${data.actionPrefix}%`);
    if (data.actorUserId) query = query.eq("actor_user_id", data.actorUserId);

    const { data: entries, error } = await query;
    if (error) throw new Error(error.message);

    // Annotate every entry with the actor's display name and current top tier
    // so the throne sees WHO did WHAT at WHICH rank.
    const actorIds = Array.from(
      new Set((entries ?? []).map((e) => e.actor_user_id).filter((v): v is string => !!v)),
    );
    const [profilesRes, rolesRes] = await Promise.all([
      actorIds.length
        ? supabase.from("profiles").select("user_id, display_name").in("user_id", actorIds)
        : Promise.resolve({ data: [] as Array<{ user_id: string; display_name: string | null }> }),
      actorIds.length
        ? supabase.from("user_roles").select("user_id, role").in("user_id", actorIds)
        : Promise.resolve({ data: [] as Array<{ user_id: string; role: string }> }),
    ]);
    const names = new Map((profilesRes.data ?? []).map((p) => [p.user_id, p.display_name]));
    const rolesByActor = new Map<string, string[]>();
    for (const r of rolesRes.data ?? []) {
      const list = rolesByActor.get(r.user_id) ?? [];
      list.push(r.role);
      rolesByActor.set(r.user_id, list);
    }

    return {
      entries: (entries ?? []).map((e) => ({
        ...e,
        actor_name: e.actor_user_id ? (names.get(e.actor_user_id) ?? null) : null,
        actor_tier: e.actor_user_id ? topRole(rolesByActor.get(e.actor_user_id) ?? []) : null,
      })),
    };
  });
