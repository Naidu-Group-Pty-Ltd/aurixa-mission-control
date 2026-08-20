// Audit log detail drawer — gives a structured view of a single audit entry:
// actor profile, entity link, action, timestamp, and pretty-printed metadata.
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { formatDistanceToNow } from "@/lib/format";
import { ChevronRight, User, Clock } from "lucide-react";
import { CopyButton } from "@/components/copy-button";

type AuditLog = Database["public"]["Tables"]["audit_log"]["Row"];

interface ActorInfo {
  display_name: string | null;
  avatar_url: string | null;
}

export function AuditLogDetailDrawer({
  log,
  onOpenChange,
}: {
  log: AuditLog | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [actor, setActor] = useState<ActorInfo | null>(null);

  useEffect(() => {
    if (!log?.actor_user_id) {
      setActor(null);
      return;
    }
    let cancelled = false;
    void supabase
      .from("profiles")
      .select("display_name, avatar_url")
      .eq("user_id", log.actor_user_id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setActor((data as ActorInfo) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [log?.actor_user_id]);

  const link = log ? entityLink(log) : null;
  const meta = (log?.metadata ?? {}) as Record<string, unknown>;
  const metaEntries = Object.entries(meta);

  return (
    <Sheet open={!!log} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {log && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-base">{log.action}</SheetTitle>
              <SheetDescription className="flex items-center gap-1.5 font-mono text-[11px]">
                <Clock className="h-3 w-3" />
                {formatDistanceToNow(log.created_at)} · {new Date(log.created_at).toLocaleString()}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-5 text-sm">
              {/* Actor */}
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  actor
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                    {actor?.avatar_url ? (
                      <img
                        src={actor.avatar_url}
                        alt=""
                        className="h-full w-full rounded-full object-cover"
                      />
                    ) : (
                      <User className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {actor?.display_name ?? (log.actor_user_id ? "Unknown user" : "System")}
                    </p>
                    {log.actor_user_id && (
                      <div className="flex items-center gap-1">
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {log.actor_user_id}
                        </p>
                        <CopyButton value={log.actor_user_id} label="user id" />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Entity */}
              {log.entity_type && (
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    entity
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {log.entity_type}
                    </Badge>
                    {log.entity_id && (
                      <>
                        <code className="font-mono text-[11px] text-muted-foreground">
                          {log.entity_id}
                        </code>
                        <CopyButton value={log.entity_id} label="entity id" />
                      </>
                    )}
                    {link && (
                      <Link
                        to={link.to}
                        params={link.params}
                        onClick={() => onOpenChange(false)}
                        className="ml-auto inline-flex items-center font-mono text-[11px] text-accent hover:underline"
                      >
                        view <ChevronRight className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  metadata ({metaEntries.length})
                </p>
                {metaEntries.length === 0 ? (
                  <p className="mt-1.5 font-mono text-xs text-muted-foreground">no metadata</p>
                ) : (
                  <dl className="mt-1.5 space-y-1.5">
                    {metaEntries.map(([k, v]) => (
                      <div
                        key={k}
                        className="rounded-md border border-border/60 bg-surface px-2.5 py-1.5"
                      >
                        <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {k}
                        </dt>
                        <dd className="mt-0.5 break-words font-mono text-xs">
                          {typeof v === "object" && v !== null ? (
                            <pre className="overflow-x-auto whitespace-pre-wrap text-[11px]">
                              {JSON.stringify(v, null, 2)}
                            </pre>
                          ) : (
                            String(v)
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function entityLink(
  log: AuditLog,
):
  | { to: "/cascades/$eventId"; params: { eventId: string } }
  | { to: "/clones/$cloneId"; params: { cloneId: string } }
  | null {
  if (log.entity_type === "cascade_event" && log.entity_id) {
    return { to: "/cascades/$eventId", params: { eventId: log.entity_id } };
  }
  if (log.entity_type === "clone" && log.entity_id) {
    return { to: "/clones/$cloneId", params: { cloneId: log.entity_id } };
  }
  return null;
}