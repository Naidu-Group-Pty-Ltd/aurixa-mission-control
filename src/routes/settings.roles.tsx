import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth";
import {
  listUsersWithRoles,
  getMyRoleLevel,
  assignRole,
  revokeRole,
} from "@/server/role-management.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Crown,
  Gem,
  Shield,
  Wrench,
  User,
  UserPlus,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Search,
  Filter,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";

type AppRole = Database["public"]["Enums"]["app_role"];

const ROLE_META: Record<
  AppRole,
  { label: string; level: number; icon: typeof Crown; color: string }
> = {
  high_king: { label: "High King", level: 1000, icon: Crown, color: "text-warning" },
  super_admin: { label: "Super Admin", level: 100, icon: Gem, color: "text-warning" },
  admin: { label: "Admin", level: 80, icon: Shield, color: "text-primary" },
  operator: { label: "Operator", level: 50, icon: Wrench, color: "text-accent" },
  user: { label: "User", level: 10, icon: User, color: "text-muted-foreground" },
};

const ALL_ROLES: AppRole[] = ["high_king", "super_admin", "admin", "operator", "user"];

export const Route = createFileRoute("/settings/roles")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <RolesPage />,
  head: () => ({
    meta: [{ title: "Role Management — Aurixa Systems Mission Control" }],
  }),
});

function RolesPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<Awaited<ReturnType<typeof listUsersWithRoles>>["users"]>([]);
  const [myLevel, setMyLevel] = useState(0);
  const [loading, setLoading] = useState(true);

  // ── Search & filter state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<AppRole | "all">("all");

  const assignRoleFn = useServerFn(assignRole);
  const revokeRoleFn = useServerFn(revokeRole);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, levelRes] = await Promise.all([listUsersWithRoles(), getMyRoleLevel()]);
      setUsers(usersRes.users);
      setMyLevel(levelRes.level);
    } catch (e) {
      toast.error("Failed to load roles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Filtered users ──
  const filteredUsers = useMemo(() => {
    let result = users;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (u) => u.display_name?.toLowerCase().includes(q) || u.user_id.toLowerCase().includes(q),
      );
    }
    if (roleFilter !== "all") {
      result = result.filter((u) => u.roles.some((r) => r.role === roleFilter));
    }
    return result;
  }, [users, searchQuery, roleFilter]);

  const assignableRoles = ALL_ROLES.filter((r) => ROLE_META[r].level < myLevel);

  const handleAssign = async (
    targetUserId: string,
    role: AppRole,
    opts?: { displayName?: string; previousLabel?: string; verb?: string },
  ) => {
    const res = await assignRoleFn({ data: { targetUserId, role } });
    const who = opts?.displayName ?? "user";
    const verb = opts?.verb ?? "Assigned";
    if (res.ok) {
      toast.success(
        opts?.previousLabel
          ? `${verb} ${who}: ${opts.previousLabel} → ${ROLE_META[role].label}`
          : `${verb} ${ROLE_META[role].label} to ${who}`,
        { icon: <CheckCircle2 className="h-4 w-4" /> },
      );
      refresh();
      return true;
    }
    toast.error(res.error, { description: `Could not ${verb.toLowerCase()} ${who}` });
    return false;
  };

  const handleRevoke = async (
    roleId: string,
    targetUserId: string,
    role: string,
    opts?: { displayName?: string; silent?: boolean },
  ) => {
    const res = await revokeRoleFn({
      data: { roleId, targetUserId, role },
    });
    const who = opts?.displayName ?? "user";
    if (res.ok) {
      if (!opts?.silent) {
        toast.success(`Revoked ${ROLE_META[role as AppRole]?.label ?? role} from ${who}`);
        refresh();
      }
      return true;
    }
    toast.error(res.error, { description: `Could not revoke role from ${who}` });
    return false;
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
              access control
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Role Management</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your level: <span className="font-mono text-foreground">{myLevel}</span> — you can
              assign roles below level {myLevel}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </header>

      {/* Hierarchy legend */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Role Hierarchy</CardTitle>
          <CardDescription>
            You can only assign roles strictly below your own level.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {ALL_ROLES.map((r) => {
              const meta = ROLE_META[r];
              const Icon = meta.icon;
              const isAssignable = meta.level < myLevel;
              return (
                <div
                  key={r}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                    isAssignable
                      ? "border-border bg-surface"
                      : "border-border/40 bg-muted/30 opacity-60",
                  )}
                >
                  <Icon className={cn("h-4 w-4", meta.color)} />
                  <span className="font-medium">{meta.label}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {meta.level}
                  </Badge>
                  {isAssignable && <span className="text-[10px] text-success">assignable</span>}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Search & Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or user ID…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as AppRole | "all")}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Filter by role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {ALL_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_META[r].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(searchQuery || roleFilter !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchQuery("");
                  setRoleFilter("all");
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* User list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            Users ({filteredUsers.length}
            {filteredUsers.length !== users.length && ` of ${users.length}`})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading users…</div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {users.length === 0 ? "No users found." : "No users match your search or filter."}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {filteredUsers.map((u) => (
                <UserRow
                  key={u.user_id}
                  user={u}
                  myLevel={myLevel}
                  myUserId={user?.id ?? ""}
                  assignableRoles={assignableRoles}
                  onAssign={handleAssign}
                  onRevoke={handleRevoke}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UserRow({
  user: u,
  myLevel,
  myUserId,
  assignableRoles,
  onAssign,
  onRevoke,
}: {
  user: Awaited<ReturnType<typeof listUsersWithRoles>>["users"][0];
  myLevel: number;
  myUserId: string;
  assignableRoles: AppRole[];
  onAssign: (
    userId: string,
    role: AppRole,
    opts?: { displayName?: string; previousLabel?: string; verb?: string },
  ) => Promise<boolean>;
  onRevoke: (
    roleId: string,
    userId: string,
    role: string,
    opts?: { displayName?: string; silent?: boolean },
  ) => Promise<boolean>;
}) {
  const [selectedRole, setSelectedRole] = useState<AppRole | "">(assignableRoles[0] ?? "");
  const [busy, setBusy] = useState<null | "promote" | "demote" | "assign">(null);
  const [confirm, setConfirm] = useState<null | {
    kind: "promote" | "demote";
    from: AppRole | null;
    to: AppRole | null;
    roleIdToRevoke?: string;
  }>(null);

  const displayName = u.display_name ?? u.user_id.slice(0, 8);
  // Highest current role
  const currentTop = u.roles
    .map((r) => r.role)
    .sort((a, b) => (ROLE_META[b]?.level ?? 0) - (ROLE_META[a]?.level ?? 0))[0];
  const currentTopMeta = currentTop ? ROLE_META[currentTop] : null;
  const currentTopEntry = currentTop ? u.roles.find((r) => r.role === currentTop) : undefined;

  const userMaxLevel = currentTopMeta?.level ?? 0;
  const canManage = myLevel > userMaxLevel && u.user_id !== myUserId;
  const isSelf = u.user_id === myUserId;
  const existingRoles = new Set(u.roles.map((r) => r.role));
  const availableToAssign = assignableRoles.filter((r) => !existingRoles.has(r));

  // Promote target = the next role above currentTop that the actor can assign.
  // high_king is deliberately absent: the seat is seeded, never assigned.
  const ladderAsc: AppRole[] = ["user", "operator", "admin", "super_admin"];
  const promoteTo: AppRole | null = (() => {
    const idx = currentTop ? ladderAsc.indexOf(currentTop) : -1;
    for (let i = idx + 1; i < ladderAsc.length; i++) {
      const candidate = ladderAsc[i];
      if (ROLE_META[candidate].level < myLevel && !existingRoles.has(candidate)) {
        return candidate;
      }
    }
    return null;
  })();

  // Demote target = next role below currentTop (or null = strip the only role).
  // We only allow demoting *down to* baseline 'user'; revoking 'user' itself
  // would lock them out, so block that.
  const demoteTo: AppRole | null = (() => {
    if (!currentTop || currentTop === "user") return null;
    const idx = ladderAsc.indexOf(currentTop);
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = ladderAsc[i];
      // Must be assignable by the actor too (so the user ends up holding it).
      if (ROLE_META[candidate].level < myLevel) {
        return candidate;
      }
    }
    return null;
  })();

  const runPromote = async () => {
    if (!promoteTo) return;
    setBusy("promote");
    await onAssign(u.user_id, promoteTo, {
      displayName,
      previousLabel: currentTopMeta?.label ?? "No role",
      verb: "Promoted",
    });
    setBusy(null);
    setConfirm(null);
  };

  const runDemote = async () => {
    if (!currentTopEntry || !demoteTo) return;
    setBusy("demote");
    // 1) Ensure the lower role exists (assign silently if missing).
    let ok = true;
    if (!existingRoles.has(demoteTo)) {
      ok = await onAssign(u.user_id, demoteTo, {
        displayName,
        verb: "Demoted",
        previousLabel: currentTopMeta?.label ?? undefined,
      });
    }
    // 2) Revoke the higher role.
    if (ok) {
      await onRevoke(currentTopEntry.id, u.user_id, currentTopEntry.role, {
        displayName,
        silent: existingRoles.has(demoteTo), // if we didn't assign, surface this toast
      });
    }
    setBusy(null);
    setConfirm(null);
  };

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-bold uppercase text-muted-foreground">
          {(u.display_name ?? u.user_id)?.[0] ?? "?"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{displayName}</span>
            {isSelf && (
              <Badge variant="outline" className="text-[10px]">
                you
              </Badge>
            )}
            {currentTopMeta && (
              <Badge
                variant="secondary"
                className={cn("text-[10px] font-mono", currentTopMeta.color)}
              >
                {currentTopMeta.label}
              </Badge>
            )}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground truncate">{u.user_id}</div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {u.roles.map((r) => {
            const meta = ROLE_META[r.role];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <div
                key={r.id}
                className="group flex items-center gap-1.5 rounded-md border border-border/60 bg-surface px-2 py-1"
              >
                <Icon className={cn("h-3.5 w-3.5", meta.color)} />
                <span className="text-xs font-medium">{meta.label}</span>
                {r.assigned_by && (
                  <span className="text-[10px] text-muted-foreground">
                    · {formatDistanceToNow(r.assigned_at)}
                  </span>
                )}
                {canManage && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button
                        type="button"
                        className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label={`Revoke ${meta.label}`}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke {meta.label}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove the {meta.label} role from {displayName}.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onRevoke(r.id, u.user_id, r.role, { displayName })}
                        >
                          Revoke
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            );
          })}
        </div>

        {canManage && (
          <div className="flex items-center gap-1.5 ml-auto">
            <Button
              variant="outline"
              size="sm"
              disabled={!promoteTo || busy !== null}
              onClick={() =>
                promoteTo &&
                setConfirm({
                  kind: "promote",
                  from: currentTop ?? null,
                  to: promoteTo,
                })
              }
              title={
                promoteTo
                  ? `Promote to ${ROLE_META[promoteTo].label}`
                  : "No higher role available to assign"
              }
            >
              <ArrowUp className="mr-1 h-3.5 w-3.5 text-success" />
              Promote
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!demoteTo || !currentTopEntry || busy !== null}
              onClick={() =>
                demoteTo &&
                currentTopEntry &&
                setConfirm({
                  kind: "demote",
                  from: currentTop ?? null,
                  to: demoteTo,
                  roleIdToRevoke: currentTopEntry.id,
                })
              }
              title={
                demoteTo
                  ? `Demote to ${ROLE_META[demoteTo].label}`
                  : "Cannot demote — already at baseline"
              }
            >
              <ArrowDown className="mr-1 h-3.5 w-3.5 text-warning" />
              Demote
            </Button>
            {availableToAssign.length > 0 && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" /> Assign…
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Assign role to {displayName}</DialogTitle>
                    <DialogDescription>
                      Select a role below your level ({myLevel}) to assign.
                    </DialogDescription>
                  </DialogHeader>
                  <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as AppRole)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose role" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableToAssign.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_META[r].label} (level {ROLE_META[r].level})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedRole && (
                    <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs text-info">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        This grants <strong>{ROLE_META[selectedRole as AppRole]?.label}</strong>{" "}
                        privileges. The user will be able to assign roles below level{" "}
                        {ROLE_META[selectedRole as AppRole]?.level}.
                      </span>
                    </div>
                  )}
                  <DialogFooter>
                    <Button
                      disabled={!selectedRole || busy !== null}
                      onClick={async () => {
                        if (!selectedRole) return;
                        setBusy("assign");
                        await onAssign(u.user_id, selectedRole as AppRole, {
                          displayName,
                        });
                        setBusy(null);
                      }}
                    >
                      {busy === "assign" ? "Assigning…" : "Assign role"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        )}
      </div>

      {/* Promote / Demote confirmation */}
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "promote" ? "Promote" : "Demote"} {displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">
                    {confirm?.from ? ROLE_META[confirm.from].label : "No role"}
                  </span>
                  {confirm?.kind === "promote" ? (
                    <ArrowUp className="h-4 w-4 text-success" />
                  ) : (
                    <ArrowDown className="h-4 w-4 text-warning" />
                  )}
                  <span className="font-mono text-xs font-semibold text-foreground">
                    {confirm?.to ? ROLE_META[confirm.to].label : "—"}
                  </span>
                </div>
                <div className="text-xs">
                  {confirm?.kind === "promote"
                    ? `Grants the ${
                        confirm.to ? ROLE_META[confirm.to].label : ""
                      } role on top of any existing roles.`
                    : `Adds the ${
                        confirm?.to ? ROLE_META[confirm.to].label : ""
                      } role (if missing) and revokes the higher ${
                        confirm?.from ? ROLE_META[confirm.from].label : ""
                      } role.`}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy !== null}
              onClick={(e) => {
                e.preventDefault();
                if (confirm?.kind === "promote") runPromote();
                else runDemote();
              }}
            >
              {busy ? "Working…" : confirm?.kind === "promote" ? "Promote" : "Demote"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
