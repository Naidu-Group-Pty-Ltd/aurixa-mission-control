import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Crown,
  Gem,
  Shield,
  Wrench,
  User,
  Check,
  X,
  Minus,
  Grid3x3,
  Info,
  Database,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Database as DbTypes } from "@/integrations/supabase/types";

type AppRole = DbTypes["public"]["Enums"]["app_role"];

const ROLES: Array<{
  role: AppRole;
  label: string;
  level: number;
  icon: typeof Crown;
  color: string;
}> = [
  { role: "high_king", label: "High King", level: 1000, icon: Crown, color: "text-warning" },
  { role: "super_admin", label: "Super Admin", level: 100, icon: Gem, color: "text-warning" },
  { role: "admin", label: "Admin", level: 80, icon: Shield, color: "text-primary" },
  { role: "operator", label: "Operator", level: 50, icon: Wrench, color: "text-accent" },
  { role: "user", label: "User", level: 10, icon: User, color: "text-muted-foreground" },
];

type Capability = "full" | "limited" | "none";

type PermissionRow = {
  category: string;
  capability: string;
  description: string;
  access: Record<AppRole, Capability>;
  enforcement: {
    type: "rls" | "function" | "trigger" | "server" | "system";
    label: string;
    detail: string;
  };
};

const PERMISSIONS: PermissionRow[] = [
  // ── Role Management ──
  {
    category: "Role Management",
    capability: "Assign high_king",
    description: "No one can assign the High King seat — it's system-seeded and singular",
    access: {
      high_king: "none",
      super_admin: "none",
      admin: "none",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "trigger",
      label: "guard_singular_high_king + hierarchy",
      detail:
        "assignRole() explicitly blocks role='high_king'. DB trigger guard_singular_high_king() rejects granting the seat while occupied, and can_assign_role() requires level > 1000, which no role has. Succession is a deliberate database operation.",
    },
  },
  {
    category: "Role Management",
    capability: "Assign super_admin",
    description: "Only the High King (level 1000 > 100)",
    access: {
      high_king: "full",
      super_admin: "none",
      admin: "none",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "function",
      label: "can_assign_role(_assigner, 'super_admin')",
      detail:
        "RLS INSERT policy on user_roles: WITH CHECK (can_assign_role(auth.uid(), role) AND assigned_by = auth.uid()). The function checks highest_role_level(assigner) > role_level('super_admin'=100). Only the High King (level 1000) passes.",
    },
  },
  {
    category: "Role Management",
    capability: "Issue invite links",
    description: "Closed system — super_admin+ mint outbound invites; sign-up is disabled",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "none",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS INSERT on user_invites + requireSuperAdmin",
      detail:
        "Policy 'Super admins can issue invites within their rank': WITH CHECK (is_super_admin(auth.uid()) AND invited_by = auth.uid() AND can_assign_role(auth.uid(), role)). The invite's granted role must be below the issuer's own level, and invites can never grant high_king (CHECK constraint). The createUserInvite server function is additionally gated by requireSuperAdmin middleware.",
    },
  },
  {
    category: "Role Management",
    capability: "Assign admin",
    description: "Super_admin+ (level 100+ > 80)",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "none",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "function",
      label: "can_assign_role(_assigner, 'admin')",
      detail:
        "RLS INSERT policy on user_roles: WITH CHECK (can_assign_role(auth.uid(), role) AND assigned_by = auth.uid()). The function checks highest_role_level(assigner) > role_level('admin'=80). Levels 100 (super_admin) and 1000 (high_king) pass.",
    },
  },
  {
    category: "Role Management",
    capability: "Assign operator",
    description: "Admin+ can assign operator (level 80+ > 50)",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "function",
      label: "can_assign_role(_assigner, 'operator')",
      detail:
        "Same RLS INSERT policy. highest_role_level(assigner) must exceed role_level('operator'=50). Levels 80 (admin) and above qualify.",
    },
  },
  {
    category: "Role Management",
    capability: "Assign user",
    description: "Operator+ can assign user (level 50+ > 10)",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "function",
      label: "can_assign_role(_assigner, 'user')",
      detail:
        "highest_role_level(assigner) must exceed role_level('user'=10). Levels 50+ qualify. The 'user' role itself at level 10 cannot self-assign.",
    },
  },
  {
    category: "Role Management",
    capability: "Revoke roles",
    description: "Can only revoke from users with lower role level",
    access: {
      high_king: "full",
      super_admin: "limited",
      admin: "limited",
      operator: "limited",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS DELETE + guard_last_high_king trigger",
      detail:
        "RLS DELETE policy: USING can_manage_user(auth.uid(), user_id) — checks highest_role_level(manager) > highest_role_level(target). The High King outranks every tier; everyone else is hierarchy-scoped. DB trigger guard_last_high_king() raises an exception if the High King seat would be vacated.",
    },
  },
  {
    category: "Role Management",
    capability: "View all roles",
    description: "Admin+ can see all users' roles",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS SELECT on user_roles",
      detail:
        "Policy 'Admins and super_admins can read all roles': USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'super_admin')). has_role() is hierarchy-aware — a caller passes when their highest level meets or exceeds the required tier, so super_admin and high_king qualify. A separate policy allows users to read their own roles: USING (auth.uid() = user_id).",
    },
  },
  {
    category: "Role Management",
    capability: "Cross-tier oversight",
    description: "Full visibility of all actions taken by every user tier",
    access: {
      high_king: "full",
      super_admin: "none",
      admin: "none",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "server",
      label: "requireHighKing middleware",
      detail:
        "The /oversight surface (getOversightOverview / getOversightFeed server functions) is gated by requireHighKing middleware — a 403 for anyone whose roles do not include high_king. It aggregates the append-only audit_log across every actor and annotates each action with the actor's tier.",
    },
  },
  // ── Fleet Management ──
  {
    category: "Fleet Management",
    capability: "View clones",
    description: "Read access to all clones",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS SELECT on clones",
      detail:
        "Policy 'Operators can read clones': USING is_operator(auth.uid()). The is_operator() function passes any tier at level 50 or above (operator, admin, super_admin, high_king).",
    },
  },
  {
    category: "Fleet Management",
    capability: "Create clones",
    description: "Provision new clone repos",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS INSERT on clones",
      detail:
        "Policy 'Operators can insert clones': WITH CHECK is_operator(auth.uid()). Requires super_admin, admin, or operator role.",
    },
  },
  {
    category: "Fleet Management",
    capability: "Delete clones",
    description: "Permanently remove clones (admin+ only)",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS DELETE on clones",
      detail:
        "Policy 'Admins can delete clones': USING has_role(auth.uid(), 'admin'). Only admin and super_admin (who also has admin-level access) can delete.",
    },
  },
  {
    category: "Fleet Management",
    capability: "Manage backends",
    description: "Provision / retry clone dedicated backends",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS ALL on clone_backends",
      detail:
        "Policy 'Admins can write clone_backends': USING/WITH CHECK has_role(auth.uid(), 'admin'). Full CRUD restricted to admin+ roles.",
    },
  },
  // ── Cascades ──
  {
    category: "Cascades",
    capability: "View cascades",
    description: "Read cascade events and results",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS SELECT on cascade_events/results",
      detail:
        "Policies 'Operators can read cascade_events/results': USING is_operator(auth.uid()). Any operator-level user or above can view.",
    },
  },
  {
    category: "Cascades",
    capability: "Execute cascades",
    description: "Trigger cascade operations",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS ALL on cascade_events",
      detail:
        "Policy 'Operators can write cascade_events': USING/WITH CHECK is_operator(auth.uid()). Operators can create and update cascade events.",
    },
  },
  {
    category: "Cascades",
    capability: "Approve cascades",
    description: "Second-operator approval for high-blast-radius cascades",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS INSERT on cascade_approvals",
      detail:
        "Policy 'Operators insert cascade_approvals (not self)': WITH CHECK (is_operator AND approver = auth.uid() AND initiator ≠ auth.uid()). Prevents self-approval.",
    },
  },
  // ── Modules ──
  {
    category: "Modules",
    capability: "View modules",
    description: "Browse the module catalog",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS SELECT on modules",
      detail: "Policy 'Operators can read modules': USING is_operator(auth.uid()).",
    },
  },
  {
    category: "Modules",
    capability: "Install / remove modules",
    description: "Modify clone module sets",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS ALL on clone_modules",
      detail:
        "Policy 'Operators can write clone_modules': USING/WITH CHECK is_operator(auth.uid()). Any operator+ can install or remove modules from clones.",
    },
  },
  {
    category: "Modules",
    capability: "Detect modules (AI)",
    description: "Run AI module detection on prime",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "server",
      label: "Server function auth middleware",
      detail:
        "Server function requireSupabaseAuth middleware validates the session. The AI detection endpoint additionally checks is_operator via RPC before proceeding.",
    },
  },
  // ── Settings ──
  {
    category: "Settings",
    capability: "Edit prime config",
    description: "Change prime repo, default branch, cascade mode",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS ALL on prime_config",
      detail:
        "Policy 'Admins can write prime config': USING/WITH CHECK has_role(auth.uid(), 'admin'). Only admin+ can modify prime configuration.",
    },
  },
  {
    category: "Settings",
    capability: "Manage GitHub App",
    description: "Configure App secrets and webhook",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "none",
      user: "none",
    },
    enforcement: {
      type: "server",
      label: "Server function + admin check",
      detail:
        "GitHub App configuration server functions validate has_role(auth.uid(), 'admin') via RPC before accepting changes to secrets or webhook configuration.",
    },
  },
  {
    category: "Settings",
    capability: "View audit log",
    description: "Read operational audit trail",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS SELECT on audit_log",
      detail:
        "Policy 'Operators can read audit_log': USING is_operator(auth.uid()). Append-only — no UPDATE or DELETE policies exist on audit_log.",
    },
  },
  // ── Notifications ──
  {
    category: "Notifications",
    capability: "Manage own push",
    description: "Enable/disable push notifications on own devices",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "full",
    },
    enforcement: {
      type: "rls",
      label: "RLS on push_subscriptions (own rows)",
      detail:
        "Multiple policies: 'Users manage own push subscriptions insert/select/update/delete' all use USING/WITH CHECK (auth.uid() = user_id). Every authenticated user can manage their own device subscriptions.",
    },
  },
  {
    category: "Notifications",
    capability: "View all subscriptions",
    description: "See all push device subscriptions",
    access: {
      high_king: "full",
      super_admin: "full",
      admin: "full",
      operator: "full",
      user: "none",
    },
    enforcement: {
      type: "rls",
      label: "RLS SELECT on push_subscriptions (all)",
      detail:
        "Policy 'Operators read all push subscriptions': USING is_operator(auth.uid()). Operators can see all device subscriptions for monitoring purposes.",
    },
  },
];

const ENFORCEMENT_ICONS: Record<string, typeof Lock> = {
  rls: Database,
  function: Lock,
  trigger: Shield,
  server: Lock,
  system: Crown,
};

const ENFORCEMENT_COLORS: Record<string, string> = {
  rls: "text-primary",
  function: "text-accent",
  trigger: "text-warning",
  server: "text-info",
  system: "text-warning",
};

function CapCell({
  cap,
  enforcement,
  role,
  capability,
}: {
  cap: Capability;
  enforcement: PermissionRow["enforcement"];
  role: AppRole;
  capability: string;
}) {
  const EnfIcon = ENFORCEMENT_ICONS[enforcement.type] ?? Lock;
  const enfColor = ENFORCEMENT_COLORS[enforcement.type] ?? "text-muted-foreground";

  const content = (
    <div className="space-y-2 max-w-xs">
      <div className="flex items-center gap-2">
        <EnfIcon className={cn("h-3.5 w-3.5 shrink-0", enfColor)} />
        <span className="font-mono text-[11px] font-semibold">{enforcement.label}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{enforcement.detail}</p>
      <div className="flex items-center gap-1.5 pt-1 border-t border-border/40">
        <Badge variant="outline" className="text-[9px] font-mono">
          {enforcement.type.toUpperCase()}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {cap === "full" ? "Granted" : cap === "limited" ? "Conditionally granted" : "Blocked"} for{" "}
          {ROLES.find((r) => r.role === role)?.label}
        </span>
      </div>
    </div>
  );

  const icon =
    cap === "full" ? (
      <Check className="h-4 w-4 text-success" />
    ) : cap === "limited" ? (
      <Minus className="h-4 w-4 text-warning" />
    ) : (
      <X className="h-4 w-4 text-muted-foreground/40" />
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group relative flex justify-center w-full py-1 rounded hover:bg-muted/50 transition-colors cursor-pointer"
        >
          {icon}
          <Info className="absolute top-0 right-0 h-2.5 w-2.5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-80">
        {content}
      </PopoverContent>
    </Popover>
  );
}

export const Route = createFileRoute("/settings/permission-matrix")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <PermissionMatrixPage />,
  head: () => ({
    meta: [{ title: "Permission Matrix — Aurixa Systems Mission Control" }],
  }),
});

function PermissionMatrixPage() {
  const categories = Array.from(new Set(PERMISSIONS.map((p) => p.category)));

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
          <Grid3x3 className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
            rbac matrix
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Permission Matrix</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What each role can do inside the dashboard. Click any cell to see the exact backend rule
            that grants or blocks access.
          </p>
        </div>
      </header>

      {/* Legend */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-4">
          <div className="flex items-center gap-1.5 text-sm">
            <Check className="h-4 w-4 text-success" /> <span>Full access</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <Minus className="h-4 w-4 text-warning" /> <span>Limited (hierarchy-scoped)</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <X className="h-4 w-4 text-muted-foreground/40" /> <span>No access</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5" /> Click any cell to see enforcement details
          </div>
        </CardContent>
      </Card>

      {categories.map((cat) => (
        <Card key={cat}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{cat}</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">Capability</TableHead>
                  {ROLES.map((r) => {
                    const Icon = r.icon;
                    return (
                      <TableHead key={r.role} className="text-center w-[100px]">
                        <div className="flex flex-col items-center gap-1">
                          <Icon className={cn("h-4 w-4", r.color)} />
                          <span className="text-[10px] font-mono">{r.label}</span>
                          <Badge variant="outline" className="text-[9px] font-mono">
                            {r.level}
                          </Badge>
                        </div>
                      </TableHead>
                    );
                  })}
                  <TableHead className="w-[40px] text-center">
                    <Info className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PERMISSIONS.filter((p) => p.category === cat).map((perm) => (
                  <TableRow key={perm.capability}>
                    <TableCell>
                      <div>
                        <div className="text-sm font-medium">{perm.capability}</div>
                        <div className="text-[11px] text-muted-foreground">{perm.description}</div>
                      </div>
                    </TableCell>
                    {ROLES.map((r) => (
                      <TableCell key={r.role} className="text-center p-1">
                        <CapCell
                          cap={perm.access[r.role]}
                          enforcement={perm.enforcement}
                          role={r.role}
                          capability={perm.capability}
                        />
                      </TableCell>
                    ))}
                    <TableCell className="text-center">
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="p-1 rounded hover:bg-muted/50 transition-colors"
                          >
                            {(() => {
                              const EnfIcon = ENFORCEMENT_ICONS[perm.enforcement.type] ?? Lock;
                              const enfColor =
                                ENFORCEMENT_COLORS[perm.enforcement.type] ??
                                "text-muted-foreground";
                              return <EnfIcon className={cn("h-3.5 w-3.5", enfColor)} />;
                            })()}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="left" align="center" className="w-80">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              {(() => {
                                const EnfIcon = ENFORCEMENT_ICONS[perm.enforcement.type] ?? Lock;
                                const enfColor =
                                  ENFORCEMENT_COLORS[perm.enforcement.type] ??
                                  "text-muted-foreground";
                                return <EnfIcon className={cn("h-4 w-4", enfColor)} />;
                              })()}
                              <span className="font-mono text-xs font-semibold">
                                {perm.enforcement.label}
                              </span>
                            </div>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {perm.enforcement.detail}
                            </p>
                            <Badge variant="outline" className="text-[9px] font-mono">
                              {perm.enforcement.type.toUpperCase()}
                            </Badge>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
