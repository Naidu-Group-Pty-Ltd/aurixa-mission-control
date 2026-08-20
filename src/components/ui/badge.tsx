import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * A badge is a LABEL, not a decoration.
 *
 * These are deliberately quiet. The previous set were filled, rounded and
 * semibold, so four of them on one record competed with each other and with
 * the record's actual name. Here the default is a hairline outline in the mono
 * label voice; the filled variants stay for the rare case that genuinely needs
 * to stop someone (a destructive state, a primary count).
 *
 * Status does NOT belong in a badge. Use the `.spine` on the record and one
 * uppercase word — see `styles.css`.
 */
const badgeVariants = cva(
  "inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.14em] transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default: "border-primary/40 bg-primary/10 text-primary",
        secondary: "border-border bg-transparent text-muted-foreground",
        destructive: "border-destructive/45 bg-destructive/10 text-destructive",
        outline: "border-border bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
