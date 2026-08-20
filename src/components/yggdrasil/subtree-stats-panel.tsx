/**
 * SubtreeStatsPanel — floating mini-panel showing status breakdown
 * for a selected node's descendants.
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import type { TreeNode } from "./use-tree-layout";

interface Props {
  node: TreeNode;
  zoom: number;
  pan: { x: number; y: number };
  dimensions: { width: number; height: number };
}

const STATUS_META: { key: string; label: string; color: string }[] = [
  { key: "in_sync", label: "In Sync", color: "oklch(0.78 0.18 150)" },
  { key: "behind", label: "Behind", color: "oklch(0.82 0.17 80)" },
  { key: "failed", label: "Failed", color: "oklch(0.66 0.24 25)" },
];

function collectAllDescendants(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(n: TreeNode) {
    for (const child of n.children) {
      result.push(child);
      walk(child);
    }
  }
  walk(node);
  return result;
}

export function SubtreeStatsPanel({ node, zoom, pan, dimensions }: Props) {
  const stats = useMemo(() => {
    const descendants = collectAllDescendants(node);
    const total = descendants.length;
    const counts: Record<string, number> = {};
    for (const d of descendants) {
      counts[d.syncStatus] = (counts[d.syncStatus] ?? 0) + 1;
    }
    return { total, counts };
  }, [node]);

  if (stats.total === 0) return null;

  // Position the panel relative to the node in SVG space, translated to screen space
  const originX = dimensions.width / 2;
  const originY = dimensions.height / 2;
  const screenX = originX + (node.x - originX) * zoom + pan.x;
  const screenY = originY + (node.y - originY) * zoom + pan.y;

  // Offset to the left of the node
  const panelLeft = Math.max(8, screenX - 160);
  const panelTop = Math.max(8, screenY - 20);

  return (
    <motion.div
      className="absolute z-30 w-36 border p-2.5 shadow-xl backdrop-blur-lg"
      style={{ left: panelLeft, top: panelTop, pointerEvents: "none" }}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        {node.name} · {stats.total} clone{stats.total !== 1 ? "s" : ""}
      </p>
      <div className="space-y-1">
        {STATUS_META.map((s) => {
          const count = stats.counts[s.key] ?? 0;
          const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="flex-1 font-mono text-[9px] text-muted-foreground">{s.label}</span>
              <span
                className="font-mono text-[9px] font-medium tabular-nums"
                style={{ color: s.color }}
              >
                {count}
              </span>
              <span className="font-mono text-[8px] text-muted-foreground/60 tabular-nums w-7 text-right">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
      {/* Mini bar */}
      <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-muted/30">
        {STATUS_META.map((s) => {
          const count = stats.counts[s.key] ?? 0;
          const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div key={s.key} className="h-full" style={{ width: `${pct}%`, background: s.color }} />
          );
        })}
      </div>
    </motion.div>
  );
}
