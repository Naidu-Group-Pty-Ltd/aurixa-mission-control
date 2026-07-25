// Outbound invite management — the only door into this closed system.
// Super admins (and the High King) mint invite links; sign-up is deprecated.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  createUserInvite,
  listUserInvites,
  revokeUserInvite,
} from "@/server/user-invites.functions";
import { useUserRoles } from "@/lib/use-user-roles";
import { ROLE_LEVELS } from "@/integrations/supabase/roles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { CopyButton } from "@/components/copy-button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { Loader2, Lock, Mail, MailPlus, RefreshCw, Send, ShieldX, Trash2 } from "lucide-react";

export const Route = createFileRoute("/settings/invites")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <InvitesPage />,
  head: () => ({
    meta: [{ title: "Invites — Aurixa Systems Mission Control" }],
  }),
});

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  operator: "Operator",
  user: "User",
};

const TTL_OPTIONS = [
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
] as const;

type InviteRow = Awaited<ReturnType<typeof listUserInvites>>["invites"][number];

const STATUS_STYLES: Record<InviteRow["status"], string> = {
  pending: "border-primary/40 bg-primary/10 text-primary",
  accepted: "border-success/40 bg-success/10 text-success",
  revoked: "border-destructive/40 bg-destructive/10 text-destructive",
  expired: "border-border bg-muted text-muted-foreground",
};

function InvitesPage() {
  const { isSuperAdmin, level, loading: rolesLoading } = useUserRoles();
  const createFn = useServerFn(createUserInvite);
  const revokeFn = useServerFn(revokeUserInvite);

  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Mint form state ──
  const [role, setRole] = useState<string>("user");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [ttl, setTtl] = useState<number>(24 * 7);
  const [minting, setMinting] = useState(false);
  // The freshly minted link — shown exactly once.
  const [mintedLink, setMintedLink] = useState<string | null>(null);

  const invitableRoles = useMemo(
    () =>
      (["user", "operator", "admin", "super_admin"] as const).filter((r) => ROLE_LEVELS[r] < level),
    [level],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listUserInvites();
      setInvites(res.invites);
    } catch {
      toast.error("Failed to load invites");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) refresh();
  }, [isSuperAdmin, refresh]);

  if (rolesLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking access…
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <Alert className="border-warning/40 bg-warning/5">
        <ShieldX className="h-4 w-4 text-warning" />
        <AlertTitle className="font-mono text-sm">Super admin required</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          This is a closed system — only super admins (and the High King) can issue outbound invite
          links. Ask a super admin if someone needs access.
        </AlertDescription>
      </Alert>
    );
  }

  const mint = async () => {
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) {
      toast.error("Enter a valid email, or leave it empty for an open invite");
      return;
    }
    setMinting(true);
    try {
      const res = await createFn({
        data: {
          role: role as "user" | "operator" | "admin" | "super_admin",
          email: email.trim() ? email.trim() : undefined,
          note: note.trim() ? note.trim() : undefined,
          ttlHours: ttl,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const link = `${window.location.origin}/join/${res.token}`;
      setMintedLink(link);
      setEmail("");
      setNote("");
      toast.success("Invite minted — copy the link now, it won't be shown again");
      refresh();
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (inv: InviteRow) => {
    const res = await revokeFn({ data: { inviteId: inv.id } });
    if (res.ok) {
      toast.success(`Revoked invite ${inv.token_prefix}…`);
      refresh();
    } else {
      toast.error(res.error);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/40">
            <MailPlus className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
              closed system
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Outbound Invites</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Sign-up is disabled — invite links are the only way new users can join.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </header>

      {/* Mint */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Issue an invite link</CardTitle>
          <CardDescription>
            The link grants one account with the selected role. You can only grant roles below your
            own level.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Role granted</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose role" />
                </SelectTrigger>
                <SelectContent>
                  {invitableRoles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]} (level {ROLE_LEVELS[r]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Expires in</Label>
              <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_OPTIONS.map((o) => (
                    <SelectItem key={o.hours} value={String(o.hours)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>
                Lock to email <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                type="email"
                placeholder="person@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Note <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                placeholder="Why this invite exists"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={mint} disabled={minting || !role}>
            {minting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {minting ? "Minting…" : "Mint invite link"}
          </Button>

          {mintedLink && (
            <Alert className="border-success/40 bg-success/5">
              <Lock className="h-4 w-4 text-success" />
              <AlertTitle className="font-mono text-sm">Invite link ready — copy it now</AlertTitle>
              <AlertDescription className="space-y-2 text-xs text-muted-foreground">
                <p>
                  This link is shown once. Only its hash is stored, so it cannot be recovered later
                  — send it to the invitee through a trusted channel.
                </p>
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                    {mintedLink}
                  </code>
                  <CopyButton value={mintedLink} label="invite link" />
                </div>
                <Button size="sm" variant="ghost" onClick={() => setMintedLink(null)}>
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Issued invites ({invites.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading invites…</div>
          ) : invites.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No invites issued yet.
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {invites.map((inv) => (
                <div key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-xs text-foreground">{inv.token_prefix}…</code>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {ROLE_LABELS[inv.role] ?? inv.role}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn("font-mono text-[10px]", STATUS_STYLES[inv.status])}
                      >
                        {inv.status}
                      </Badge>
                      {inv.email && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Mail className="h-3 w-3" /> {inv.email}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      Minted {formatDistanceToNow(inv.created_at)} by{" "}
                      {inv.invited_by_name ?? "unknown"}
                      {inv.status === "pending" && (
                        <> · expires {new Date(inv.expires_at).toLocaleString()}</>
                      )}
                      {inv.status === "accepted" && inv.accepted_at && (
                        <>
                          {" "}
                          · accepted {formatDistanceToNow(inv.accepted_at)}
                          {inv.accepted_by_name ? ` by ${inv.accepted_by_name}` : ""}
                        </>
                      )}
                      {inv.note && <> · “{inv.note}”</>}
                    </div>
                  </div>
                  {inv.status === "pending" && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-destructive">
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> Revoke
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Revoke this invite?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The link {inv.token_prefix}… will stop working immediately. This cannot
                            be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => revoke(inv)}>Revoke</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
