// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { useRef } from "react";
import { CheckCircle2, Building2, Sparkles, Loader2, AlertTriangle, UserRound } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  lookupCheckoutSession,
  getCheckoutFulfillmentStatus,
  lookupCheckoutSessionByHandoff,
  getCheckoutFulfillmentStatusByHandoff,
} from "@/lib/checkout-session.functions";
import { DEFAULT_STOREFRONT_PRICING_URL } from "@/lib/storefront";

export const Route = createFileRoute("/billing/success")({
  // `h` = billing handoff token: lets a clone end-user (no Mission Control
  // login) confirm their own purchase and find the way back to their app.
  validateSearch: (s) =>
    z.object({ session_id: z.string().optional(), h: z.string().optional() }).parse(s),
  head: () => ({ meta: [{ title: "Payment received — Mission Control" }] }),
  component: SuccessPage,
});

function formatAmount(cents: number | null, currency: string | null) {
  if (cents == null || !currency) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

const MODE_LABEL: Record<string, string> = {
  topup: "Token top-up",
  seat_plan: "Seat plan",
  setup_package: "Setup package",
};

// Poll up to ~60s; webhook usually arrives in <5s.
const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_MS = 60_000;

type SessionSummary = {
  ok: true;
  mode: string | null;
  itemSlug: string | null;
  cloneId: string | null;
  cloneName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  originUserId: string | null;
  originUsername: string | null;
  originSource: string | null;
  amountTotal: number | null;
  currency: string | null;
  paymentStatus: string | null;
  returnUrl?: string | null;
};
type SessionResult = SessionSummary | { ok: false; error: string };
type FulfillmentResult =
  | {
      ok: true;
      mode: string | null;
      webhookProcessed: boolean;
      webhookError: string | null;
      fulfilled: boolean;
    }
  | { ok: false; error: string };

function useStableNow(key: string | undefined) {
  const ref = useRef<{ key: string | undefined; ts: number }>({ key, ts: Date.now() });
  if (ref.current.key !== key) ref.current = { key, ts: Date.now() };
  return ref.current.ts;
}

function SuccessPage() {
  const { session_id, h } = Route.useSearch();
  const lookupFn = useServerFn(lookupCheckoutSession);
  const fulfillmentFn = useServerFn(getCheckoutFulfillmentStatus);
  const lookupByHandoffFn = useServerFn(lookupCheckoutSessionByHandoff);
  const fulfillmentByHandoffFn = useServerFn(getCheckoutFulfillmentStatusByHandoff);

  // Handoff purchasers (clone end-users) have no operator session — their
  // (session_id, h) pair authorises the lookup instead.
  const viaHandoff = !!h;

  const { data, isLoading } = useQuery<SessionResult>({
    queryKey: ["checkout-session", session_id, h ?? null],
    queryFn: async () =>
      (viaHandoff
        ? await lookupByHandoffFn({ data: { sessionId: session_id!, h: h! } })
        : await lookupFn({ data: { sessionId: session_id! } })) as SessionResult,
    enabled: !!session_id,
    staleTime: 60_000,
  });

  const startedAt = useStableNow(session_id);

  const fulfillmentQuery = useQuery<FulfillmentResult>({
    queryKey: ["checkout-fulfillment", session_id, h ?? null],
    queryFn: async () =>
      (viaHandoff
        ? await fulfillmentByHandoffFn({ data: { sessionId: session_id!, h: h! } })
        : await fulfillmentFn({ data: { sessionId: session_id! } })) as FulfillmentResult,
    enabled: !!session_id,
    refetchInterval: (q) => {
      const latest = q.state.data;
      if (latest && "ok" in latest && latest.ok && latest.fulfilled) return false;
      if (Date.now() - startedAt > POLL_MAX_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  const info = data?.ok ? data : null;
  const amount = info ? formatAmount(info.amountTotal, info.currency) : null;
  const target = info?.cloneName ?? info?.tenantName ?? null;

  const fStatus =
    fulfillmentQuery.data && "ok" in fulfillmentQuery.data && fulfillmentQuery.data.ok
      ? fulfillmentQuery.data
      : null;
  const fulfilled = !!fStatus?.fulfilled;
  const webhookError = fStatus?.webhookError ?? null;
  const timedOut = !fulfilled && Date.now() - startedAt > POLL_MAX_MS;

  return (
    <div className="mx-auto max-w-xl py-16">
      <Card className="border-emerald-500/30">
        <CardHeader className="flex flex-row items-center gap-3">
          <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          <div className="flex-1">
            <CardTitle>Payment received</CardTitle>
            {info && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {info.mode && (
                  <Badge variant="secondary" className="text-xs">
                    {MODE_LABEL[info.mode] ?? info.mode}
                  </Badge>
                )}
                {amount && <span className="text-xs text-muted-foreground">{amount}</span>}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {isLoading && session_id && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {target && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <div className="text-xs">
                <div className="text-muted-foreground">Billed to client</div>
                <div className="font-medium">{target}</div>
              </div>
            </div>
          )}

          {(info?.originUsername || info?.originUserId) && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <div className="text-xs">
                <div className="text-muted-foreground">Purchased by</div>
                <div className="font-medium">
                  {info.originUsername ?? info.originUserId}
                  {info.originSource && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      via {info.originSource.replaceAll("_", " ")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {info?.itemSlug && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                Item: <span className="font-mono">{info.itemSlug}</span>
              </span>
            </div>
          )}

          {session_id && !fulfilled && !webhookError && !timedOut && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span>Finalising your purchase…</span>
            </div>
          )}

          {fulfilled && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>Fulfilment complete — credits / seats / setup are live.</span>
            </div>
          )}

          {webhookError && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span>
                Fulfilment hit an error. Our team has been notified — refresh in a moment.
              </span>
            </div>
          )}

          {timedOut && !fulfilled && !webhookError && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span>
                Still finalising. Your payment is safe — refresh in a minute, and ping support if it
                doesn't appear.
              </span>
            </div>
          )}

          {session_id && (
            <p className="font-mono text-[10px] text-muted-foreground break-all opacity-70">
              Session: {session_id}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            {viaHandoff ? (
              <>
                {info?.returnUrl && (
                  <Button asChild>
                    <a href={info.returnUrl}>Return to {info?.cloneName ?? "your dashboard"}</a>
                  </Button>
                )}
                {/* Customer pricing lives on the Aurixa Systems storefront. */}
                <Button asChild variant={info?.returnUrl ? "outline" : "default"}>
                  <a href={DEFAULT_STOREFRONT_PRICING_URL}>View pricing</a>
                </Button>
              </>
            ) : (
              <>
                <Button asChild>
                  <Link to="/settings/billing">Back to billing</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to="/billing/catalog">View catalog</Link>
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
