import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { History, RotateCcw, GitBranch, Dot, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";

type CascadeEvent = Database["public"]["Tables"]["cascade_events"]["Row"];
type ScopeMeta = { retry_of?: string; rollback_of?: string };

type LineageNode = CascadeEvent & {
  relation: "self" | "retry" | "rollback" | "ancestor";
  depth: number;
};

const MAX_ANCESTOR_DEPTH = 10;

function statusTone(s: CascadeEvent["status"]) {
  switch (s) {
    case "completed":
      return "border-success/40 text-success";
    case "failed":
      return "border-destructive/40 text-destructive";
    case "partial":
      return "border-warning/40 text-warning";
    case "running":
      return "border-info/40 text-info";
    default:
      return "border-border text-muted-foreground";
  }
}

function relationMeta(rel: LineageNode["relation"]) {
  switch (rel) {
    case "self":
      return {
        Icon: Dot,
        label: "current",
        tone: "text-foreground bg-foreground/10 border-foreground/30",
      };
    case "retry":
      return { Icon: RotateCcw, label: "retry", tone: "text-info bg-info/10 border-info/40" };
    case "rollback":
      return {
        Icon: History,
        label: "rollback",
        tone: "text-warning bg-warning/10 border-warning/40",
      };
    case "ancestor":
      return {
        Icon: GitBranch,
        label: "ancestor",
        tone: "text-muted-foreground bg-muted/40 border-border",
      };
  }
}

export function CascadeLineagePanel({ event }: { event: CascadeEvent }) {
  const [nodes, setNodes] = useState<LineageNode[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      // Walk ancestors via scope_filter->>'retry_of' or 'rollback_of'.
      const ancestors: LineageNode[] = [];
      let cursor: CascadeEvent | null = event;
      let depth = 0;
      while (cursor && depth < MAX_ANCESTOR_DEPTH) {
        const meta = (cursor.scope_filter ?? {}) as ScopeMeta;
        const parentId = meta.retry_of ?? meta.rollback_of;
        if (!parentId) break;
        const { data: parent } = await supabase
          .from("cascade_events")
          .select("*")
          .eq("id", parentId)
          .maybeSingle();
        if (!parent) break;
        ancestors.unshift({ ...parent, relation: "ancestor", depth: -(depth + 1) });
        cursor = parent;
        depth += 1;
      }

      // Find descendants where scope_filter contains retry_of or rollback_of = event.id.
      const [retriesRes, rollbacksRes] = await Promise.all([
        supabase
          .from("cascade_events")
          .select("*")
          .contains("scope_filter", { retry_of: event.id })
          .order("created_at", { ascending: true }),
        supabase
          .from("cascade_events")
          .select("*")
          .contains("scope_filter", { rollback_of: event.id })
          .order("created_at", { ascending: true }),
      ]);

      const retries: LineageNode[] = (retriesRes.data ?? []).map((e) => ({
        ...e,
        relation: "retry",
        depth: 1,
      }));
      const rollbacks: LineageNode[] = (rollbacksRes.data ?? []).map((e) => ({
        ...e,
        relation: "rollback",
        depth: 1,
      }));

      const self: LineageNode = { ...event, relation: "self", depth: 0 };
      const all = [...ancestors, self, ...retries, ...rollbacks];

      if (!cancelled) {
        setNodes(all);
        setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, event.updated_at]);

  // Hide entirely if there's no lineage to show.
  if (!loading && nodes && nodes.length <= 1) return null;

  return (
    <Card className="border-border/80">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          Cascade lineage
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {loading || !nodes ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading chain…
          </div>
        ) : (
          <ol className="relative space-y-3 border-l border-border pl-5">
            {nodes.map((n) => {
              const { Icon, label, tone } = relationMeta(n.relation);
              const isSelf = n.relation === "self";
              const content = (
                <div
                  className={cn(
                    "group relative -ml-[31px] flex items-start gap-3 rounded-md border bg-card/40 p-2.5 transition-colors",
                    isSelf
                      ? "border-foreground/30 bg-foreground/[0.04]"
                      : "border-transparent hover:border-border hover:bg-card/80",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-background",
                      tone,
                    )}
                  >
                    <Icon className="h-3 w-3" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "font-mono text-[9px] uppercase tracking-wider",
                          isSelf ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {label}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn("text-[9px] uppercase", statusTone(n.status))}
                      >
                        {n.status}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] uppercase">
                        {n.mode.replace("_", " ")}
                      </Badge>
                      <code className="font-mono text-[10px] text-muted-foreground">
                        {n.id.slice(0, 8)}
                      </code>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {n.summary ?? "—"}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                      {n.trigger} · {formatDistanceToNow(n.created_at)}
                    </div>
                  </div>
                </div>
              );

              return (
                <li key={n.id}>
                  {isSelf ? (
                    content
                  ) : (
                    <Link to="/cascades/$eventId" params={{ eventId: n.id }} className="block">
                      {content}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}