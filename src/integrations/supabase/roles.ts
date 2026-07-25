// Pure role constants and decision helper (no runtime deps) so they can be unit
// tested without importing the TanStack middleware runtime.
//
// Hierarchy (highest first):
//   high_king (1000) — singular sovereign seat with full oversight of all tiers
//   super_admin (100) — full admin controls; may issue outbound invites
//   admin (80) · operator (50) · user (10)

export const ROLE_LEVELS = {
  high_king: 1000,
  super_admin: 100,
  admin: 80,
  operator: 50,
  user: 10,
} as const;

export type RoleName = keyof typeof ROLE_LEVELS;

export const HIGH_KING_ROLES = ["high_king"] as const;
export const SUPER_ADMIN_ROLES = ["high_king", "super_admin"] as const;
export const ADMIN_ROLES = ["high_king", "super_admin", "admin"] as const;
export const OPERATOR_ROLES = ["high_king", "super_admin", "admin", "operator"] as const;

export function hasAnyRole(roles: readonly string[], allowed: readonly string[]): boolean {
  return roles.some((r) => allowed.includes(r));
}

/** Highest numeric level held across a set of role names (0 when none). */
export function highestLevel(roles: readonly string[]): number {
  return roles.reduce((max, r) => Math.max(max, ROLE_LEVELS[r as RoleName] ?? 0), 0);
}
