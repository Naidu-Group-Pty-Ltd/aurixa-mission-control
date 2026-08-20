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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Copy, KeyRound, RotateCw, Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { CLONE_API_SCOPES, DEFAULT_SCOPES } from "@/lib/clone-api-scopes";
import {
  listCloneApiKeys,
  createCloneApiKey,
  revokeCloneApiKey,
  rotateCloneApiKey,
} from "@/lib/clone-api-keys.functions";
import { supabase } from "@/integrations/supabase/client";

export function KeysTab() {
  const confirm = useConfirm();
  const listFn = useServerFn(listCloneApiKeys);
  const createFn = useServerFn(createCloneApiKey);
  const revokeFn = useServerFn(revokeCloneApiKey);
  const rotateFn = useServerFn(rotateCloneApiKey);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["clone-api-keys"], queryFn: () => listFn({ data: {} }) });
  const { data: clones } = useQuery({
    queryKey: ["clones-min"],
    queryFn: async () => {
      const { data } = await supabase.from("clones").select("id, name, slug").order("name");
      return data ?? [];
    },
  });
  const [open, setOpen] = useState(false);
  const [cloneId, setCloneId] = useState("");
  const [label, setLabel] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const toggleScope = (v: string, on: boolean) =>
    setSelectedScopes((prev) =>
      on ? Array.from(new Set([...prev, v])) : prev.filter((s) => s !== v),
    );

  // Rotation modal state
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<any>(null);
  const [rotateGrace, setRotateGrace] = useState(24);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateResult, setRotateResult] = useState<{
    key: string;
    prefix: string;
    revokeAt: string;
  } | null>(null);

  const closeRotate = (next: boolean) => {
    setRotateOpen(next);
    if (!next) {
      setRotateTarget(null);
      setRotateResult(null);
      setRotateGrace(24);
      setRotateBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Clone API keys</CardTitle>
          <Dialog
            open={open}
            onOpenChange={(v) => {
              setOpen(v);
              if (!v) {
                setIssuedKey(null);
                setLabel("");
                setCloneId("");
                setSelectedScopes(DEFAULT_SCOPES);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm">
                <KeyRound className="mr-1 h-3 w-3" />
                Issue key
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{issuedKey ? "Key issued" : "Issue clone API key"}</DialogTitle>
              </DialogHeader>
              {issuedKey ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Copy this key now — it will not be shown again.
                  </p>
                  <div className="flex items-center gap-2 border border-border bg-muted/30 p-2 font-mono text-xs">
                    <span className="flex-1 break-all">{issuedKey}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard.writeText(issuedKey);
                        toast.success("Copied");
                      }}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 text-sm">
                  <Select value={cloneId} onValueChange={setCloneId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick target…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__prime__">Prime repo (Mission Control)</SelectItem>
                      {clones?.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Label (e.g. prod, staging)"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  <div className="border border-border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                        Scopes
                      </p>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          type="button"
                          onClick={() => setSelectedScopes(CLONE_API_SCOPES.map((s) => s.value))}
                        >
                          All
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          type="button"
                          onClick={() => setSelectedScopes(DEFAULT_SCOPES)}
                        >
                          Defaults
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          type="button"
                          onClick={() => setSelectedScopes([])}
                        >
                          None
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-2 max-h-64 overflow-y-auto pr-1">
                      {CLONE_API_SCOPES.map((s) => (
                        <label
                          key={s.value}
                          className="flex items-start gap-2 cursor-pointer border border-transparent p-2 hover:border-border"
                        >
                          <Checkbox
                            checked={selectedScopes.includes(s.value)}
                            onCheckedChange={(c) => toggleScope(s.value, c === true)}
                            className="mt-0.5"
                          />
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs">{s.value}</span>
                              <span className="text-xs text-muted-foreground">· {s.label}</span>
                            </div>
                            <p className="text-[11px] text-muted-foreground">{s.description}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <DialogFooter>
                {issuedKey ? (
                  <Button onClick={() => setOpen(false)}>Done</Button>
                ) : (
                  <Button
                    disabled={!cloneId || !label || selectedScopes.length === 0}
                    onClick={async () => {
                      const targetCloneId = cloneId === "__prime__" ? null : cloneId;
                      const r = await createFn({
                        data: { cloneId: targetCloneId, label, scopes: selectedScopes },
                      });
                      if (r.ok) {
                        setIssuedKey(r.key);
                        qc.invalidateQueries({ queryKey: ["clone-api-keys"] });
                      } else toast.error(r.error);
                    }}
                  >
                    Issue
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Clone</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.keys.map((k: any) => (
                <TableRow key={k.id}>
                  <TableCell>
                    {k.clones?.name ?? (
                      <span className="font-mono text-xs text-muted-foreground">prime repo</span>
                    )}
                  </TableCell>
                  <TableCell>{k.label}</TableCell>
                  <TableCell className="font-mono text-xs">{k.key_prefix}…</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-[260px]">
                      {((k.scopes as string[]) ?? []).map((s) => (
                        <Badge key={s} variant="outline" className="font-mono text-[10px]">
                          {s}
                        </Badge>
                      ))}
                      {!k.scopes?.length && (
                        <span className="text-xs text-muted-foreground">none</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                  </TableCell>
                  <TableCell>
                    {k.revoked_at ? (
                      <Badge variant="destructive">revoked</Badge>
                    ) : k.revoke_at ? (
                      <Badge variant="outline">
                        grace · revokes {new Date(k.revoke_at).toLocaleString()}
                      </Badge>
                    ) : (
                      <Badge>active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="flex gap-1">
                    {!k.revoked_at && !k.revoke_at && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Rotate (issue new + grace period)"
                        onClick={() => {
                          setRotateTarget(k);
                          setRotateResult(null);
                          setRotateGrace(24);
                          setRotateOpen(true);
                        }}
                      >
                        <RotateCw className="h-3 w-3" />
                      </Button>
                    )}
                    {!k.revoked_at && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const ok = await confirm({
                            title: "Revoke this key?",
                            description: "Calls using it will fail immediately.",
                            confirmText: "Revoke",
                            destructive: true,
                          });
                          if (!ok) return;
                          const r = await revokeFn({ data: { id: k.id } });
                          if (r.ok) {
                            toast.success("Revoked");
                            qc.invalidateQueries({ queryKey: ["clone-api-keys"] });
                          } else toast.error(r.error);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!data?.keys.length && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                    No keys issued.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ActiveKeysPerClonePanel keys={data?.keys ?? []} />

      <Dialog open={rotateOpen} onOpenChange={closeRotate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {rotateResult ? "New key issued — copy now" : "Rotate API key"}
            </DialogTitle>
          </DialogHeader>
          {rotateResult ? (
            <div className="space-y-3 text-sm">
              <div className="border border-warning/40 bg-warning/10 p-3 text-xs">
                <p className="font-semibold text-warning-foreground">Shown only once.</p>
                <p className="mt-1 text-muted-foreground">
                  Cascade this secret into your clone now. Mission Control stores only its hash —
                  closing this dialog discards it.
                </p>
              </div>
              <div className="flex items-center gap-2 border border-border bg-muted/30 p-2 font-mono text-xs">
                <span className="flex-1 break-all">{rotateResult.key}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(rotateResult.key);
                    toast.success("New key copied");
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <div className="border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                <p>
                  <span className="font-mono text-foreground">{rotateResult.prefix}…</span> is live
                  immediately. The previous key keeps working until{" "}
                  <span className="font-mono text-foreground">
                    {new Date(rotateResult.revokeAt).toLocaleString()}
                  </span>{" "}
                  and is then revoked automatically by the scheduler — no manual cleanup required.
                </p>
              </div>
            </div>
          ) : rotateTarget ? (
            <div className="space-y-3 text-sm">
              <div className="border border-border bg-muted/20 p-3 text-xs">
                <p className="text-muted-foreground">Target</p>
                <p className="mt-0.5 font-medium">
                  {rotateTarget.clones?.name ?? "Prime repo"} ·{" "}
                  <span className="font-mono">{rotateTarget.label}</span> ·{" "}
                  <span className="font-mono text-muted-foreground">
                    {rotateTarget.key_prefix}…
                  </span>
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Grace period (hours)</label>
                <Input
                  type="number"
                  min={0}
                  max={720}
                  value={rotateGrace}
                  onChange={(e) =>
                    setRotateGrace(Math.max(0, Math.min(720, parseInt(e.target.value, 10) || 0)))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  Old key stays accepting requests for this long, then is revoked automatically. Use{" "}
                  <span className="font-mono">0</span> for an immediate cutover.
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            {rotateResult ? (
              <Button onClick={() => closeRotate(false)}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" disabled={rotateBusy} onClick={() => closeRotate(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={rotateBusy || !rotateTarget}
                  onClick={async () => {
                    if (!rotateTarget) return;
                    setRotateBusy(true);
                    try {
                      const r = await rotateFn({
                        data: { oldKeyId: rotateTarget.id, graceHours: rotateGrace },
                      });
                      if (r.ok) {
                        await navigator.clipboard.writeText(r.key).catch(() => {});
                        setRotateResult({ key: r.key, prefix: r.prefix, revokeAt: r.revokeAt });
                        qc.invalidateQueries({ queryKey: ["clone-api-keys"] });
                        toast.success("New key copied to clipboard");
                      } else {
                        toast.error(r.error);
                      }
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Rotation failed");
                    } finally {
                      setRotateBusy(false);
                    }
                  }}
                >
                  {rotateBusy ? "Rotating…" : "Rotate key"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActiveKeysPerClonePanel({ keys }: { keys: any[] }) {
  // Group by clone, then pick the newest non-revoked, non-grace key per clone.
  const groups = new Map<string, { cloneName: string; key: any }>();
  for (const k of keys) {
    if (k.revoked_at) continue;
    const cloneKey = k.clone_id ?? "__prime__";
    const cloneName = k.clones?.name ?? "Prime repo (Mission Control)";
    const existing = groups.get(cloneKey);
    if (
      !existing ||
      new Date(k.created_at).getTime() > new Date(existing.key.created_at).getTime()
    ) {
      // Prefer fully-active (no revoke_at) over a grace-period key
      if (
        !existing ||
        (existing.key.revoke_at && !k.revoke_at) ||
        !existing.key.revoke_at === !k.revoke_at
      ) {
        groups.set(cloneKey, { cloneName, key: k });
      }
    }
  }
  const rows = Array.from(groups.values()).sort((a, b) => a.cloneName.localeCompare(b.cloneName));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Latest active key per clone</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Clone</TableHead>
              <TableHead>Active prefix</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ cloneName, key }) => (
              <TableRow key={key.id}>
                <TableCell className="text-sm">{cloneName}</TableCell>
                <TableCell className="font-mono text-xs">{key.key_prefix}…</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(key.created_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "never"}
                </TableCell>
                <TableCell>
                  {key.revoke_at ? (
                    <Badge variant="outline">
                      grace · revokes {new Date(key.revoke_at).toLocaleString()}
                    </Badge>
                  ) : (
                    <Badge>active</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  No active keys yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Tenant Usage ────────────────────────────────────────────────────────────
