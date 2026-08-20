import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  History,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CircleDot,
  GitFork,
  Trash2,
  Boxes,
  ExternalLink,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";

type Notification = Database["public"]["Tables"]["notifications"]["Row"];
type Kind = Database["public"]["Enums"]["notification_kind"];
type Severity = Database["public"]["Enums"]["notification_severity"];

function iconFor(kind: Kind) {
  switch (kind) {
    case "cascade_completed":
      return CheckCircle2;
    case "cascade_failed":
      return XCircle;
    case "cascade_partial":
      return AlertTriangle;
    case "drift_high":
    case "drift_medium":
      return AlertTriangle;
    case "clone_created":
      return GitFork;
    case "clone_deleted":
      return Trash2;
    case "module_installed":
    case "module_removed":
      return Boxes;
    default:
      return CircleDot;
  }
}

function tone(severity: Severity) {
  switch (severity) {
    case "success":
      return "text-success";
    case "error":
      return "text-destructive";
    case "warning":
      return "text-warning";
    default:
      return "text-info";
  }
}

export function CloneActivityHistory({ cloneId }: { cloneId: string }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .eq("clone_id", cloneId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (!cancelled) {
        setItems(data ?? []);
        setLoading(false);
      }
    };
    void load();

    const channel = supabase
      .channel(`clone-history-${cloneId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `clone_id=eq.${cloneId}`,
        },
        (payload) => {
          const n = payload.new as Notification;
          setItems((prev) => [n, ...prev].slice(0, 100));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [cloneId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-muted-foreground" /> Activity history
        </CardTitle>
        <CardDescription>
          Full timeline of cascades, drift findings, and module changes for this clone.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">
            No activity recorded yet for this clone.
          </div>
        ) : (
          <ScrollArea className="h-[420px]">
            <ol className="relative px-6 py-4">
              <span aria-hidden className="absolute bottom-4 left-[33px] top-4 w-px bg-border/60" />
              {items.map((n) => {
                const Icon = iconFor(n.kind);
                const inner = (
                  <div className="ml-12 border bg-surface p-3 transition-colors hover:bg-muted/30">
                    <div className="flex items-start gap-2">
                      <span className="text-sm font-medium text-foreground">{n.title}</span>
                      <Badge
                        variant="outline"
                        className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider"
                      >
                        {n.kind.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    {n.body && <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>}
                    <div className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {formatDistanceToNow(n.created_at)}
                      {n.url && (
                        <span className="inline-flex items-center gap-0.5 text-accent">
                          · open <ExternalLink className="h-2.5 w-2.5" />
                        </span>
                      )}
                    </div>
                  </div>
                );
                return (
                  <li key={n.id} className="relative pb-3">
                    <span
                      className={cn(
                        "absolute left-[26px] top-3 grid h-4 w-4 place-items-center rounded-full border border-border bg-background",
                        tone(n.severity),
                      )}
                    >
                      <Icon className="h-2.5 w-2.5" />
                    </span>
                    {n.url ? (
                      <Link to={n.url} className="block">
                        {inner}
                      </Link>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
