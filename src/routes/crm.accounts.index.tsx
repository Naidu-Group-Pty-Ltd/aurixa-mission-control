// @ts-nocheck
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// CRM account list — the book of business.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { listAccounts, upsertAccount, LIFECYCLE_STAGES } from "@/lib/crm.functions";
import { Users, Plus, Search } from "lucide-react";
import { toast } from "sonner";

const searchSchema = z.object({
  stage: fallback(z.enum(["all", ...LIFECYCLE_STAGES]), "all").default("all"),
  q: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/crm/accounts/")({
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <AccountsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "CRM Accounts — Aurixa Mission Control" },
      {
        name: "description",
        content: "Every client organisation with lifecycle stage, owner, revenue and health score.",
      },
      { property: "og:title", content: "CRM Accounts — Aurixa Mission Control" },
      { property: "og:description", content: "The Aurixa book of business, end to end." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(
    (cents ?? 0) / 100,
  );

export function stageVariant(stage: string) {
  if (stage === "active") return "default";
  if (stage === "at_risk" || stage === "churned") return "destructive";
  return "secondary";
}

function healthTone(score: number | null) {
  if (score == null) return "text-muted-foreground";
  if (score >= 70) return "text-emerald-500";
  if (score >= 40) return "text-amber-500";
  return "text-destructive";
}

function NewAccountDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [classification, setClassification] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await upsertAccount({ data: { name: name.trim(), classification: classification || null } });
      toast.success("Account created");
      setOpen(false);
      setName("");
      setClassification("");
      onCreated();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not create account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" /> New account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client account</DialogTitle>
          <DialogDescription>
            Create the organisation record. Contacts, deals and contracts attach to it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="acct-name">Organisation name</Label>
            <Input id="acct-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-class">Classification</Label>
            <Input
              id="acct-class"
              placeholder="buyers_agent, wealth_advisor, …"
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const [term, setTerm] = useState(search.q ?? "");

  const q = useQuery({
    queryKey: ["crm", "accounts", search.stage, search.q],
    queryFn: () => listAccounts({ data: { stage: search.stage, search: search.q } }),
  });
  const rows = q.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        eyebrow="book of business"
        title="Accounts"
        description="Client organisations across every lifecycle stage."
        actions={<NewAccountDialog onCreated={() => qc.invalidateQueries({ queryKey: ["crm"] })} />}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search accounts…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate({ search: (p: any) => ({ ...p, q: term }) });
            }}
          />
        </div>
        <Select
          value={search.stage}
          onValueChange={(v) => navigate({ search: (p: any) => ({ ...p, stage: v }) })}
        >
          <SelectTrigger className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stages</SelectItem>
            {LIFECYCLE_STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows.length === 0 && !q.isLoading ? (
        <EmptyState
          icon={Users}
          title="No accounts yet"
          description="Convert a waitlist lead or create an account manually to start tracking a client."
        />
      ) : (
        <div className="grid gap-3">
          {rows.map((a: any) => {
            const primary = (a.crm_contacts ?? []).find((c: any) => c.is_primary) ?? a.crm_contacts?.[0];
            return (
              <Link key={a.id} to="/crm/accounts/$accountId" params={{ accountId: a.id }}>
                <Card className="transition-colors hover:bg-muted/40">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">{a.name}</p>
                        <Badge variant={stageVariant(a.lifecycle_stage)}>
                          {a.lifecycle_stage.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {primary
                          ? `${primary.first_name} ${primary.last_name ?? ""} · ${primary.email ?? ""}`
                          : "No primary contact"}
                        {a.classification ? ` · ${a.classification.replace(/_/g, " ")}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-6 text-right">
                      <div>
                        <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                          MRR
                        </p>
                        <p className="text-sm font-medium">{money(a.mrr_cents)}</p>
                      </div>
                      <div>
                        <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                          Health
                        </p>
                        <p className={"text-sm font-medium " + healthTone(a.health_score)}>
                          {a.health_score ?? "—"}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
