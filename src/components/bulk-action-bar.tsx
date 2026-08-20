// Shared bulk-action toolbar — sticky bar that floats at the top of a list
// when one or more rows are selected. Hosts a slot for action buttons.
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BulkActionBar({
  count,
  noun,
  onClear,
  children,
  className,
}: {
  count: number;
  noun: string;
  onClear: () => void;
  children: ReactNode;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <div
      className={cn(
        // `glass-strong` rather than a tinted panel: this bar floats over the
        // list it acts on, and the list has to stay legible behind it. The
        // primary spine is the only colour — a filled bar reads as an alert.
        "glass-strong spine spine-live sticky top-2 z-20 flex flex-wrap items-center gap-2 px-3 py-2",
        className,
      )}
    >
      <span className="label-mono">
        {count} {noun}
        {count === 1 ? "" : "s"} selected
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
      <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear selection">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
