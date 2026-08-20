// Standardised route-level loading shell. Use inside `if (loading) return ...`
// branches to keep skeleton coherence across pages.
import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function RouteLoading({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="h-5 w-5 animate-spin text-primary" />
      <span className="font-mono text-[11px] uppercase tracking-[0.2em]">{label}</span>
    </div>
  );
}

export function PageHeaderSkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="h-10 w-10" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3 w-72" />
      </div>
    </div>
  );
}
