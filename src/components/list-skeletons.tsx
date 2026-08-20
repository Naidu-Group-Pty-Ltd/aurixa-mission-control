import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Generic shimmer card row, used in fleet/cascades history. */
export function CardRowSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("border-border/80", className)}>
      <CardContent className="flex items-center gap-3 p-4">
        <Skeleton className="h-9 w-9" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="h-4 w-16 rounded-full" />
      </CardContent>
    </Card>
  );
}

/** Two-column clones grid loading shimmer. */
export function CloneGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-5 pb-3">
            <div className="flex items-start gap-3">
              <Skeleton className="mt-1.5 h-4 w-4" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <div className="flex gap-1.5">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-12" />
                </div>
              </div>
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </CardHeader>
          <CardContent className="space-y-2 px-5 pb-5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Notifications list shimmer (matches notifications page rows). */
export function NotificationListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="divide-y divide-border/60">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="flex gap-3 px-4 py-3">
          <Skeleton className="mt-1 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Audit log timeline row shimmer. */
export function AuditLogSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ol>
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className={cn("relative px-4 py-3", i !== count - 1 && "border-b border-border/60")}
        >
          <div className="flex items-start gap-3">
            <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Two-column module catalog shimmer. */
export function ModuleGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-5 w-16" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <div className="flex gap-1">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-20" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Fleet manager drift list shimmer. */
export function DriftListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <ul className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="border border-border bg-surface p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-4" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="mt-3 space-y-2 border-t pt-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  );
}
