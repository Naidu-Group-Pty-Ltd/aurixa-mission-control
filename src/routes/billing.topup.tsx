import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ProtectedRoute } from "@/components/protected-route";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { RecordRow } from "@/components/record-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { listPacks, applyTenantTopup, getTenant } from "@/lib/tokens.functions";
import { createStripeCheckout } from "@/lib/stripe.functions";
import { resolveHandoff } from "@/lib/handoff.functions";

const SearchSchema = z.object({
  tenant: z.string().uuid().optional(),
  // Billing handoff token — pins tenant + originating clone user
  // (user-attributed pricing workflow).
  h: z.string().uuid().optional(),
});

export const Route = createFileRoute("/billing/topup")({
  component: TopupPage,
  validateSearch: (s) => SearchSchema.parse(s),
  head: () => ({ meta: [{ title: "Top up tokens — Mission Control" }] }),
});

function money(cents: number, ccy = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(cents / 100);
}

type Pack = {
  id: string;
  slug: string;
  name: string;
  tokens: number;
  price_cents: number;
  currency: string;
  expires_after_days: number | null;
  is_active: boolean;
  metadata?: {
    price_min_cents?: number | null;
    price_max_cents?: number | null;
    best_for?: string | null;
    popular?: boolean;
    order?: number;
  } | null;
  stripe_price_id?: string | null;
};

function priceRange(p: { price_cents: number; currency: string; metadata?: Pack["metadata"] }) {
  const min = p.metadata?.price_min_cents;
  const max = p.metadata?.price_max_cents;
  if (min != null && max != null && min !== max) {
    return `${money(min, p.currency)} – ${money(max, p.currency)}`;
  }
  return money(p.price_cents, p.currency);
}

type SortKey = "tokens-asc" | "tokens-desc" | "price-asc" | "price-desc" | "name";

function TopupPage() {
  return (
    <ProtectedRoute>
      <TopupBody />
    </ProtectedRoute>
  );
}

function TopupBody() {
  const { tenant: tenantParam, h } = Route.useSearch();
  const qc = useQueryClient();

  const packsFn = useServerFn(listPacks);
  const tenantFn = useServerFn(getTenant);
  const topupFn = useServerFn(applyTenantTopup);
  const checkoutFn = useServerFn(createStripeCheckout);

  // Attributed handoff: derives the tenant when the deep link carries `?h=`
  // instead of a bare `?tenant=`, and pins who initiated the purchase.
  const resolveHandoffFn = useServerFn(resolveHandoff);
  const handoffQ = useQuery({
    queryKey: ["billing-handoff", h],
    queryFn: () => resolveHandoffFn({ data: { h: h! } }),
    enabled: !!h,
    staleTime: Infinity,
    retry: false,
  });
  const handoff = handoffQ.data?.ok ? handoffQ.data : null;
  const tenant = tenantParam ?? handoff?.tenantId ?? undefined;

  async function buyWithStripe(pack: Pack) {
    if (!tenant) {
      toast.error("No tenant in context");
      return;
    }
    if (!pack.stripe_price_id) {
      toast.error("Pack not linked to Stripe yet");
      return;
    }
    try {
      const r = await checkoutFn({
        data: { mode: "topup", tenantId: tenant, itemId: pack.id, handoffId: handoff?.handoffId },
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

  const packs = useQuery({
    queryKey: ["topup", "packs"],
    queryFn: () => packsFn({}),
  });
  const tenantQ = useQuery({
    queryKey: ["topup", "tenant", tenant],
    queryFn: () => tenantFn({ data: { id: tenant! } }),
    enabled: !!tenant,
  });

  const all: Pack[] = (packs.data?.packs ?? []) as Pack[];

  // ── Filters / search ──────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [currency, setCurrency] = useState<string>("__all__");
  const [sort, setSort] = useState<SortKey>("tokens-asc");
  const [minTokens, setMinTokens] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const currencies = useMemo(() => Array.from(new Set(all.map((p) => p.currency))).sort(), [all]);

  const filtered = useMemo(() => {
    let rows = all.filter((p) => p.is_active);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
      );
    }
    if (currency !== "__all__") rows = rows.filter((p) => p.currency === currency);
    const minT = Number(minTokens);
    if (minTokens && Number.isFinite(minT)) rows = rows.filter((p) => p.tokens >= minT);
    const maxP = Number(maxPrice);
    if (maxPrice && Number.isFinite(maxP)) {
      rows = rows.filter((p) => p.price_cents <= Math.round(maxP * 100));
    }
    const sorted = [...rows];
    switch (sort) {
      case "tokens-asc":
        sorted.sort((a, b) => a.tokens - b.tokens);
        break;
      case "tokens-desc":
        sorted.sort((a, b) => b.tokens - a.tokens);
        break;
      case "price-asc":
        sorted.sort((a, b) => a.price_cents - b.price_cents);
        break;
      case "price-desc":
        sorted.sort((a, b) => b.price_cents - a.price_cents);
        break;
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return sorted;
  }, [all, search, currency, minTokens, maxPrice, sort]);

  // ── Pagination ────────────────────────────────────────────────────────────
  const [pageSize, setPageSize] = useState<number>(9);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamp when filters shrink the result set below the current page.
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const visible = filtered.slice(pageStart, pageStart + pageSize);
  // Reset to first page whenever filters change the result count.
  const filterKey = `${search}|${currency}|${minTokens}|${maxPrice}|${sort}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  // ── Confirmation state ────────────────────────────────────────────────────
  const [pending, setPending] = useState<{ pack: Pack; idemKey: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function requestBuy(pack: Pack) {
    if (!tenant) {
      toast.error("No tenant in context — open this page from a clone deep-link.");
      return;
    }
    // Generate a fresh idempotency key per confirmation flow. Repeated clicks
    // on the confirm button reuse this same key, so the server short-circuits
    // duplicate charges.
    setPending({ pack, idemKey: crypto.randomUUID() });
  }

  async function confirmBuy() {
    if (!pending || !tenant) return;
    setSubmitting(true);
    try {
      const r = (await topupFn({
        data: { tenantId: tenant, packId: pending.pack.id, idempotencyKey: pending.idemKey },
      })) as { ok?: boolean; error?: string; idempotent_replay?: boolean; tokens?: number };
      if (r.ok === false) {
        toast.error(r.error ?? "Top-up failed");
        return;
      }
      if (r.idempotent_replay) {
        toast.info(
          `Already applied earlier (${r.tokens?.toLocaleString()} tokens) — no double-charge.`,
        );
      } else {
        toast.success(
          `Top-up applied: +${r.tokens?.toLocaleString() ?? pending.pack.tokens.toLocaleString()} tokens`,
        );
      }
      qc.invalidateQueries({ queryKey: ["topup", "tenant", tenant] });
      setPending(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="label-mono">credits</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Top up tokens</h2>
        </div>
        <Link
          to="/settings/billing"
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          full billing →
        </Link>
      </div>

      {handoff && (
        <Card className="border-primary/40">
          <CardContent className="py-4 text-sm">
            Purchasing for{" "}
            <span className="font-medium">{handoff.cloneName ?? "Mission Control · Prime"}</span>
            {handoff.originUsername && (
              <>
                {" "}
                as <span className="font-medium">{handoff.originUsername}</span>
              </>
            )}{" "}
            <span className="text-muted-foreground">
              — this purchase will be attributed to them.
            </span>
          </CardContent>
        </Card>
      )}

      {tenant && tenantQ.data?.tenant && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Tenant: {tenantQ.data.tenant.display_name ?? tenantQ.data.tenant.external_ref}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4 text-sm">
            <Stat label="Available" value={tenantQ.data.balance?.available ?? 0} />
            <Stat label="Lifetime spent" value={tenantQ.data.balance?.lifetime_spent ?? 0} />
          </CardContent>
        </Card>
      )}

      {!tenant && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Open this page from a clone with <code>?tenant=&lt;tenant_id&gt;</code> in the URL to
            apply a top-up. Without a tenant, this page is read-only.
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 py-4 md:grid-cols-5">
          <Input
            placeholder="Search name or slug…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger>
              <SelectValue placeholder="Currency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All currencies</SelectItem>
              {currencies.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={0}
            placeholder="Min tokens"
            value={minTokens}
            onChange={(e) => setMinTokens(e.target.value)}
          />
          <Input
            type="number"
            min={0}
            step="0.01"
            placeholder="Max price"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
          />
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="md:col-span-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tokens-asc">Tokens · low → high</SelectItem>
              <SelectItem value="tokens-desc">Tokens · high → low</SelectItem>
              <SelectItem value="price-asc">Price · low → high</SelectItem>
              <SelectItem value="price-desc">Price · high → low</SelectItem>
              <SelectItem value="name">Name (A→Z)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground md:col-span-5">
            Showing {visible.length === 0 ? 0 : pageStart + 1}–{pageStart + visible.length} of{" "}
            {filtered.length} matching ({all.filter((p) => p.is_active).length} active overall)
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((p) => (
          <RecordRow key={p.id} className="flex flex-col">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{p.name}</CardTitle>
                <div className="flex items-center gap-1">
                  {p.metadata?.popular && <Badge>Popular</Badge>}
                  <Badge variant="secondary">{p.slug}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <p className="text-3xl font-semibold tracking-tight">
                {p.tokens.toLocaleString()}{" "}
                <span className="text-sm font-normal text-muted-foreground">credits</span>
              </p>
              <p className="text-sm">
                <span className="font-medium">{priceRange(p)}</span>
                <span className="text-muted-foreground"> {p.currency} · ex GST</span>
              </p>
              {p.metadata?.best_for && (
                <p className="text-xs text-muted-foreground">{p.metadata.best_for}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {p.expires_after_days ? `Expires in ${p.expires_after_days}d` : "No expiry"}
              </p>
              <div className="mt-auto flex flex-col gap-2">
                <Button
                  disabled={!tenant || !p.stripe_price_id}
                  onClick={() => buyWithStripe(p)}
                  title={!p.stripe_price_id ? "Stripe price not linked" : undefined}
                >
                  {tenant
                    ? p.stripe_price_id
                      ? "Pay with Stripe"
                      : "Stripe not linked"
                    : "Select tenant"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!tenant}
                  onClick={() => requestBuy(p)}
                >
                  Apply manually (admin)
                </Button>
              </div>
            </CardContent>
          </RecordRow>
        ))}
        {filtered.length === 0 && !packs.isLoading && (
          <p className="text-sm text-muted-foreground">No packs match the current filters.</p>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border /40 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Page size</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-8 w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[6, 9, 12, 24, 48].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(1)}>
              « First
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              Prev
            </Button>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {safePage} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage >= totalPages}
              onClick={() => setPage(totalPages)}
            >
              Last »
            </Button>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!pending}
        onOpenChange={(o) => {
          if (!o && !submitting) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm top-up</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  Review before charging the tenant's account. This action is recorded in the audit
                  log.
                </p>
                {pending && (
                  <div className="border border-border bg-muted/30 p-3 font-mono text-xs">
                    <Row
                      k="Tenant"
                      v={
                        tenantQ.data?.tenant?.display_name ??
                        tenantQ.data?.tenant?.external_ref ??
                        tenant
                      }
                    />
                    <Row k="Pack" v={`${pending.pack.name} (${pending.pack.slug})`} />
                    <Row k="Tokens" v={`+${pending.pack.tokens.toLocaleString()}`} />
                    <Row k="Price" v={money(pending.pack.price_cents, pending.pack.currency)} />
                    <Row
                      k="Expires"
                      v={
                        pending.pack.expires_after_days
                          ? `in ${pending.pack.expires_after_days}d`
                          : "never"
                      }
                    />
                    <Row k="Idempotency key" v={pending.idemKey} />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Repeated submissions with this same key will not double-charge.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault();
                void confirmBuy();
              }}
            >
              {submitting ? "Applying…" : "Confirm & apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className="break-all text-right text-foreground">{v}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}
