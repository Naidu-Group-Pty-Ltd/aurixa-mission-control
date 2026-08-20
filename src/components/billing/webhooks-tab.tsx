import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Copy, Plus, Trash2 } from "lucide-react";
import {
  listWebhookEndpoints,
  upsertWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  retryWebhookDeliveriesNow,
  redriveWebhookDelivery,
  sendTestWebhook,
} from "@/lib/token-webhooks.functions";
import { supabase } from "@/integrations/supabase/client";

export function WebhooksTab() {
  const confirm = useConfirm();
  const listFn = useServerFn(listWebhookEndpoints);
  const upsertFn = useServerFn(upsertWebhookEndpoint);
  const deleteFn = useServerFn(deleteWebhookEndpoint);
  const retryFn = useServerFn(retryWebhookDeliveriesNow);
  const testFn = useServerFn(sendTestWebhook);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["token-webhooks"], queryFn: () => listFn() });
  const { data: clones } = useQuery({
    queryKey: ["clones-min"],
    queryFn: async () => {
      const { data } = await supabase.from("clones").select("id, name").order("name");
      return data ?? [];
    },
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);

  const EVENTS = [
    "tokens.balance.updated",
    "tokens.key.revoked",
    "tokens.key.rotated",
    "tokens.alert",
  ];

  const startNew = () => {
    setIssuedSecret(null);
    setDraft({
      id: null,
      cloneId: null,
      url: "",
      events: [...EVENTS],
      isActive: true,
      rotateSecret: false,
    });
    setOpen(true);
  };
  const edit = (e: any) => {
    setIssuedSecret(null);
    setDraft({
      id: e.id,
      cloneId: e.clone_id,
      url: e.url,
      events: e.events ?? [...EVENTS],
      isActive: e.is_active,
      rotateSecret: false,
    });
    setOpen(true);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Webhook endpoints</CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const r = await retryFn();
                toast.success(`Retried ${r.retried}, delivered ${r.delivered}`);
                qc.invalidateQueries({ queryKey: ["token-webhook-deliveries"] });
              }}
            >
              Retry due
            </Button>
            <Button size="sm" onClick={startNew}>
              <Plus className="mr-1 h-3 w-3" />
              New
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.endpoints.map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell className="max-w-[300px] truncate font-mono text-xs">
                    {e.url}
                  </TableCell>
                  <TableCell className="text-xs">
                    {e.clones?.name ?? <span className="text-muted-foreground">all clones</span>}
                  </TableCell>
                  <TableCell className="font-mono text-[10px]">
                    {(e.events ?? []).length} events
                  </TableCell>
                  <TableCell>
                    {e.is_active ? (
                      <Badge>active</Badge>
                    ) : (
                      <Badge variant="secondary">paused</Badge>
                    )}
                  </TableCell>
                  <TableCell className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => edit(e)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        toast.info("Sending test event…");
                        const r = (await testFn({ data: { endpointId: e.id } })) as {
                          ok: boolean;
                          status?: number;
                          test_id?: string;
                          error?: string;
                        };
                        if (r.ok)
                          toast.success(
                            `Delivered (${r.status}) · test_id ${r.test_id?.slice(0, 8)}…`,
                          );
                        else toast.error(`Test failed: ${r.error ?? r.status}`);
                        qc.invalidateQueries({ queryKey: ["token-webhook-deliveries"] });
                      }}
                    >
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete this endpoint?",
                          confirmText: "Delete",
                          destructive: true,
                        });
                        if (!ok) return;
                        const r = await deleteFn({ data: { id: e.id } });
                        if (r.ok) {
                          toast.success("Deleted");
                          qc.invalidateQueries({ queryKey: ["token-webhooks"] });
                        } else toast.error(r.error);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!data?.endpoints.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No webhook endpoints. Add one to receive balance, key, and alert events.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <WebhookDeliveriesCard />

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setIssuedSecret(null);
            setDraft(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit webhook" : "New webhook"}</DialogTitle>
          </DialogHeader>
          {issuedSecret ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Save this signing secret — it will not be shown again. Verify HMAC-SHA256 on the{" "}
                <span className="font-mono">x-mc-signature</span> header.
              </p>
              <div className="flex items-center gap-2 border border-border bg-muted/30 p-2 font-mono text-xs">
                <span className="flex-1 break-all">{issuedSecret}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(issuedSecret);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ) : (
            draft && (
              <div className="grid gap-3 text-sm">
                <Input
                  placeholder="https://your-app.example.com/webhooks/tokens"
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
                <Select
                  value={draft.cloneId ?? "__all__"}
                  onValueChange={(v) => setDraft({ ...draft, cloneId: v === "__all__" ? null : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All clones (fleet-wide)</SelectItem>
                    {clones?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Events</p>
                  {EVENTS.map((ev) => (
                    <label key={ev} className="flex items-center gap-2 font-mono text-xs">
                      <input
                        type="checkbox"
                        checked={(draft.events ?? []).includes(ev)}
                        onChange={(e) => {
                          const set = new Set<string>(draft.events ?? []);
                          if (e.target.checked) set.add(ev);
                          else set.delete(ev);
                          setDraft({ ...draft, events: Array.from(set) });
                        }}
                      />
                      {ev}
                    </label>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.isActive}
                    onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                  />
                  Active
                </label>
                {draft.id && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.rotateSecret}
                      onChange={(e) => setDraft({ ...draft, rotateSecret: e.target.checked })}
                    />
                    Rotate signing secret (invalidates old secret)
                  </label>
                )}
              </div>
            )
          )}
          <DialogFooter>
            {issuedSecret ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button
                disabled={!draft?.url}
                onClick={async () => {
                  try {
                    const payload: Record<string, unknown> = {
                      url: draft.url,
                      cloneId: draft.cloneId ?? null,
                      events: draft.events ?? [...EVENTS],
                      isActive: draft.isActive ?? true,
                      rotateSecret: draft.rotateSecret ?? false,
                    };
                    if (draft.id) payload.id = draft.id;
                    const r = await upsertFn({ data: payload });
                    if (r.ok) {
                      qc.invalidateQueries({ queryKey: ["token-webhooks"] });
                      if (r.secret) setIssuedSecret(r.secret);
                      else {
                        toast.success("Saved");
                        setOpen(false);
                      }
                    } else toast.error(r.error ?? "Failed to save webhook");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to save webhook");
                  }
                }}
              >
                {draft?.id ? "Save" : "Create"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WebhookDeliveriesCard() {
  const listFn = useServerFn(listWebhookDeliveries);
  const redriveFn = useServerFn(redriveWebhookDelivery);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["token-webhook-deliveries"],
    queryFn: () => listFn({ data: { limit: 50 } }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Recent deliveries</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.deliveries.map((d: any) => (
              <TableRow key={d.id}>
                <TableCell className="text-xs">{new Date(d.created_at).toLocaleString()}</TableCell>
                <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                <TableCell className="max-w-[240px] truncate font-mono text-xs">
                  {d.token_webhook_endpoints?.url ?? "—"}
                </TableCell>
                <TableCell>
                  {d.status === "delivered" ? (
                    <Badge>{d.response_code}</Badge>
                  ) : d.status === "failed" ? (
                    <Badge variant="destructive">{d.response_code ?? "fail"}</Badge>
                  ) : (
                    <Badge variant="secondary">pending</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">{d.attempts}</TableCell>
                <TableCell>
                  {d.status !== "delivered" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const r = await redriveFn({ data: { id: d.id } });
                        if (r.ok) {
                          toast.success("Redriven");
                          qc.invalidateQueries({ queryKey: ["token-webhook-deliveries"] });
                        } else toast.error(r.error);
                      }}
                    >
                      Redrive
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!data?.deliveries.length && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No deliveries yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
