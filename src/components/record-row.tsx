import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * One row of a list. A flat plane, not a pane of glass.
 *
 * Twenty-two list sites in this app rendered a `<Card>` per item, so a page
 * showing forty schedules asked the compositor for forty backdrop-filter
 * passes — and, more to the point, drew forty frosted planes at the same depth
 * as the panel containing them. When everything is glass, nothing reads as
 * raised. Glass is for the PANEL; a row inside it is `.glass-inset`, which is
 * the same border and a flat 4% wash.
 *
 * `spine` colours the 3px left edge by state. Use it wherever the row has one
 * — it is the thing the eye finds scanning a column, and it replaces the
 * coloured border, the tinted background and the status pill that used to say
 * the same thing three times.
 */
export type SpineTone = "ok" | "warn" | "bad" | "live" | "idle";

const SPINE: Record<SpineTone, string> = {
  ok: "spine spine-ok",
  warn: "spine spine-warn",
  bad: "spine spine-bad",
  live: "spine spine-live",
  idle: "spine spine-idle",
};

export const RecordRow = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { spine?: SpineTone }
>(({ className, spine, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("glass-inset text-card-foreground", spine && SPINE[spine], className)}
    {...props}
  />
));
RecordRow.displayName = "RecordRow";
