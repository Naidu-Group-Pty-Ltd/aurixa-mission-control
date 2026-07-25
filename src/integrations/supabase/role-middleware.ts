// Role-enforcing function middleware. Extends requireSupabaseAuth (which only
// proves a valid session) with an authorization check, so privileged server
// functions are gated by role — not merely by being logged in. Without this, an
// authenticated user with no operator role could invoke handlers that use the
// service-role client (which bypasses RLS) directly over RPC.
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "./auth-middleware";
import {
  ADMIN_ROLES,
  HIGH_KING_ROLES,
  OPERATOR_ROLES,
  SUPER_ADMIN_ROLES,
  hasAnyRole,
} from "./roles";

function forbidden(error: string): never {
  throw new Response(JSON.stringify({ error }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

// Read the caller's own roles. RLS ("Users can read own roles") permits this via
// the user-scoped client provided by requireSupabaseAuth.
async function fetchRoles(
  supabase: { from: (t: string) => any },
  userId: string,
): Promise<string[]> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  return ((data as { role: string }[] | null) ?? []).map((r) => r.role);
}

/** Require an operator-level role (operator, admin, super_admin, or high_king). */
export const requireOperator = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const roles = await fetchRoles(context.supabase, context.userId);
    if (!hasAnyRole(roles, OPERATOR_ROLES)) forbidden("forbidden_operator_required");
    return next();
  });

/** Require an admin-level role (admin, super_admin, or high_king). */
export const requireAdmin = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const roles = await fetchRoles(context.supabase, context.userId);
    if (!hasAnyRole(roles, ADMIN_ROLES)) forbidden("forbidden_admin_required");
    return next();
  });

/** Require a super-admin-level role (super_admin or high_king). Gates invite issuance. */
export const requireSuperAdmin = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const roles = await fetchRoles(context.supabase, context.userId);
    if (!hasAnyRole(roles, SUPER_ADMIN_ROLES)) forbidden("forbidden_super_admin_required");
    return next();
  });

/** Require the High King seat. Gates the cross-tier oversight surface. */
export const requireHighKing = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const roles = await fetchRoles(context.supabase, context.userId);
    if (!hasAnyRole(roles, HIGH_KING_ROLES)) forbidden("forbidden_high_king_required");
    return next();
  });
