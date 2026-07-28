// Puts the top-up ladder on sale.
//
// The packs are already in the catalog — the migration put them there, parked
// and unlinked, because a pack that is advertised before Stripe has a price
// for it is a purchase button that fails. This is the step that mints the
// prices, flips the packs live and takes the superseded four off sale, all in
// one press. Preview shows exactly that; nothing is written until Apply.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Coins, Loader2 } from "lucide-react";

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
import { previewPackSync, runPackSync } from "@/lib/pack-sync.functions";

const aud = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** As the pricing sheet quotes it: cents per credit, two decimals. */
const perCredit = (cents: number) => `${(Math.round(cents * 100) / 100).toFixed(2)}c`;

type Plan = {
  ok: boolean;
  error?: string;
  packs?: Array<{
    slug: string;
    name: string;
    credits: number;
    unitAmount: number;
    gstComponent: number;
    perCreditCents: number;
    discountFraction: number;
    alreadyLive: boolean;
  }>;
  retire?: string[];
  missing?: string[];
  warnings?: string[];
  createdPrices?: Array<{ slug: string; priceId: string; amount: number }>;
  retired?: string[];
  notes?: string[];
  errors?: string[];
  storefrontRefreshed?: boolean;
};

export function PackSyncCard() {
  const preview = useServerFn(previewPackSync);
  const apply = useServerFn(runPackSync);
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

  const packs = plan?.packs ?? [];
  const pending = packs.filter((p) => !p.alreadyLive).length;
  const canApply = !!plan?.ok && packs.length > 0 && !(plan.warnings ?? []).length && !applied;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="h-4 w-4" /> Top-up credit packs
        </CardTitle>
        <CardDescription>
          Puts the eight-stage ladder on sale and retires the packs it replaces. Every figure is
          tax-inclusive — GST is contained in the amount, not added to it — and the Stripe prices
          are one-off, created with <code className="mx-1">tax_behavior: inclusive</code> so
          enabling Stripe Tax later cannot inflate a total. The superseded packs keep selling until
          this succeeds, so there is never a moment with no top-up available.
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
          {!!plan?.ok && !applied && packs.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {pending === 0 ? "All eight already live." : `${pending} of 8 still to do.`}
            </span>
          )}
        </div>

        {plan && !plan.ok && (
          <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{plan.error ?? "Sync failed."}</p>
            {plan.errors?.map((e) => (
              <p key={e} className="font-mono text-xs text-destructive/80">
                {e}
              </p>
            ))}
          </div>
        )}

        {!!plan?.warnings?.length && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {plan.warnings.join(" ")}
          </p>
        )}

        {packs.length > 0 && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pack</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Price (incl GST)</TableHead>
                  <TableHead className="text-right">of which GST</TableHead>
                  <TableHead className="text-right">Per credit</TableHead>
                  <TableHead className="text-right">vs smallest</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {packs.map((p) => (
                  <TableRow key={p.slug}>
                    <TableCell className="text-xs">{p.name}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {p.credits.toLocaleString("en-AU")}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {aud(p.unitAmount)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {aud(p.gstComponent)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {perCredit(p.perCreditCents)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {p.discountFraction > 0 ? `−${(p.discountFraction * 100).toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.alreadyLive && (
                        <Badge variant="outline" className="text-[10px] text-emerald-500">
                          live
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!!plan?.retire?.length && !applied && (
          <p className="text-xs text-muted-foreground">
            Taken off sale: {plan.retire.join(", ")}. The rows are kept — purchases point at them —
            and their Stripe prices are archived.
          </p>
        )}

        {applied && (
          <p className="text-xs text-muted-foreground">
            Created {plan?.createdPrices?.length ?? 0} Stripe price
            {(plan?.createdPrices?.length ?? 0) === 1 ? "" : "s"} and put the ladder on sale
            {plan?.retired?.length ? `, retiring ${plan.retired.join(", ")}` : ""}. Prices that
            already existed at the right amount were reused rather than duplicated.
          </p>
        )}

        {plan?.notes?.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}

        {/* The catalog being right and the pricing page showing it are two
            different things, and the gap between them is invisible from here
            unless it is stated. Prominent when it fails, because that is when
            an operator needs to know not to go looking for a bug that isn't
            there. */}
        {plan?.storefrontRefreshed === false && (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The packs are live here, but the pricing page still shows the old ones until the
            15-minute reconcile runs.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
