import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { createHandoff } from "@/lib/handoffs.functions";
import { listClientSupabaseAccounts } from "@/lib/client-supabase-accounts.functions";
import { listHandoffPolicies } from "@/lib/handoff-policies.functions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/handoffs/new")({
  component: () => (
    <ProtectedRoute>
      <NewHandoffPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "New Handoff — Aurixa Systems" }] }),
});

function NewHandoffPage() {
  const navigate = useNavigate();
  const [cloneId, setCloneId] = useState("");
  const [clientAccountId, setClientAccountId] = useState<string>("");
  const [policyId, setPolicyId] = useState<string>("");
  const [path, setPath] = useState<"rebuild_twin" | "enterprise_transfer">("rebuild_twin");
  const [targetRegion, setTargetRegion] = useState("");
  const [targetPlan, setTargetPlan] = useState("");
  const [notes, setNotes] = useState("");

  const clonesQ = useQuery({
    queryKey: ["clones-min"],
    queryFn: async () => {
      const { data } = await supabase.from("clones").select("id, name, slug").order("name");
      return data ?? [];
    },
  });
  const accountsQ = useQuery({
    queryKey: ["client-accounts"],
    queryFn: () => listClientSupabaseAccounts(),
  });
  const policiesQ = useQuery({
    queryKey: ["handoff-policies"],
    queryFn: () => listHandoffPolicies(),
  });

  const create = useMutation({
    mutationFn: () =>
      createHandoff({
        data: {
          clone_id: cloneId,
          client_account_id: clientAccountId || null,
          policy_id: policyId || null,
          path,
          target_region: targetRegion || null,
          target_plan_tier: targetPlan || null,
          metadata: notes ? { notes } : {},
        },
      }),
    onSuccess: (res: any) => {
      if (res?.ok) {
        toast.success("Handoff created");
        navigate({ to: "/handoffs/$handoffId", params: { handoffId: res.id } });
      } else {
        toast.error(res?.error ?? "Failed");
      }
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-[1.75rem] leading-[1.1]">New Handoff</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Register a handoff intent. Dry-run parity, snapshot, twin provisioning, and cutover run in
          later steps.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
          <CardDescription>Clone + client organization the backend will move to.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Clone</Label>
            <Select value={cloneId} onValueChange={setCloneId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a clone…" />
              </SelectTrigger>
              <SelectContent>
                {(clonesQ.data ?? []).map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.slug})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Client Supabase account</Label>
            <Select
              value={clientAccountId || "__none__"}
              onValueChange={(v) => setClientAccountId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="— none yet —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— none yet —</SelectItem>
                {(accountsQ.data ?? []).map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.owner_email} {a.org_slug ? `(${a.org_slug})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Path</Label>
              <Select value={path} onValueChange={(v) => setPath(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rebuild_twin">Rebuild twin (default)</SelectItem>
                  <SelectItem value="enterprise_transfer">Enterprise transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Region policy</Label>
              <Select
                value={policyId || "__none__"}
                onValueChange={(v) => setPolicyId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— none —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— none —</SelectItem>
                  {(policiesQ.data ?? []).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Target region</Label>
              <Input
                value={targetRegion}
                onChange={(e) => setTargetRegion(e.target.value)}
                placeholder="e.g. ap-southeast-2"
              />
            </div>
            <div>
              <Label>Target plan tier</Label>
              <Input
                value={targetPlan}
                onChange={(e) => setTargetPlan(e.target.value)}
                placeholder="pro / team / enterprise"
              />
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
          <Button onClick={() => create.mutate()} disabled={!cloneId || create.isPending}>
            {create.isPending ? "Creating…" : "Create handoff"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
