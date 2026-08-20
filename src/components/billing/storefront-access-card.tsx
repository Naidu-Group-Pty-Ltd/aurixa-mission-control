// Who outside the customer base can see the restricted pricing sections.
//
// Add-on modules, onboarding packages and report economics are visible to
// anyone arriving from a workspace. This card is the only way to let anyone
// else in — one link per recipient, so it can be withdrawn from one of them
// without withdrawing it from all of them.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, Loader2, ShieldOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/copy-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createAccessGrant,
  listAccessGrants,
  revokeAccessGrant,
} from "@/lib/storefront-access.functions";

type Grant = {
  id: string;
  label: string;
  note: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
};

const PRICING_URL =
  (import.meta.env.VITE_PRICING_SITE_URL as string | undefined) ??
  "https://aurixasystems.com.au/pricing";

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";

function status(g: Grant): { label: string; tone: string } {
  if (g.revoked_at) return { label: "revoked", tone: "text-destructive" };
  if (g.expires_at && Date.parse(g.expires_at) <= Date.now())
    return { label: "expired", tone: "text-muted-foreground" };
  return { label: "active", tone: "text-emerald-500" };
}

export function StorefrontAccessCard() {
  const load = useServerFn(listAccessGrants);
  const create = useServerFn(createAccessGrant);
  const revoke = useServerFn(revokeAccessGrant);

  const [grants, setGrants] = useState<Grant[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = (await load()) as { ok: boolean; grants?: Grant[]; error?: string };
      if (r.ok) setGrants(r.grants ?? []);
      else setError(r.error ?? "Could not load grants.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mint = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = (await create({
        data: { label: label.trim(), expiresInDays: Number(days) || 30 },
      })) as { ok: boolean; grant?: { id: string }; error?: string };
      if (!r.ok) setError(r.error ?? "Could not create the grant.");
      else {
        setMinted(r.grant?.id ?? null);
        setLabel("");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const pull = async (id: string) => {
    setBusy(true);
    try {
      await revoke({ data: { id } });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const linkFor = (id: string) => `${PRICING_URL}?access=${id}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> Pricing page access
        </CardTitle>
        <CardDescription>
          Modules, onboarding and report economics are hidden from the open web. Anyone arriving
          from a workspace already sees them; this issues access to someone who is not yet a
          customer. One link per recipient, so it can be withdrawn from one without withdrawing it
          from everyone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1 space-y-1">
            <label htmlFor="grant-label" className="text-xs text-muted-foreground">
              Issued to
            </label>
            <Input
              id="grant-label"
              placeholder="Firm or person"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="w-28 space-y-1">
            <label htmlFor="grant-days" className="text-xs text-muted-foreground">
              Expires in
            </label>
            <Input
              id="grant-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={() => void mint()} disabled={busy || !label.trim()}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Create link
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {minted && (
          <div className="flex items-center justify-between gap-2 border border-primary/40 bg-primary/5 p-3">
            <div className="min-w-0">
              <p className="text-xs font-medium">Share this link</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{linkFor(minted)}</p>
            </div>
            <CopyButton value={linkFor(minted)} />
          </div>
        )}

        {grants.length > 0 && (
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Issued to</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => {
                  const s = status(g);
                  return (
                    <TableRow key={g.id}>
                      <TableCell className="text-xs">{g.label}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${s.tone}`}>
                          {s.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{shortDate(g.expires_at)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {g.use_count}
                        {g.last_used_at ? ` · ${shortDate(g.last_used_at)}` : ""}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {!g.revoked_at && <CopyButton value={linkFor(g.id)} />}
                          {!g.revoked_at && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => void pull(g.id)}
                              disabled={busy}
                              aria-label={`Revoke access for ${g.label}`}
                            >
                              <ShieldOff className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
