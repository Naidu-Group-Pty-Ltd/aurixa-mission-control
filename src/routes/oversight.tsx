// The High King's oversight chamber — full visibility of all actions taken by
// every user tier. Server-side both endpoints are gated by requireHighKing;
// the ProtectedRoute requireRole gate here is UX, not the security boundary.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { getOversightOverview, getOversightFeed } from "@/server/oversight.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Crown,
  Gem,
  Inbox,
  MailPlus,
  RefreshCw,
  Shield,
  User,
  Users,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/oversight")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute requireRole="high_king">
      <OversightPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Oversight — Aurixa Systems Mission Control" }] }),
});

const TIER_META: Record<string, { label: string; icon: typeof Crown; color: string }> = {
  high_king: { label: "High King", icon: Crown, color: "text-warning" },
  super_admin: { label: "Super Admin", icon: Gem, color: "text-warning" },
  admin: { label: "Admin", icon: Shield, color: "text-primary" },
  operator: { label: "Operator", icon: Wrench, color: "text-accent" },
  user: { label: "User", icon: User, color: "text-muted-foreground" },
};

const TIER_ORDER = ["high_king", "super_admin", "admin", "operator", "user"] as const;

const PREFIX_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "role.", label: "Role changes" },
  { value: "invite.", label: "Invites" },
  { value: "clone.", label: "Clones" },
  { value: "cascade.", label: "Cascades" },
  { value: "modules.", label: "Modules" },
  { value: "fleet.", label: "Fleet" },
];

type Overview = Awaited<ReturnType<typeof getOversightOverview>>;
type FeedEntry = Awaited<ReturnType<typeof getOversightFeed>>["entries"][number];

function OversightPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefix, setPrefix] = useState("all");
  const [actor, setActor] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, fd] = await Promise.all([
        getOversightOverview(),
        getOversightFeed({
          data: {
            actionPrefix: prefix === "all" ? undefined : prefix,
            actorUserId: actor === "all" ? undefined : actor,
          },
        }),
      ]);
      setOverview(ov);
      setFeed(fd.entries);
    } catch {
      toast.error("Failed to load oversight data");
    } finally {
      setLoading(false);
    }
  }, [prefix, actor]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const actorOptions = useMemo(() => {
    const roster = overview?.roster ?? [];
    return roster.map((r) => ({
      value: r.user_id,
      label: r.display_name ?? r.user_id.slice(0, 8),
    }));
  }, [overview]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-warning/15 ring-1 ring-warning/40">
            <Crown className="h-5 w-5 text-warning" />
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
              the throne sees all
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">High King Oversight</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every action, by every tier, across the whole system — annotated with the rank that
              took it.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </header>

      {/* Pulse tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Users className="h-4 w-4" />
              <span className="font-mono text-[11px] uppercase tracking-wider">Subjects</span>
            </div>
            <div className="mt-1 text-2xl font-semibold">{overview?.totalUsers ?? "—"}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {TIER_ORDER.map((t) => {
                const n = overview?.tierCounts?.[t] ?? 0;
                if (!n) return null;
                const meta = TIER_META[t];
                return (
                  <Badge key={t} variant="outline" className="font-mono text-[10px]">
                    <span className={meta.color}>{meta.label}</span>
                    <span className="ml-1">{n}</span>
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Activity className="h-4 w-4" />
              <span className="font-mono text-[11px] uppercase tracking-wider">Actions · 24h</span>
            </div>
            <div className="mt-1 text-2xl font-semibold">{overview?.actions24h ?? "—"}</div>
            <p className="mt-1 text-[11px] text-muted-foreground">across all tiers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Activity className="h-4 w-4" />
              <span className="font-mono text-[11px] uppercase tracking-wider">Actions · 7d</span>
            </div>
            <div className="mt-1 text-2xl font-semibold">{overview?.actions7d ?? "—"}</div>
            <p className="mt-1 text-[11px] text-muted-foreground">rolling week</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <MailPlus className="h-4 w-4" />
              <span className="font-mono text-[11px] uppercase tracking-wider">Invites</span>
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {overview?.invitePipeline.pending ?? "—"}
              <span className="ml-1 text-sm font-normal text-muted-foreground">pending</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {overview
                ? `${overview.invitePipeline.accepted} accepted · ${overview.invitePipeline.revoked} revoked · ${overview.invitePipeline.expired} expired`
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Roster */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Realm roster</CardTitle>
          <CardDescription>Every account holding a seat, highest tier first.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!overview ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : overview.roster.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No users found.</div>
          ) : (
            <div className="divide-y divide-border/60">
              {overview.roster.map((u) => {
                const meta = u.top_role ? TIER_META[u.top_role] : null;
                const Icon = meta?.icon ?? User;
                return (
                  <div key={u.user_id} className="flex items-center gap-3 px-4 py-2.5">
                    <Icon className={cn("h-4 w-4 shrink-0", meta?.color)} />
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-sm font-medium">
                        {u.display_name ?? u.user_id.slice(0, 8)}
                      </span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {u.user_id}
                      </span>
                    </div>
                    {meta && (
                      <Badge
                        variant="secondary"
                        className={cn("font-mono text-[10px]", meta.color)}
                      >
                        {meta.label}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action feed */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Action feed</CardTitle>
              <CardDescription>
                The append-only audit trail, newest first. Click a row for its metadata.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={prefix} onValueChange={setPrefix}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PREFIX_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={actor} onValueChange={setActor}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All actors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actors</SelectItem>
                  {actorOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && feed.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading feed…</div>
          ) : feed.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="Nothing to see"
              description="No audited actions match the current filters."
            />
          ) : (
            <div className="divide-y divide-border/60">
              {feed.map((e) => {
                const tierMeta = e.actor_tier ? TIER_META[e.actor_tier] : null;
                const isOpen = expanded === e.id;
                const hasMeta = e.metadata && Object.keys(e.metadata as object).length > 0;
                return (
                  <div key={e.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
                      onClick={() => setExpanded(isOpen ? null : e.id)}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                        {e.action}
                      </Badge>
                      <div className="min-w-0 flex-1 text-sm">
                        <span className="font-medium">
                          {e.actor_name ??
                            (e.actor_user_id ? e.actor_user_id.slice(0, 8) : "system")}
                        </span>
                        {tierMeta && (
                          <span className={cn("ml-2 font-mono text-[10px]", tierMeta.color)}>
                            {tierMeta.label}
                          </span>
                        )}
                        {e.entity_type && (
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            → {e.entity_type}
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {formatDistanceToNow(e.created_at)}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-border/40 bg-muted/20 px-11 py-3">
                        {hasMeta ? (
                          <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {JSON.stringify(e.metadata, null, 2)}
                          </pre>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">No metadata.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
