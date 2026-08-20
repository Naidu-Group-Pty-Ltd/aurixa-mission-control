// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// G7 — admin UI for per-clone Stripe routing.
//
// Lists all clones with an existing config (or blank state), and lets an
// admin set the mode, connected account id, webhook secret, and optional
// forward URL. Rotating the webhook clears the ciphertext so Stripe can
// mint a new one; the plaintext value is never round-tripped.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  listCloneStripeConfigs,
  getCloneStripeConfig,
  upsertCloneStripeConfig,
  rotateCloneStripeWebhook,
  revokeCloneStripeConfig,
} from "@/lib/clone-stripe.functions";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/settings/clone-stripe")({
  head: () => ({
    meta: [
      { title: "Per-clone Stripe routing — Aurixa Mission Control" },
      { name: "description", content: "Configure per-clone Stripe webhooks and connected accounts." },
    ],
  }),
  component: CloneStripePage,
});

type Clone = { id: string; name: string | null; slug: string | null };

function CloneStripePage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listCloneStripeConfigs);
  const upsertFn = useServerFn(upsertCloneStripeConfig);
  const rotateFn = useServerFn(rotateCloneStripeWebhook);
  const revokeFn = useServerFn(revokeCloneStripeConfig);
  const getFn = useServerFn(getCloneStripeConfig);

  const configs = useQuery({
    queryKey: ["clone-stripe", "list"],
    queryFn: () => listFn({}),
  });

  const clones = useQuery({
    queryKey: ["clones", "picker"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clones")
        .select("id, name, slug")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Clone[];
    },
  });

  const [selected, setSelected] = useState<string>("");
  const detail = useQuery({
    queryKey: ["clone-stripe", "get", selected],
    queryFn: () => getFn({ data: { cloneId: selected } }),
    enabled: !!selected,
  });

  const [mode, setMode] = useState<"platform" | "own_account" | "connect">("platform");
  const [accountId, setAccountId] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [forwardUrl, setForwardUrl] = useState("");

  const upsertMut = useMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          cloneId: selected,
          mode,
          stripe_account_id: accountId.trim() || null,
          webhook_secret: webhookSecret.trim() || null,
          forward_url: forwardUrl.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success("Stripe routing saved");
      setWebhookSecret("");
      qc.invalidateQueries({ queryKey: ["clone-stripe"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rotateMut = useMutation({
    mutationFn: () => rotateFn({ data: { cloneId: selected, reason: "manual_rotation" } }),
    onSuccess: () => {
      toast.success("Webhook secret cleared — paste a new one in Stripe and save it here.");
      qc.invalidateQueries({ queryKey: ["clone-stripe"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revokeMut = useMutation({
    mutationFn: () => revokeFn({ data: { cloneId: selected } }),
    onSuccess: () => {
      toast.success("Config revoked");
      qc.invalidateQueries({ queryKey: ["clone-stripe"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const webhookUrl = detail.data?.webhook_url ?? "";
  const cfg = detail.data?.config ?? null;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Per-clone Stripe routing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Point a handed-off or isolated clone at its own Stripe webhook without
          touching the platform receiver. Secrets are stored encrypted; only
          the last four characters are shown here.
        </p>
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <label className="text-sm font-medium">Clone</label>
        <select
          className="w-full border rounded-md h-9 px-2 bg-background"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setMode("platform");
            setAccountId("");
            setForwardUrl("");
            setWebhookSecret("");
          }}
        >
          <option value="">— select a clone —</option>
          {(clones.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.slug ?? c.id}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <div className="rounded-lg border p-4 space-y-4">
          <div className="text-sm">
            <div className="text-muted-foreground">Webhook URL (paste into Stripe)</div>
            <code className="block mt-1 p-2 bg-muted rounded text-xs break-all">
              {webhookUrl || "loading…"}
            </code>
          </div>

          {cfg && (
            <div className="text-xs text-muted-foreground grid grid-cols-2 gap-2">
              <div>Status: <strong>{cfg.status}</strong></div>
              <div>Mode: <strong>{cfg.mode}</strong></div>
              <div>Account: <strong>{cfg.stripe_account_id ?? "—"}</strong></div>
              <div>Secret last4: <strong>{cfg.webhook_secret_last4 ?? "—"}</strong></div>
              <div className="col-span-2">Forward URL: <strong>{cfg.forward_url ?? "—"}</strong></div>
              <div className="col-span-2">Rotated at: {cfg.rotated_at ?? "—"}</div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3">
            <label className="text-sm">
              Mode
              <select
                className="w-full mt-1 border rounded-md h-9 px-2 bg-background"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="platform">platform (our Stripe account)</option>
                <option value="own_account">own_account (client's Stripe)</option>
                <option value="connect">connect (Stripe Connect)</option>
              </select>
            </label>

            <label className="text-sm">
              Stripe account id (acct_…)
              <input
                className="w-full mt-1 border rounded-md h-9 px-2 bg-background"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="acct_…"
              />
            </label>

            <label className="text-sm">
              Webhook signing secret (whsec_… — will be encrypted)
              <input
                type="password"
                className="w-full mt-1 border rounded-md h-9 px-2 bg-background"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="whsec_…"
                autoComplete="off"
              />
            </label>

            <label className="text-sm">
              Forward URL (optional — client backend that receives verified events)
              <input
                className="w-full mt-1 border rounded-md h-9 px-2 bg-background"
                value={forwardUrl}
                onChange={(e) => setForwardUrl(e.target.value)}
                placeholder="https://client-backend.example.com/hooks/stripe"
              />
            </label>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              disabled={!selected || upsertMut.isPending}
              onClick={() => upsertMut.mutate()}
            >
              {upsertMut.isPending ? "Saving…" : "Save"}
            </button>
            <button
              className="h-9 px-3 rounded-md border text-sm"
              disabled={!cfg || rotateMut.isPending}
              onClick={() => rotateMut.mutate()}
            >
              Rotate webhook secret
            </button>
            <button
              className="h-9 px-3 rounded-md border text-sm text-destructive"
              disabled={!cfg || revokeMut.isPending}
              onClick={() => revokeMut.mutate()}
            >
              Revoke
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border">
        <div className="p-3 border-b text-sm font-medium">Configured clones</div>
        <div className="divide-y">
          {(configs.data?.rows ?? []).length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No configs yet.</div>
          )}
          {(configs.data?.rows ?? []).map((r: any) => (
            <div key={r.clone_id} className="p-3 flex items-center justify-between text-sm">
              <div>
                <div className="font-mono text-xs">{r.clone_id}</div>
                <div className="text-xs text-muted-foreground">
                  {r.mode} · {r.status} · secret …{r.webhook_secret_last4 ?? "—"}
                </div>
              </div>
              <Link
                to="/settings/clone-stripe"
                className="text-xs underline"
                onClick={() => setSelected(r.clone_id)}
              >
                Manage
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
