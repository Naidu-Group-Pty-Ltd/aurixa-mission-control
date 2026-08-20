// Puts the Aurixa brand onto the Stripe account.
//
// Four fields on `account.settings.branding` style every customer-facing
// surface Stripe renders for us — receipts, invoice PDFs, the hosted invoice
// page, Checkout, Payment Links, the portal, and the emails that carry them.
// Preview reads the live account and writes nothing; Apply uploads the two
// marks and sets all four.
//
// The swatches below are painted from the same constants that get uploaded, so
// what an operator approves is what Stripe receives — including the dark
// treatment, which comes from the ACCENT colour (Stripe uses it as the page
// and email background) and not from the brand colour.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, Palette } from "lucide-react";

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
import { previewBrandSync, runBrandSync } from "@/lib/brand-sync.functions";
import { AURIXA_PALETTE, AURIXA_STRIPE_BRANDING } from "@/lib/brand/aurixa-brand";

type Field = {
  field: string;
  current: string | null;
  desired: string;
  changes: boolean;
  reaches: string;
};

type Plan = {
  ok: boolean;
  error?: string;
  accountId?: string;
  livemode?: boolean;
  displayName?: string | null;
  fields?: Field[];
  warnings?: string[];
  primaryInk?: string;
  fileIds?: Partial<Record<"icon" | "logo", string>>;
  accountUpdated?: boolean;
  errors?: string[];
  notes?: string[];
};

const IS_COLOUR = (f: string) => f.endsWith("_color");

export function BrandSyncCard() {
  const preview = useServerFn(previewBrandSync);
  const apply = useServerFn(runBrandSync);

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
      setApplied(!!result.ok);
    } catch (err) {
      setPlan({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const fields = plan?.fields ?? [];
  const canApply = !!plan?.ok && fields.length > 0 && !(plan.warnings ?? []).length && !applied;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="h-4 w-4" /> Stripe brand identity
        </CardTitle>
        <CardDescription>
          Sets the icon, logo, brand colour and accent colour on the Stripe account. Those four
          fields style every surface Stripe renders for us: email receipts, invoice PDFs, the hosted
          invoice page, Checkout, Payment Links and the customer portal. The dark treatment comes
          from the <strong className="mx-1">accent</strong> colour — Stripe uses it as the
          background of emails and hosted pages — while the brand colour carries the gold onto
          buttons, headings and the invoice PDF. The PDF itself stays on white paper; Stripe gives
          no control over that, and it is a document meant to be printed.
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
              "Upload marks & apply branding"
            )}
          </Button>
          {applied && (
            <Badge variant="outline" className="text-[10px]">
              applied
            </Badge>
          )}
          {plan?.livemode && (
            <Badge variant="destructive" className="text-[10px]">
              live mode
            </Badge>
          )}
        </div>

        {/* What the two colours will look like, painted from the constants that
            are uploaded. The accent swatch is the whole point of the dark mode
            claim, so it is shown as a surface rather than as a hex string. */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div
            className="border p-3"
            style={{
              background: AURIXA_STRIPE_BRANDING.secondaryColor,
              borderColor: `${AURIXA_PALETTE.gold}40`,
            }}
          >
            <p
              className="text-[10px] uppercase tracking-wider"
              style={{ color: AURIXA_PALETTE.textSecondary }}
            >
              Accent · backgrounds
            </p>
            <p className="font-mono text-xs" style={{ color: AURIXA_PALETTE.goldLight }}>
              {AURIXA_STRIPE_BRANDING.secondaryColor}
            </p>
            <span
              className="mt-2 inline-block px-2 py-1 text-[11px] font-medium"
              style={{
                background: AURIXA_STRIPE_BRANDING.primaryColor,
                color: plan?.primaryInk ?? "#000000",
              }}
            >
              Pay invoice
            </span>
          </div>
          <div className="border p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Brand · accents &amp; buttons
            </p>
            <p className="font-mono text-xs">{AURIXA_STRIPE_BRANDING.primaryColor}</p>
            <div
              className="mt-2 h-6 w-full"
              style={{ background: AURIXA_STRIPE_BRANDING.primaryColor }}
            />
          </div>
        </div>

        {plan && !plan.ok && (
          <div className="space-y-1 border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">
              {plan.error ?? "Branding failed."}
            </p>
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

        {fields.length > 0 && (
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Currently</TableHead>
                  <TableHead>Will become</TableHead>
                  <TableHead>Reaches</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map((f) => (
                  <TableRow key={f.field}>
                    <TableCell className="font-mono text-xs">{f.field}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {f.current ?? "not set"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {IS_COLOUR(f.field) ? (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-3 w-3 border"
                            style={{ background: f.desired }}
                          />
                          {f.desired}
                        </span>
                      ) : (
                        f.desired.split("/").pop()
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.reaches}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Uploads can succeed while the account write is refused. When that
            happens the File ids are the whole remedy, so they are shown rather
            than logged. */}
        {!!plan?.fileIds && !plan.accountUpdated && !!Object.keys(plan.fileIds).length && (
          <div className="space-y-1 border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              The marks uploaded. Paste these on the Stripe Branding page:
            </p>
            {Object.entries(plan.fileIds).map(([kind, id]) => (
              <p key={kind} className="font-mono text-xs">
                {kind}: {id}
              </p>
            ))}
          </div>
        )}

        {plan?.notes?.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}

        {applied && (
          <p className="text-xs text-muted-foreground">
            Applies to everything Stripe renders from now on. Receipts and invoices already sent
            keep the styling they were sent with — Stripe does not re-render a delivered PDF.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
