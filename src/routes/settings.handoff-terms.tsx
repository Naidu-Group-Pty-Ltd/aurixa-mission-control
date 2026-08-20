// G13 — Terms-versions admin UI. Draft, activate, retire.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  listHandoffTermsVersions,
  createHandoffTermsVersion,
  activateHandoffTermsVersion,
  retireHandoffTermsVersion,
} from "@/lib/handoff-terms.functions";

export const Route = createFileRoute("/settings/handoff-terms")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <HandoffTermsPage />,
  head: () => ({ meta: [{ title: "Handoff Terms — Aurixa Systems" }] }),
});

function HandoffTermsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["handoff-terms-versions"],
    queryFn: () => listHandoffTermsVersions(),
  });

  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [activateOnCreate, setActivateOnCreate] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createHandoffTermsVersion({
        data: { version, title, body_md: body, activate: activateOnCreate },
      }),
    onSuccess: () => {
      toast.success("Terms version created");
      setVersion("");
      setTitle("");
      setBody("");
      setActivateOnCreate(false);
      qc.invalidateQueries({ queryKey: ["handoff-terms-versions"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Create failed"),
  });

  const activate = useMutation({
    mutationFn: (id: string) => activateHandoffTermsVersion({ data: { id } }),
    onSuccess: () => {
      toast.success("Activated");
      qc.invalidateQueries({ queryKey: ["handoff-terms-versions"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Activate failed"),
  });

  const retire = useMutation({
    mutationFn: (id: string) => retireHandoffTermsVersion({ data: { id } }),
    onSuccess: () => {
      toast.success("Retired");
      qc.invalidateQueries({ queryKey: ["handoff-terms-versions"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Retire failed"),
  });

  const versions = q.data?.versions ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-[1.75rem] leading-[1.1]">Handoff terms versions</h1>
        <p className="text-sm text-muted-foreground">
          Canonical DPA text that clients sign during handoff onboarding. Each version's body is
          SHA-256 hashed; the active version is served to new invites.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Draft a new version</CardTitle>
          <CardDescription>
            Use semver-ish labels (e.g. <code>2026-07</code> or <code>v3.1</code>). The body is
            stored as Markdown and hashed at save time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Version label</Label>
              <Input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="2026-07"
              />
            </div>
            <div>
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Aurixa Handoff DPA v2026-07"
              />
            </div>
          </div>
          <div>
            <Label>Body (Markdown)</Label>
            <Textarea
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`# Data Processing Agreement\n\n1. Scope...\n2. Data subjects...`}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="activate"
              type="checkbox"
              checked={activateOnCreate}
              onChange={(e) => setActivateOnCreate(e.target.checked)}
            />
            <Label htmlFor="activate">Activate immediately</Label>
          </div>
          <Button
            onClick={() => create.mutate()}
            disabled={!version || !title || body.length < 20 || create.isPending}
          >
            {create.isPending ? "Saving…" : "Save version"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing versions</CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : versions.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No terms drafted yet. Create one above to enable signed handoffs.
            </div>
          ) : (
            <div className="space-y-3">
              {versions.map((v: any) => (
                <div
                  key={v.id}
                  className="flex flex-col md:flex-row md:items-center justify-between gap-2 border p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{v.version}</span>
                      <span className="text-sm text-muted-foreground">{v.title}</span>
                      {v.is_active ? (
                        <Badge>Active</Badge>
                      ) : v.retired_at ? (
                        <Badge variant="secondary">Retired</Badge>
                      ) : (
                        <Badge variant="outline">Draft</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono break-all">
                      sha256: {v.terms_hash}
                    </div>
                    {v.effective_at && (
                      <div className="text-xs text-muted-foreground">
                        Effective {new Date(v.effective_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {!v.is_active && (
                      <Button size="sm" onClick={() => activate.mutate(v.id)}>
                        Activate
                      </Button>
                    )}
                    {v.is_active && (
                      <Button size="sm" variant="outline" onClick={() => retire.mutate(v.id)}>
                        Retire
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
