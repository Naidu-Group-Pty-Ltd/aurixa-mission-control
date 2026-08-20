import { cn } from "@/lib/utils";
import { FileDiff, Plus, Minus, Edit3 } from "lucide-react";

/**
 * Lightweight inline diff summary for cascade_results.diff_summary.
 *
 * The current cascade engine produces a free-form text summary (e.g.
 * "+ src/foo.ts\n- src/bar.ts\n~ README.md"). We render that as a small
 * file-list with per-line tone, without pulling in a 200kB diff library.
 *
 * If the summary doesn't look like a path list we fall back to plain text.
 */
export function InlineDiffSummary({
  summary,
  filesChanged,
  className,
}: {
  summary: string;
  filesChanged?: number;
  className?: string;
}) {
  const lines = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Heuristic: if every non-empty line starts with +, -, ~ or "M ", treat as
  // structured. Otherwise show as a single paragraph.
  const structured = lines.length > 0 && lines.every((l) => /^[+\-~MAD]\s|^[+\-~]/.test(l));

  if (!structured) {
    return (
      <div
        className={cn(
          "rounded-md border border-border/60 bg-surface p-3 font-mono text-[11px] text-muted-foreground",
          className,
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <FileDiff className="h-3 w-3" />
          diff summary
          {typeof filesChanged === "number" && filesChanged > 0 && (
            <span>
              · {filesChanged} file{filesChanged === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="whitespace-pre-wrap break-words">{summary}</div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border border-border/60 bg-surface p-3", className)}>
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <FileDiff className="h-3 w-3" />
        diff
        {typeof filesChanged === "number" && filesChanged > 0 && (
          <span>
            · {filesChanged} file{filesChanged === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <ul className="space-y-0.5">
        {lines.map((line, i) => {
          const m = line.match(/^([+\-~MAD])\s*(.+)$/);
          const sign = m?.[1] ?? "~";
          const path = m?.[2] ?? line;
          return (
            <li key={i} className="flex items-center gap-1.5 font-mono text-[11px]">
              <DiffMark sign={sign} />
              <span className="truncate text-foreground/90" title={path}>
                {path}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiffMark({ sign }: { sign: string }) {
  if (sign === "+" || sign === "A") {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center bg-success/15 text-success">
        <Plus className="h-3 w-3" />
      </span>
    );
  }
  if (sign === "-" || sign === "D") {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center bg-destructive/15 text-destructive">
        <Minus className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center bg-info/15 text-info">
      <Edit3 className="h-3 w-3" />
    </span>
  );
}
