// G12 — Client Supabase Accounts admin UI. Capture, verify, rotate, and
// revoke the per-client org credentials used by the handoff orchestrator.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  listClientSupabaseAccounts,
  createClientSupabaseAccount,
  revokeClientSupabaseAccount,
  verifyClientSupabaseAccount,
  rotateClientSupabasePat,
} from "@/lib/client-supabase-accounts.functions";

export const Route = createFileRoute("/settings/client-accounts")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <ClientAccountsPage />,
  head: () => ({ meta: [{ title: "Client Supabase Accounts — Aurixa Systems" }] }),
});

function ClientAccountsPage() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["client-supabase-accounts"],
    queryFn: () => listClientSupabaseAccounts(),
  });

  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [planTier, setPlanTier] = useState("");
  const [regionAllowed, setRegionAllowed] = useState("");
  const [notes, setNotes] = useState("");
  const [pat, setPat] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["client-supabase-accounts"] });

  const create = useMutation({
    mutationFn: () =>
      createClientSupabaseAccount({
        data: {
          owner_email: ownerEmail,
          owner_name: ownerName || null,
          org_slug: orgSlug || null,
          plan_tier: planTier || null,
          region_allowed: regionAllowed
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          notes: notes || null,
          pat: pat || null,
        },
      }),
    onSuccess: () => {
      toast.success("Client account captured");
      setOwnerEmail("");
      setOwnerName("");
      setOrgSlug("");
      setPlanTier("");
      setRegionAllowed("");
      setNotes("");
      setPat("");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const verify = useMutation({
    mutationFn: (id: string) => verifyClientSupabaseAccount({ data: { id } }),
    onSuccess: (r: any) => {
      if (r?.ok) toast.success(`Verified — ${r.org_slug ?? r.org_id} (${r.plan_tier ?? "plan?"})`);
      else toast.error(r?.error ?? "Verification failed");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeClientSupabaseAccount({ data: { id } }),
    onSuccess: () => {
      toast.success("Revoked");
      invalidate();
    },
  });

  const rotate = useMutation({
    mutationFn: ({ id, pat }: { id: string; pat: string }) =>
      rotateClientSupabasePat({ data: { id, pat } }),
    onSuccess: () => {
      toast.success("PAT rotated — re-verify");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="font-display text-[1.75rem] leading-[1.1]">Client Supabase Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Captured client-org credentials used by the handoff orchestrator. PATs are encrypted at
          rest and never returned to the browser after capture.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Capture a new client account</CardTitle>
          <CardDescription>
            Paste the client's Supabase Personal Access Token (owner scope). Run
            <em> Verify</em> after saving to confirm org membership and enrich plan/region.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Owner email *</Label>
              <Input
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="ceo@client.com"
              />
            </div>
            <div>
              <Label>Owner name</Label>
              <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </div>
            <div>
              <Label>Org slug or ID</Label>
              <Input
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="acme-corp"
              />
            </div>
            <div>
              <Label>Plan tier (optional — auto-filled on verify)</Label>
              <Input
                value={planTier}
                onChange={(e) => setPlanTier(e.target.value)}
                placeholder="pro / team / enterprise"
              />
            </div>
            <div className="col-span-2">
              <Label>Allowed regions (comma-separated)</Label>
              <Input
                value={regionAllowed}
                onChange={(e) => setRegionAllowed(e.target.value)}
                placeholder="us-east-1, ap-southeast-2"
              />
            </div>
            <div className="col-span-2">
              <Label>Personal Access Token (owner scope)</Label>
              <Input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="sbp_..."
              />
            </div>
            <div className="col-span-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <Button onClick={() => create.mutate()} disabled={!ownerEmail || create.isPending}>
            {create.isPending ? "Saving…" : "Capture account"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Captured accounts ({q.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : q.data && q.data.length > 0 ? (
            q.data.map((a: any) => (
              <div key={a.id} className="border p-4 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium">{a.owner_email}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.owner_name && <span>{a.owner_name} · </span>}
                      org: <code>{a.org_slug ?? a.org_id ?? "—"}</code> · plan:{" "}
                      <code>{a.plan_tier ?? "—"}</code> · regions:{" "}
                      {a.region_allowed?.length ? a.region_allowed.join(", ") : "any"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      PAT: {a.pat_last4 ? <code>…{a.pat_last4}</code> : <em>none captured</em>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.revoked_at ? (
                      <Badge variant="destructive">Revoked</Badge>
                    ) : a.verified_at ? (
                      <Badge>Verified {new Date(a.verified_at).toLocaleDateString()}</Badge>
                    ) : (
                      <Badge variant="outline">Unverified</Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!a.pat_last4 || !!a.revoked_at || verify.isPending}
                    onClick={() => verify.mutate(a.id)}
                  >
                    Verify PAT
                  </Button>
                  <RotateInline
                    onRotate={(newPat) => rotate.mutate({ id: a.id, pat: newPat })}
                    disabled={!!a.revoked_at}
                  />
                  {!a.revoked_at && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Revoke this client account?",
                          description: "It can't be used for handoffs after this.",
                          confirmText: "Revoke",
                          destructive: true,
                        });
                        if (ok) revoke.mutate(a.id);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No client accounts captured yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RotateInline({
  onRotate,
  disabled,
}: {
  onRotate: (pat: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  if (!open) {
    return (
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Rotate PAT
      </Button>
    );
  }
  return (
    <div className="flex gap-2 items-center">
      <Input
        type="password"
        placeholder="new sbp_..."
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="h-9 w-64"
      />
      <Button
        size="sm"
        disabled={val.length < 20}
        onClick={() => {
          onRotate(val);
          setVal("");
          setOpen(false);
        }}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(false);
          setVal("");
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
