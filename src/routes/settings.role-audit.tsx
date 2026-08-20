import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { getRoleAuditLog } from "@/server/role-management.functions";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  ScrollText,
  RefreshCw,
  UserPlus,
  UserMinus,
  ArrowRight,
  Search,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";

type AuditEntry = Awaited<ReturnType<typeof getRoleAuditLog>>["entries"][0];

export const Route = createFileRoute("/settings/role-audit")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <RoleAuditPage />,
  head: () => ({
    meta: [{ title: "Role Audit Log — Aurixa Systems Mission Control" }],
  }),
});

function RoleAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getRoleAuditLog();
      setEntries(res.entries);
    } catch {
      toast.error("Failed to load role audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = search
    ? entries.filter(
        (e) =>
          e.action.toLowerCase().includes(search.toLowerCase()) ||
          (e.actor_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (e.target_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
          JSON.stringify(e.metadata).toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-info/15 ring-1 ring-info/40">
            <ScrollText className="h-5 w-5 text-info" />
          </div>
          <div>
            <p className="label-mono">delegation trail</p>
            <h1 className="mt-1 font-display text-[1.75rem] leading-[1.1]">Role Audit Log</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every role assignment, revocation, and hierarchy change across all environments.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search actor, target, action…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <CardDescription className="font-mono text-[11px]">
              {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Loading audit entries…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Inbox />}
                title="No role changes recorded"
                description="Role assignments and revocations will appear here as they happen."
              />
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {filtered.map((entry) => (
                <RoleAuditRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RoleAuditRow({ entry }: { entry: AuditEntry }) {
  const meta = entry.metadata as Record<string, unknown>;
  const isAssign = entry.action === "role.assigned";
  const isRevoke = entry.action === "role.revoked";
  const isCloneCreated = entry.action === "clone.created";
  const role = (meta?.role as string) ?? null;

  const ActionIcon = isAssign ? UserPlus : isRevoke ? UserMinus : ScrollText;
  const actionColor = isAssign ? "text-success" : isRevoke ? "text-destructive" : "text-info";

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <ActionIcon className={cn("h-4 w-4", actionColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm font-medium">{entry.action}</code>
            {role && (
              <Badge variant="outline" className="text-[10px] uppercase">
                {role}
              </Badge>
            )}
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatDistanceToNow(entry.created_at)}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {entry.actor_name || entry.actor_user_id ? (
              <span className="flex items-center gap-1">
                <span className="font-medium text-foreground">
                  {entry.actor_name ?? entry.actor_user_id?.slice(0, 8)}
                </span>
              </span>
            ) : (
              <span className="italic">system</span>
            )}

            {(isAssign || isRevoke) && !!meta?.target_user_id && (
              <>
                <ArrowRight className="h-3 w-3" />
                <span className="font-medium text-foreground">
                  {entry.target_name ?? String(meta.target_user_id).slice(0, 8)}
                </span>
              </>
            )}

            {isCloneCreated && !!meta?.method && (
              <span>
                provisioned via <strong>{String(meta.method)}</strong>
                {!!meta?.github_url && (
                  <>
                    {" → "}
                    <span className="font-mono">{String(meta.github_url)}</span>
                  </>
                )}
              </span>
            )}
          </div>

          {/* assigned_by / assigned_at detail */}
          {(isAssign || isRevoke) && (
            <div className="mt-1.5 grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5 border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px]">
              <span className="text-muted-foreground">assigned_by</span>
              <span className="font-mono">
                {entry.actor_user_id?.slice(0, 12) ?? "NULL (system)"}
              </span>
              <span className="text-muted-foreground">assigned_at</span>
              <span className="font-mono">{new Date(entry.created_at).toISOString()}</span>
              {!!meta?.role_id && (
                <>
                  <span className="text-muted-foreground">role_id</span>
                  <span className="font-mono">{String(meta.role_id).slice(0, 12)}…</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
