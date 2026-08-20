import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, History, ListFilter } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { ScheduleFiresSparkline } from "@/components/schedule-fires-sparkline";
import type { Database } from "@/integrations/supabase/types";

type EventRow = Database["public"]["Tables"]["cascade_events"]["Row"];

function statusTone(s: string) {
  switch (s) {
    case "completed":
      return "border-success/40 text-success";
    case "failed":
      return "border-destructive/40 text-destructive";
    case "running":
      return "border-info/40 text-info animate-pulse";
    case "partial":
      return "border-warning/40 text-warning";
    default:
      return "border-muted text-muted-foreground";
  }
}

export function ScheduleRecentFires({ scheduleId }: { scheduleId: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);

      // Pull schedule.executed audit rows for this schedule, then load the
      // cascade events they spawned. audit_log is the cleanest cross-cut
      // since both fleet and module-sync runs log here.
      const { data: audit } = await supabase
        .from("audit_log")
        .select("metadata, created_at")
        .eq("action", "schedule.executed")
        .eq("entity_type", "cascade_schedule")
        .eq("entity_id", scheduleId)
        .order("created_at", { ascending: false })
        .limit(10);

      const eventIds = (audit ?? [])
        .map((a) => {
          const m = (a.metadata ?? {}) as { cascade_event_id?: string | null };
          return m.cascade_event_id ?? null;
        })
        .filter((id): id is string => Boolean(id));

      if (eventIds.length === 0) {
        if (!cancelled) {
          setEvents([]);
          setLoading(false);
        }
        return;
      }

      const { data: evs } = await supabase.from("cascade_events").select("*").in("id", eventIds);

      // Preserve audit order (most recent first).
      const byId = new Map((evs ?? []).map((e) => [e.id, e]));
      const ordered = eventIds.map((id) => byId.get(id)).filter((e): e is EventRow => Boolean(e));

      if (!cancelled) {
        setEvents(ordered);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  if (loading) {
    return <div className="font-mono text-[11px] text-muted-foreground">loading recent fires…</div>;
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <History className="h-3.5 w-3.5" /> No fires yet
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <History className="h-3 w-3" /> recent fires
        </div>
        <div className="flex items-center gap-3">
          <ScheduleFiresSparkline statuses={events.map((e) => e.status)} />
          <Link
            to="/cascades"
            search={{ schedule_id: scheduleId }}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <ListFilter className="h-3 w-3" /> view all fires
          </Link>
        </div>
      </div>
      <ul className="space-y-1">
        {events.map((e) => (
          <li key={e.id}>
            <Link
              to="/cascades/$eventId"
              params={{ eventId: e.id }}
              className="group flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 transition-colors hover:border-primary/40"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("text-[10px] uppercase", statusTone(e.status))}
                >
                  {e.status}
                </Badge>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {formatDistanceToNow(e.created_at)}
                  {e.summary && <span className="text-foreground/70"> · {e.summary}</span>}
                </span>
              </div>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}