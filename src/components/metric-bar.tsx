import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/**
 * One plane, not six tiles.
 *
 * The pattern this replaces was a `grid gap-3 lg:grid-cols-6` of `<Card>`s,
 * each with its own border, its own coloured numeral and an icon in a grey
 * rounded square. Six bordered boxes shouting equally give the eye no entry
 * point, so none of them reads — which is the single biggest source of the
 * "there's a lot going on" complaint on every list page in this app.
 *
 * This is ONE glass plane divided by hairline rules, and the important rule is
 * `tone` is only honoured when `alarm` is true: a healthy fleet renders
 * entirely monochrome, so the one amber numeral is the thing you see. Setting
 * a tone on a metric that is always coloured (a total, a count of everything)
 * is how the old version lost its signal.
 *
 * A metric with a `to` becomes the whole cell's link — no chevron, no button.
 */
export type MetricTone = "neutral" | "success" | "warning" | "destructive" | "primary" | "accent";

export type Metric = {
  /** Short lowercase noun. Rendered uppercase by `.label-mono`; keep it to two words. */
  label: string;
  value: ReactNode;
  /** Ignored unless `alarm` is true. */
  tone?: MetricTone;
  /** True when this number is something an operator has to act on. */
  alarm?: boolean;
  /** Optional route; makes the whole cell activatable. */
  to?: string;
  params?: Record<string, string>;
  /** Small mono line under the label — a qualifier, never a second metric. */
  note?: ReactNode;
};

const TONE: Record<MetricTone, string> = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  primary: "text-primary",
  accent: "text-accent",
};

/**
 * One cell of the plane.
 *
 * Exported because nineteen pages had grown their own `StatCard` / `StatTile` /
 * `Stat` — same three lines of markup, nineteen slightly different paddings,
 * type sizes and tone rules. Each of those is now this, and the page keeps its
 * own grid; put `glass grid overflow-hidden` on that grid and drop its `gap`,
 * and the tiles become one divided plane instead of N bordered boxes.
 *
 * `-ml-px -mt-px` is what makes the hairlines survive wrapping — see MetricBar.
 */
export function MetricCell({
  label,
  value,
  tone = "neutral",
  alarm = false,
  note,
  size = "lg",
  className,
}: Omit<Metric, "to" | "params"> & {
  /** `sm` for values that are text rather than a count — money, durations,
      percentages with a suffix. A 32px numeral truncates those in a 4-up grid. */
  size?: "lg" | "sm";
  className?: string;
}) {
  return (
    <div className={cn("-mt-px -ml-px border-t border-l border-border/50 px-5 py-4", className)}>
      <div
        className={cn(
          "numeral leading-none",
          size === "sm" ? "truncate text-xl" : "text-[2rem]",
          alarm ? TONE[tone] : "text-foreground",
        )}
        title={size === "sm" ? String(value) : undefined}
      >
        {value}
      </div>
      <div className="label-mono mt-2">{label}</div>
      {note && <div className="mt-1 font-mono text-[10px] text-muted-foreground">{note}</div>}
    </div>
  );
}

function Cell({ metric }: { metric: Metric }) {
  const tone = metric.alarm ? TONE[metric.tone ?? "neutral"] : "text-foreground";
  return (
    <>
      <div className={cn("numeral text-[2rem] leading-none", tone)}>{metric.value}</div>
      <div className="label-mono mt-2">{metric.label}</div>
      {metric.note && (
        <div className="mt-1 font-mono text-[10px] text-muted-foreground">{metric.note}</div>
      )}
    </>
  );
}

export function MetricBar({ metrics, className }: { metrics: Metric[]; className?: string }) {
  // Column count follows the data. Hard-coding six and passing four leaves two
  // empty cells with borders on them, which reads as a broken row.
  const cols =
    metrics.length <= 2
      ? "grid-cols-2"
      : metrics.length === 3
        ? "grid-cols-3"
        : metrics.length === 4
          ? "grid-cols-2 md:grid-cols-4"
          : metrics.length === 5
            ? "grid-cols-2 md:grid-cols-5"
            : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6";

  return (
    // `overflow-hidden` plus a -1px offset on every cell is what makes the
    // hairlines survive wrapping: each cell draws its own top and left rule,
    // the ones on the first row and first column land outside the padding box
    // and are clipped, and neighbours share a single line instead of doubling
    // it. A `divide-x` here would draw nothing at all on the second row.
    <div className={cn("glass grid overflow-hidden", cols, className)}>
      {metrics.map((metric) => {
        const cell = "-ml-px -mt-px border-l border-t border-border/50 px-5 py-4";
        return metric.to ? (
          <Link
            key={metric.label}
            to={metric.to}
            params={metric.params}
            className={cn(cell, "transition-colors hover:bg-foreground/[0.04]")}
          >
            <Cell metric={metric} />
          </Link>
        ) : (
          <div key={metric.label} className={cell}>
            <Cell metric={metric} />
          </div>
        );
      })}
    </div>
  );
}
