import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Receipt,
  Puzzle,
  UserCog,
  Wrench,
  FileText,
  Users,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { listPricingCatalog } from "@/lib/pricing-catalog.functions";
import { createStripeCheckout } from "@/lib/stripe.functions";
import { EmptyState } from "@/components/empty-state";
import { ReportCostIndexCard } from "@/components/billing/report-cost-index-card";
import { CatalogSyncCard } from "@/components/billing/catalog-sync-card";

const SearchSchema = z.object({ tenant: z.string().uuid().optional() });

export const Route = createFileRoute("/billing/catalog")({
  component: () => (
    <ProtectedRoute>
      <CatalogPage />
    </ProtectedRoute>
  ),
  validateSearch: (s) => SearchSchema.parse(s),
  head: () => ({ meta: [{ title: "Pricing Catalog — Mission Control" }] }),
});

function money(cents: number, currency = "AUD") {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function priceRange(min: number, max: number, currency = "AUD") {
  if (min === max || max === 0) return money(min, currency);
  return `${money(min, currency)} – ${money(max, currency)}`;
}

function CatalogPage() {
  const { tenant } = Route.useSearch();
  const fetchCatalog = useServerFn(listPricingCatalog);
  const checkoutFn = useServerFn(createStripeCheckout);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["pricing-catalog"],
    queryFn: () => fetchCatalog(),
  });
  const isEmpty =
    !!data &&
    (data.roles?.length ?? 0) === 0 &&
    (data.addons?.length ?? 0) === 0 &&
    (data.setups?.length ?? 0) === 0 &&
    (data.reports?.length ?? 0) === 0;

  async function buySetup(setupId: string, stripePriceId: string | null) {
    if (!tenant) {
      toast.error("Open with ?tenant=<id> to purchase");
      return;
    }
    if (!stripePriceId) {
      toast.error("Setup package not linked to Stripe yet");
      return;
    }
    try {
      const r = await checkoutFn({
        data: { mode: "setup_package", itemId: setupId, tenantId: tenant },
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.url) window.location.href = r.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Checkout failed");
    }
  }

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Receipt className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-bold">Pricing Catalog</h1>
          </div>
          <p className="text-muted-foreground">
            Aurixa Systems — seat roles, add-on modules, setup packages, and per-report credit
            costs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/billing/seats">
              <Users className="h-4 w-4 mr-2" />
              Seats
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/billing/topup">Credit Packs</Link>
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading catalog…</p>}

      {isError && (
        <EmptyState
          icon={<AlertTriangle />}
          title="Couldn't load the catalog"
          description={error instanceof Error ? error.message : "Something went wrong."}
          action={
            <Button variant="outline" onClick={() => void refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
            </Button>
          }
        />
      )}

      {isEmpty && (
        <EmptyState
          icon={<Receipt />}
          title="No pricing configured yet"
          description="Seat roles, add-ons, setup packages, and report costs will appear here once configured."
        />
      )}

      {data && !isEmpty && (
        <>
          {/* Seat Roles */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <UserCog className="h-5 w-5" />
              <h2 className="text-xl font-semibold">Per-Seat Role Pricing</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Each seat in a plan can be assigned a role tier. Role pricing is in addition to the
              plan's base fee.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              {data.roles.map((r: any) => (
                <Card key={r.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle>{r.name}</CardTitle>
                      <Badge variant="secondary">
                        {priceRange(r.price_min_cents, r.price_max_cents, r.currency)}/mo
                      </Badge>
                    </div>
                    <CardDescription>{r.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {r.metadata?.best_for && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">Best for:</span> {r.metadata.best_for}
                      </p>
                    )}
                    <ul className="text-sm space-y-1">
                      {(r.permissions as string[]).map((p, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-primary">•</span>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {/* Add-on Modules */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Puzzle className="h-5 w-5" />
              <h2 className="text-xl font-semibold">Add-on Modules</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Optional plug-in modules billed monthly. Some are included in higher-tier plans.
            </p>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {data.addons.map((a: any) => (
                <Card key={a.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{a.name}</CardTitle>
                      <Badge variant="outline" className="capitalize">
                        {a.category}
                      </Badge>
                    </div>
                    <CardDescription>{a.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="text-sm font-medium">
                      {priceRange(a.price_min_cents, a.price_max_cents, a.currency)}
                      <span className="text-muted-foreground font-normal">/{a.billing_period}</span>
                    </div>
                    {a.included_in_plans?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <span className="text-xs text-muted-foreground mr-1">Included in:</span>
                        {a.included_in_plans.map((p: string) => (
                          <Badge key={p} variant="secondary" className="text-xs capitalize">
                            {p}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {/* Setup Packages */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5" />
              <h2 className="text-xl font-semibold">Setup & Onboarding</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              One-time fees paid alongside the first month of a plan.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {data.setups.map((s: any) => (
                <Card key={s.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{s.name}</CardTitle>
                      <Badge variant="secondary">
                        {priceRange(s.price_min_cents, s.price_max_cents, s.currency)}
                      </Badge>
                    </div>
                    <CardDescription>
                      {s.description}
                      {s.metadata?.duration_weeks ? ` · ~${s.metadata.duration_weeks} weeks` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ul className="text-sm space-y-1">
                      {(s.deliverables as string[]).map((d, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-primary">✓</span>
                          {d}
                        </li>
                      ))}
                    </ul>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={!tenant || !s.stripe_price_id}
                      title={
                        !s.stripe_price_id
                          ? "Stripe price not linked"
                          : !tenant
                            ? "Open with ?tenant=<id>"
                            : undefined
                      }
                      onClick={() => buySetup(s.id, s.stripe_price_id)}
                    >
                      {!tenant
                        ? "Select tenant to purchase"
                        : s.stripe_price_id
                          ? "Purchase (Stripe)"
                          : "Stripe not linked"}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {/* Report Credit Costs */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              <h2 className="text-xl font-semibold">Report Credit Costs</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Credits deducted per generated report. Clones meter these via the token reservation
              API.
            </p>
            <CatalogSyncCard />
            <ReportCostIndexCard />
          </section>
        </>
      )}
    </div>
  );
}
