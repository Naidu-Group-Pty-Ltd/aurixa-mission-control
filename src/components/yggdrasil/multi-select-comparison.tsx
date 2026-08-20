/**
 * MultiSelectComparisonPanel — side-by-side subtree status comparison
 * for multiple selected nodes.
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import { X, GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TreeNode } from "./use-tree-layout";

interface Props {
  nodes: TreeNode[];
  onClose: () => void;
  onRemoveNode: (id: string) => void;
}

const STATUS_META: { key: string; label: string; color: string }[] = [
  { key: "in_sync", label: "In Sync", color: "oklch(0.78 0.18 150)" },
  { key: "behind", label: "Behind", color: "oklch(0.82 0.17 80)" },
  { key: "failed", label: "Failed", color: "oklch(0.66 0.24 25)" },
];

function getSubtreeStats(node: TreeNode) {
  const counts: Record<string, number> = {};
  let total = 0;
  function walk(n: TreeNode) {
    for (const child of n.children) {
      counts[child.syncStatus] = (counts[child.syncStatus] ?? 0) + 1;
      total++;
      walk(child);
    }
  }
  walk(node);
  // Include the node itself
  counts[node.syncStatus] = (counts[node.syncStatus] ?? 0) + 1;
  total++;
  return { counts, total };
}

export function MultiSelectComparisonPanel({ nodes, onClose, onRemoveNode }: Props) {
  const stats = useMemo(() => nodes.map((n) => ({ node: n, ...getSubtreeStats(n) })), [nodes]);

  return (
    <motion.div
      className="absolute bottom-4 right-4 z-40 w-96 border /95 p-4 shadow-2xl backdrop-blur-xl"
      initial={{ opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Subtree Comparison</h3>
          <span className="font-mono text-[10px] text-muted-foreground">
            {nodes.length} selected
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Column headers */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `auto repeat(${nodes.length}, 1fr)` }}
      >
        {/* Header row */}
        <div />
        {stats.map(({ node }) => (
          <div key={node.id} className="text-center">
            <button
              onClick={() => onRemoveNode(node.id)}
              className="group relative mx-auto block"
              title={`Remove ${node.name}`}
            >
              <span className="font-mono text-[10px] font-semibold truncate block max-w-20">
                {node.name}
              </span>
              <X className="absolute -right-1 -top-1 h-2.5 w-2.5 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity" />
            </button>
            <span className="font-mono text-[8px] text-muted-foreground">
              {node.githubOwner}/{node.githubRepo}
            </span>
          </div>
        ))}

        {/* Status rows */}
        {STATUS_META.map((s) => (
          <>
            <div key={`label-${s.key}`} className="flex items-center gap-1.5 py-0.5">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="font-mono text-[9px] text-muted-foreground">{s.label}</span>
            </div>
            {stats.map(({ node, counts, total }) => {
              const count = counts[s.key] ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={`${node.id}-${s.key}`} className="text-center py-0.5">
                  <span
                    className="font-mono text-[11px] font-semibold tabular-nums"
                    style={{ color: s.color }}
                  >
                    {count}
                  </span>
                  <span className="font-mono text-[8px] text-muted-foreground/60 ml-0.5">
                    ({pct}%)
                  </span>
                </div>
              );
            })}
          </>
        ))}

        {/* Total row */}
        <div className="flex items-center py-0.5 border-t border-border/40 mt-1 pt-1.5">
          <span className="font-mono text-[9px] text-muted-foreground font-semibold">Total</span>
        </div>
        {stats.map(({ node, total }) => (
          <div
            key={`total-${node.id}`}
            className="text-center py-0.5 border-t border-border/40 mt-1 pt-1.5"
          >
            <span className="font-mono text-[11px] font-semibold tabular-nums">{total}</span>
          </div>
        ))}
      </div>

      {/* Comparison bars */}
      <div className="mt-3 space-y-1.5">
        {stats.map(({ node, counts, total }) => (
          <div key={node.id}>
            <p className="font-mono text-[8px] text-muted-foreground mb-0.5">{node.name}</p>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted/30">
              {STATUS_META.map((s) => {
                const count = counts[s.key] ?? 0;
                const pct = total > 0 ? (count / total) * 100 : 0;
                if (pct === 0) return null;
                return (
                  <div
                    key={s.key}
                    className="h-full"
                    style={{ width: `${pct}%`, background: s.color }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 font-mono text-[8px] text-muted-foreground/50">
        Shift+click or Ctrl+click to add/remove nodes
      </p>
    </motion.div>
  );
}
