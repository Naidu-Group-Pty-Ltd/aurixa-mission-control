// Per-clone purchase attribution summary (user-attributed pricing workflow,
// Phase 4): lifetime revenue + the most recent purchases, with who initiated
// each one, and a jump into the fleet-wide purchases explorer.
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clonePurchaseSummary } from "@/lib/purchases.functions";
import { formatMoneyByCurrency } from "@/lib/purchase-rollups";
import { formatDistanceToNow } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  completed: "bg-success/15 text-success",
  initiated: "bg-muted text-muted-foreground",
  abandoned: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
  refunded: "bg-warning/15 text-warning",
};

export function ClonePurchasesCard({ cloneId }: { cloneId: string }) {
  const summaryFn = useServerFn(clonePurchaseSummary);
  const q = useQuery({
    queryKey: ["clone-purchases", cloneId],
    queryFn: () => summaryFn({ data: { cloneId } }),
    staleTime: 60_000,
  });
  const summary = q.data?.ok ? q.data : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShoppingCart className="h-4 w-4" /> Purchases
        </CardTitle>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="font-mono text-[10px] uppercase tracking-wider"
        >
          <Link to="/billing/purchases" search={{ clone: cloneId }}>
            view all →
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <MiniStat
            label="Lifetime revenue"
            value={summary ? formatMoneyByCurrency(summary.lifetimeRevenueByCurrency) : "—"}
          />
          <MiniStat label="Completed purchases" value={summary?.completedCount ?? "—"} />
          <MiniStat
            label="User-initiated"
            value={summary ? String(summary.attributedCount) : "—"}
          />
          <MiniStat
            label="Admin actions"
            value={summary ? String(summary.adminActionCount ?? 0) : "—"}
          />
        </div>

        {summary && summary.recent.length === 0 && (
          <div className="border border-dashed p-4 text-center text-sm text-muted-foreground">
            No purchases recorded for this clone yet.
          </div>
        )}

        {summary && summary.recent.length > 0 && (
          <div className="space-y-2">
            {summary.recent.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 border border-border bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{p.item_slug ?? p.mode}</span>
                    <Badge className={`text-[10px] ${STATUS_STYLE[p.status] ?? ""}`}>
                      {p.status}
                    </Badge>
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {p.origin_username ?? p.origin_user_id ?? "unknown user"} · {p.origin_source} ·{" "}
                    {formatDistanceToNow(p.created_at)}
                  </div>
                </div>
                <div className="shrink-0 font-mono text-xs">
                  {p.amount_cents != null
                    ? formatMoneyByCurrency({
                        [(p.currency ?? "AUD").toUpperCase()]: p.amount_cents,
                      })
                    : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border bg-surface px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-sm font-semibold" title={String(value)}>
        {value}
      </div>
    </div>
  );
}
