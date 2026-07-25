import { describe, it, expect } from "vitest";
import {
  hasAnyRole,
  highestLevel,
  OPERATOR_ROLES,
  ADMIN_ROLES,
  SUPER_ADMIN_ROLES,
  HIGH_KING_ROLES,
} from "./roles";

describe("hasAnyRole / role tiers", () => {
  it("treats operator, admin, super_admin, and high_king as operator-level", () => {
    for (const r of ["operator", "admin", "super_admin", "high_king"]) {
      expect(hasAnyRole([r], OPERATOR_ROLES)).toBe(true);
    }
  });

  it("only treats admin, super_admin, and high_king as admin-level", () => {
    expect(hasAnyRole(["admin"], ADMIN_ROLES)).toBe(true);
    expect(hasAnyRole(["super_admin"], ADMIN_ROLES)).toBe(true);
    expect(hasAnyRole(["high_king"], ADMIN_ROLES)).toBe(true);
    expect(hasAnyRole(["operator"], ADMIN_ROLES)).toBe(false);
  });

  it("only treats super_admin and high_king as super-admin-level", () => {
    expect(hasAnyRole(["super_admin"], SUPER_ADMIN_ROLES)).toBe(true);
    expect(hasAnyRole(["high_king"], SUPER_ADMIN_ROLES)).toBe(true);
    expect(hasAnyRole(["admin"], SUPER_ADMIN_ROLES)).toBe(false);
    expect(hasAnyRole(["operator"], SUPER_ADMIN_ROLES)).toBe(false);
  });

  it("only the high_king holds the High King seat", () => {
    expect(hasAnyRole(["high_king"], HIGH_KING_ROLES)).toBe(true);
    for (const r of ["super_admin", "admin", "operator", "user"]) {
      expect(hasAnyRole([r], HIGH_KING_ROLES)).toBe(false);
    }
  });

  it("denies roleless or unknown-role users", () => {
    expect(hasAnyRole([], OPERATOR_ROLES)).toBe(false);
    expect(hasAnyRole(["user"], OPERATOR_ROLES)).toBe(false);
    expect(hasAnyRole(["user"], ADMIN_ROLES)).toBe(false);
  });

  it("matches when the user has multiple roles", () => {
    expect(hasAnyRole(["user", "operator"], OPERATOR_ROLES)).toBe(true);
  });
});

describe("highestLevel", () => {
  it("returns the max level across held roles", () => {
    expect(highestLevel(["user", "admin"])).toBe(80);
    expect(highestLevel(["operator", "super_admin"])).toBe(100);
    expect(highestLevel(["high_king"])).toBe(1000);
  });

  it("returns 0 for no roles or unknown roles", () => {
    expect(highestLevel([])).toBe(0);
    expect(highestLevel(["jester"])).toBe(0);
  });
});
