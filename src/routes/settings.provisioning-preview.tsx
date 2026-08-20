import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getBootstrapSqlPreview } from "@/server/role-management.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Eye, Database, Copy, Shield, Crown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Database as DbTypes } from "@/integrations/supabase/types";

type Clone = DbTypes["public"]["Tables"]["clones"]["Row"];
// Non-secret projection: clone_backends holds service_role_key / db_pass / anon_key,
// which operators must never receive. Read the credential-free view instead.
type CloneBackend = DbTypes["public"]["Views"]["clone_backends_safe"]["Row"];

export const Route = createFileRoute("/settings/provisioning-preview")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <ProvisioningPreviewPage />,
  head: () => ({
    meta: [{ title: "Provisioning Preview — Aurixa Systems Mission Control" }],
  }),
});

function ProvisioningPreviewPage() {
  const [clones, setClones] = useState<Clone[]>([]);
  const [backends, setBackends] = useState<CloneBackend[]>([]);
  const [selectedCloneId, setSelectedCloneId] = useState<string>("");
  const [sql, setSql] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: cloneData }, { data: backendData }, sqlRes] = await Promise.all([
        supabase.from("clones").select("*").order("name"),
        // clone_backends_safe is the credential-free view (no service_role_key /
        // db_pass / anon_key), so selecting all of its columns is safe.
        supabase.from("clone_backends_safe").select("*"),
        getBootstrapSqlPreview(),
      ]);
      setClones(cloneData ?? []);
      setBackends(backendData ?? []);
      setSql(sqlRes.sql);
      if (cloneData?.length && !selectedCloneId) {
        setSelectedCloneId(cloneData[0].id);
      }
    } catch {
      toast.error("Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [selectedCloneId]);

  useEffect(() => {
    loadData();
  }, []);

  const selectedClone = clones.find((c) => c.id === selectedCloneId);
  const selectedBackend = backends.find((b) => b.clone_id === selectedCloneId);

  const copySQL = () => {
    navigator.clipboard.writeText(sql);
    toast.success("Bootstrap SQL copied to clipboard");
  };

  // Extract key schema highlights from the SQL
  const highlights = [
    {
      label: "Enum: app_role",
      detail: "super_admin → admin → operator → user",
      icon: Crown,
    },
    {
      label: "Seed account",
      detail: selectedBackend?.admin_email
        ? `${selectedBackend.admin_email} with role super_admin`
        : "Created via Auth Admin API with super_admin role",
      icon: Shield,
    },
    {
      label: "Hierarchy enforcement",
      detail: "role_level(), can_assign_role(), guard_last_super_admin triggers",
      icon: Shield,
    },
    {
      label: "Tables bootstrapped",
      detail: "profiles, user_roles (with assigned_by tracking)",
      icon: Database,
    },
  ];

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-accent/15 ring-1 ring-accent/40">
            <Eye className="h-5 w-5 text-accent" />
          </div>
          <div>
            <p className="label-mono">schema preview</p>
            <h1 className="mt-1 font-display text-[1.75rem] leading-[1.1]">Provisioning Preview</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Inspect the exact bootstrap SQL and seeded admin configuration for any clone.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {/* Clone selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Select Clone</CardTitle>
          <CardDescription>
            Choose a clone to preview its provisioning configuration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedCloneId} onValueChange={setSelectedCloneId}>
            <SelectTrigger className="w-full max-w-md">
              <SelectValue placeholder="Select a clone…" />
            </SelectTrigger>
            <SelectContent>
              {clones.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}{" "}
                  <span className="text-muted-foreground ml-1">({c.provisioning_method})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Schema highlights */}
      {selectedClone && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Schema Highlights — {selectedClone.name}</CardTitle>
            <CardDescription>
              Method: <Badge variant="outline">{selectedClone.provisioning_method}</Badge>
              {selectedBackend && (
                <>
                  {" "}
                  · Backend:{" "}
                  <Badge
                    variant="outline"
                    className={cn(
                      selectedBackend.status === "ready" ? "text-success" : "text-warning",
                    )}
                  >
                    {selectedBackend.status}
                  </Badge>
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {highlights.map((h) => {
                const Icon = h.icon;
                return (
                  <div key={h.label} className="flex items-start gap-3 border bg-surface p-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div>
                      <div className="text-sm font-medium">{h.label}</div>
                      <div className="text-xs text-muted-foreground">{h.detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bootstrap SQL */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                Bootstrap SQL
              </CardTitle>
              <CardDescription>
                The exact SQL executed when provisioning a new clone backend.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={copySQL}>
              <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[500px]">
            <pre className="p-4 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {sql || "Loading…"}
            </pre>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Seed admin details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Crown className="h-3.5 w-3.5 text-warning" />
            Seed Admin Account
          </CardTitle>
          <CardDescription>
            Every clone is born with one super_admin seed account. This account can then cascade the
            admin hierarchy downward.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-2 border bg-surface p-3">
              <span className="text-muted-foreground">Role</span>
              <span className="font-mono font-medium text-warning">super_admin (level 100)</span>
              <span className="text-muted-foreground">assigned_by</span>
              <span className="font-mono text-muted-foreground/70">NULL (system-seeded)</span>
              <span className="text-muted-foreground">Email</span>
              <span className="font-mono">
                {selectedBackend?.admin_email ?? "Specified during provisioning"}
              </span>
              <span className="text-muted-foreground">Can assign</span>
              <span>admin, operator, user</span>
              <span className="text-muted-foreground">Protection</span>
              <span>Cannot be removed if last super_admin (guardrail trigger)</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
