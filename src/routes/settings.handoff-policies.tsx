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
  listHandoffPolicies,
  upsertHandoffPolicy,
  deleteHandoffPolicy,
} from "@/lib/handoff-policies.functions";

export const Route = createFileRoute("/settings/handoff-policies")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <HandoffPoliciesPage />,
  head: () => ({ meta: [{ title: "Handoff Policies — Aurixa Systems" }] }),
});

function HandoffPoliciesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["handoff-policies"], queryFn: () => listHandoffPolicies() });

  const [name, setName] = useState("");
  const [regions, setRegions] = useState("");
  const [plans, setPlans] = useState("");
  const [minPlan, setMinPlan] = useState("");
  const [notes, setNotes] = useState("");

  const save = useMutation({
    mutationFn: () =>
      upsertHandoffPolicy({
        data: {
          name,
          allowed_regions: regions
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          allowed_plans: plans
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          min_plan: minPlan || null,
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["handoff-policies"] });
      setName("");
      setRegions("");
      setPlans("");
      setMinPlan("");
      setNotes("");
      toast.success("Policy saved");
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteHandoffPolicy({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["handoff-policies"] }),
  });

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Handoff Region + Plan Policies</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Define which target regions and plan tiers a handoff is allowed to select.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New policy</CardTitle>
          <CardDescription>Comma-separated lists of allowed values.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="APAC premium"
              />
            </div>
            <div>
              <Label>Minimum plan</Label>
              <Input
                value={minPlan}
                onChange={(e) => setMinPlan(e.target.value)}
                placeholder="pro"
              />
            </div>
          </div>
          <div>
            <Label>Allowed regions</Label>
            <Input
              value={regions}
              onChange={(e) => setRegions(e.target.value)}
              placeholder="ap-southeast-2, ap-northeast-1"
            />
          </div>
          <div>
            <Label>Allowed plans</Label>
            <Input
              value={plans}
              onChange={(e) => setPlans(e.target.value)}
              placeholder="pro, team, enterprise"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          <Button onClick={() => save.mutate()} disabled={!name || save.isPending}>
            {save.isPending ? "Saving…" : "Save policy"}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {(q.data ?? []).map((p: any) => (
          <Card key={p.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <CardDescription>Min plan: {p.min_plan ?? "—"}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={p.is_active ? "default" : "secondary"}>
                    {p.is_active ? "Active" : "Inactive"}
                  </Badge>
                  <Button size="sm" variant="destructive" onClick={() => del.mutate(p.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              <div>
                <strong>Regions:</strong> {p.allowed_regions.join(", ") || "—"}
              </div>
              <div>
                <strong>Plans:</strong> {p.allowed_plans.join(", ") || "—"}
              </div>
              {p.notes && <div className="text-muted-foreground">{p.notes}</div>}
            </CardContent>
          </Card>
        ))}
        {(q.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No policies yet.</p>
        )}
      </div>
    </div>
  );
}
