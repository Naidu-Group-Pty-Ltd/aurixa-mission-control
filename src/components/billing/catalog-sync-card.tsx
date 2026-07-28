// Moves the seat-plan tiers onto the signed-off price list.
//
// Two systems have to change together: Stripe holds the price that is charged,
// the catalog row holds the price that is shown. Preview shows exactly what
// will happen to both; nothing is written until Apply.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { previewCatalogSync, runCatalogSync } from "@/lib/catalog-sync.functions";

const aud = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

type Plan = {
  ok: boolean;
  error?: string;
  renames?: Array<{ from: string; to: string; name: string }>;
  prices?: Array<{
    tierSlug: string;
    interval: string;
    unitAmount: number;
    gstComponent: number;
    baseAmount: number;
    includesAml: boolean;
  }>;
  untouched?: string[];
  warnings?: string[];
  createdPrices?: Array<{ tierSlug: string; interval: string; priceId: string }>;
};

export function CatalogSyncCard() {
  const preview = useServerFn(previewCatalogSync);
  const apply = useServerFn(runCatalogSync);
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [applied, setApplied] = useState(false);

  const load = async () => {
    setBusy("preview");
    setApplied(false);
    try {
      setPlan((await preview()) as Plan);
    } catch (err) {
      setPlan({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setBusy("apply");
    try {
      const result = (await apply({ data: { confirm: true } })) as Plan;
      setPlan(result);
      setApplied(result.ok);
      if (result.ok) await queryClient.invalidateQueries({ queryKey: ["pricing-catalog"] });
    } catch (err) {
      setPlan({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const prices = plan?.prices ?? [];
  const canApply = !!plan?.ok && prices.length > 0 && !(plan.warnings ?? []).length && !applied;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4" /> Seat plan price list
        </CardTitle>
        <CardDescription>
          Moves the tiers onto the signed-off prices. Each tier is titled in the price list by its
          <strong className="mx-1">with AML/CTF Compliance</strong> figure, so that is what Stripe
          charges and what the pricing page leads with; the without-AML figure is shown beside it.
          Every figure is tax-inclusive — GST is contained in the amount, not added to it — and
          Stripe prices are created with <code className="mx-1">tax_behavior: inclusive</code> so
          enabling Stripe Tax later cannot inflate a total. Annual bills twelve months less 10%.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}>
            {busy === "preview" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Checking…
              </>
            ) : (
              "Preview changes"
            )}
          </Button>
          <Button size="sm" onClick={() => void run()} disabled={busy !== null || !canApply}>
            {busy === "apply" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Applying…
              </>
            ) : (
              "Create Stripe prices & apply"
            )}
          </Button>
          {applied && (
            <Badge variant="outline" className="text-[10px]">
              applied
            </Badge>
          )}
        </div>

        {plan && !plan.ok && (
          <p className="text-sm text-destructive">{plan.error ?? "Sync failed."}</p>
        )}

        {!!plan?.warnings?.length && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {plan.warnings.join(" ")}
          </p>
        )}

        {!!plan?.renames?.length && (
          <p className="text-xs text-muted-foreground">
            Rows reused, in this order:{" "}
            {plan.renames.map((r) => `${r.from} → ${r.to}`).join(", ")}. Existing Stripe products
            and subscription history stay attached to the row.
          </p>
        )}

        {prices.length > 0 && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead className="text-right">Price (incl GST)</TableHead>
                  <TableHead className="text-right">of which GST</TableHead>
                  <TableHead className="text-right">Without AML/CTF</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.map((p) => (
                  <TableRow key={`${p.tierSlug}-${p.interval}`}>
                    <TableCell className="text-xs capitalize">{p.tierSlug}</TableCell>
                    <TableCell className="text-xs">
                      {p.interval === "year" ? "Annual (−10%)" : "Monthly"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {aud(p.unitAmount)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {aud(p.gstComponent)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {aud(p.baseAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!!plan?.untouched?.length && (
          <p className="text-xs text-muted-foreground">
            Left alone: {plan.untouched.join(", ")}.
          </p>
        )}

        {applied && !!plan?.createdPrices?.length && (
          <p className="text-xs text-muted-foreground">
            Created {plan.createdPrices.length} Stripe price
            {plan.createdPrices.length === 1 ? "" : "s"} and repointed the catalog.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
