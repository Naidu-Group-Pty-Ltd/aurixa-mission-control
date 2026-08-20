// /security/intake — admin UI for the provider-neutral security intake system.
// Manage upstream sources (Codex, manual, ticketing, generic), rotate their
// HMAC secrets, and view the endpoint contract vendors POST to.

import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { KeyRound, Plus, Trash2, Copy, PlugZap } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { AppShell } from "@/components/app-shell";
import {
  listSecurityIntakeSources,
  upsertSecurityIntakeSource,
  rotateSecurityIntakeSecret,
  deleteSecurityIntakeSource,
} from "@/lib/security-intake.functions";

export const Route = createFileRoute("/security/intake")({
  component: () => (
    <ProtectedRoute>
      <AppShell>
        <SecurityIntakePage />
      </AppShell>
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Security Intake Sources — Aurixa Systems" }] }),
});


const KIND_LABELS: Record<string, string> = {
  codex: "Codex Security",
  manual: "Manual operator",
  ticketing: "Ticketing (Linear/Jira)",
  generic: "Generic scanner",
};

function SecurityIntakePage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSecurityIntakeSources);
  const upsertFn = useServerFn(upsertSecurityIntakeSource);
  const rotateFn = useServerFn(rotateSecurityIntakeSecret);
  const deleteFn = useServerFn(deleteSecurityIntakeSource);

  const q = useQuery({ queryKey: ["security-intake-sources"], queryFn: () => listFn() });

  const [editing, setEditing] = useState<null | {
    id?: string;
    slug: string;
    name: string;
    kind: "codex" | "manual" | "ticketing" | "generic";
    active: boolean;
  }>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ slug: string; secret: string } | null>(null);

  const upsert = useMutation({
    mutationFn: (input: any) => upsertFn({ data: input }),
    onSuccess: () => {
      toast.success("Source saved");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["security-intake-sources"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => rotateFn({ data: { id } }),
    onSuccess: (res, id) => {
      const src = q.data?.sources.find((s: any) => s.id === id);
      setRevealedSecret({ slug: src?.slug ?? "", secret: res.secret });
      qc.invalidateQueries({ queryKey: ["security-intake-sources"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Rotate failed"),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Source deleted");
      qc.invalidateQueries({ queryKey: ["security-intake-sources"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Delete failed"),
  });

  const endpoint = useMemo(() => {
    if (typeof window === "undefined") return "/api/public/security/intake";
    return `${window.location.origin}/api/public/security/intake`;
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
            mission control · security intake
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl font-semibold tracking-tight">
            <PlugZap className="h-7 w-7 text-primary" />
            Provider-neutral intake sources
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Any scanner or ticketing system can POST normalized findings into Mission Control via the shared
            intake endpoint. Each source authenticates with its own rotatable HMAC secret.
          </p>
        </div>
        <Button
          onClick={() =>
            setEditing({ slug: "", name: "", kind: "generic", active: true })
          }
        >
          <Plus className="mr-2 h-4 w-4" /> Add source
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Endpoint contract</CardTitle>
          <CardDescription>Vendors sign the raw body with their source's secret.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <EndpointRow label="URL" value={endpoint} />
          <EndpointRow label="Method" value="POST" mono />
          <EndpointRow label="Header · x-intake-source" value="<source_slug>" mono />
          <EndpointRow label="Header · x-intake-signature" value="sha256=<hex hmac_sha256(body, secret)>" mono />
          <div className="rounded-md border bg-muted/30 p-3 text-xs font-mono leading-5">
            {`{
  "version": "1",
  "op": "ingest" | "status" | "link_ticket",
  "finding": { "external_id", "title", "severity", "description?", "clone_id?", ... },
  "external_id": "…",   "state": "resolved" | "dismissed" | …,      // op = status
  "finding_external_id": "…",
  "ticket": { "provider": "linear", "external_id": "AUR-123", "url": "https://…", "status": "open" }
}`}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registered sources</CardTitle>
          <CardDescription>Codex and Manual are built-in and cannot be deleted.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Secret</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-[220px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.sources ?? []).map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.slug}</TableCell>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{KIND_LABELS[s.kind] ?? s.kind}</Badge>
                  </TableCell>
                  <TableCell>
                    {s.hmac_secret_set ? (
                      <Badge variant="secondary">Configured</Badge>
                    ) : (
                      <Badge variant="destructive">Missing</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.active ? "default" : "outline"}>
                      {s.active ? "Active" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({
                            id: s.id,
                            slug: s.slug,
                            name: s.name,
                            kind: s.kind,
                            active: s.active,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => rotate.mutate(s.id)}
                        disabled={rotate.isPending}
                      >
                        <KeyRound className="mr-1 h-3.5 w-3.5" /> Rotate
                      </Button>
                      {!s.metadata?.built_in && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Delete source "${s.slug}"?`)) del.mutate(s.id);
                          }}
                          disabled={del.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(q.data?.sources ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No intake sources yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit / create dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit intake source" : "Add intake source"}</DialogTitle>
            <DialogDescription>
              Give the source a stable slug — vendors send it in the `x-intake-source` header.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label>Slug</Label>
                <Input
                  value={editing.slug}
                  disabled={!!editing.id}
                  onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
                  placeholder="snyk-prod"
                />
              </div>
              <div>
                <Label>Name</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Snyk (production org)"
                />
              </div>
              <div>
                <Label>Kind</Label>
                <Select
                  value={editing.kind}
                  onValueChange={(v: any) => setEditing({ ...editing, kind: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(KIND_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={editing.active}
                  onCheckedChange={(v) => setEditing({ ...editing, active: v })}
                />
                <Label>Active</Label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  onClick={() => upsert.mutate(editing)}
                  disabled={upsert.isPending || !editing.slug || !editing.name}
                >
                  Save
                </Button>
              </div>
              {!editing.id && (
                <p className="text-xs text-muted-foreground">
                  After saving, click <b>Rotate</b> on the source row to generate its HMAC secret.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Secret reveal dialog (shown exactly once) */}
      <Dialog open={!!revealedSecret} onOpenChange={(o) => !o && setRevealedSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New secret for {revealedSecret?.slug}</DialogTitle>
            <DialogDescription>
              Copy this now — Mission Control will never show it again. Configure the vendor to sign
              request bodies with it (HMAC-SHA256).
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={revealedSecret?.secret ?? ""} className="font-mono text-xs" />
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                if (revealedSecret) {
                  void navigator.clipboard.writeText(revealedSecret.secret);
                  toast.success("Copied to clipboard");
                }
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setRevealedSecret(null)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EndpointRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-[200px] text-muted-foreground">{label}</span>
      <code className={mono ? "rounded bg-muted px-2 py-1 text-xs" : "rounded bg-muted px-2 py-1 text-xs"}>
        {value}
      </code>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success("Copied");
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
