import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";

type SyncStatus = Database["public"]["Enums"]["sync_status"];

/**
 * Sync state, as one word.
 *
 * This used to be a tinted, bordered badge. On a list page every record then
 * carried at least four such rectangles — status, method, security, tags — and
 * a filled rectangle reads as something you can press. State is not an action,
 * so it is now set as text: mono, uppercase, tone-coloured, with a square tick
 * rather than a round dot because nothing in this system is round.
 *
 * On a record card, pair it with `syncSpine(status)` on the container. The
 * spine is what you actually see scanning a column; the word is the detail you
 * read once you have stopped.
 */
const META: Record<SyncStatus, { label: string; cls: string }> = {
  in_sync: { label: "in sync", cls: "text-success" },
  behind: { label: "behind", cls: "text-warning" },
  cascading: { label: "cascading", cls: "text-info" },
  failed: { label: "failed", cls: "text-destructive" },
  unknown: { label: "unknown", cls: "text-muted-foreground" },
};

/** Spine class for a record whose state is a sync status. */
export function syncSpine(status: SyncStatus | null | undefined) {
  switch (status) {
    case "in_sync":
      return "spine-ok";
    case "behind":
      return "spine-warn";
    case "cascading":
      return "spine-live";
    case "failed":
      return "spine-bad";
    default:
      return "spine-idle";
  }
}

export function StatusPill({
  status,
  behind,
  className,
}: {
  status: SyncStatus;
  behind?: number;
  className?: string;
}) {
  const meta = META[status] ?? META.unknown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] whitespace-nowrap",
        meta.cls,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 bg-current", status === "cascading" && "animate-pulse")}
      />
      {meta.label}
      {status === "behind" && behind ? ` · ${behind}` : ""}
    </span>
  );
}
