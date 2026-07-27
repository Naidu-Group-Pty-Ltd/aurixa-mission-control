import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import { usePrimeConfig } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Github, Cloud, Sparkles, Zap } from "lucide-react";
import { GitHubStatusCard } from "@/components/github-status-card";
import { GitHubSetupWizard } from "@/components/github-setup-wizard";
import { WebhookDeliveriesPanel } from "@/components/webhook-deliveries-panel";
import { GitHubSecretSyncCard } from "@/components/github-secret-sync-card";
import { PemKeyHelper } from "@/components/pem-key-helper";
import { ProfileEditorCard } from "@/components/profile-editor-card";
import { useUserRoles } from "@/lib/use-user-roles";
import { Lock } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

export const Route = createFileRoute("/settings/")({
  component: SettingsGeneralPage,
  head: () => ({ meta: [{ title: "Settings — Aurixa Systems Mission Control" }] }),
});

function SettingsGeneralPage() {
  const { data: prime, loading: primeLoading, error: primeError, refresh } = usePrimeConfig();
  const { isAdmin, isOperator, loading: rolesLoading } = useUserRoles();
  const canEditPrime = isAdmin;
  const canViewPrime = isOperator;
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [defaultOrg, setDefaultOrg] = useState("");
  const [cascadeMode, setCascadeMode] = useState<CascadeMode>("pr");
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the form once when the prime row loads. Without the `hydrated`
  // guard, every refresh() (e.g. after a save) would overwrite in-progress
  // edits — and if `prime` flips back to null briefly during a re-fetch we
  // would *not* clobber the form to empty.
  useEffect(() => {
    if (prime && !hydrated) {
      setOwner(prime.github_owner);
      setRepo(prime.github_repo);
      setBranch(prime.default_branch);
      setDefaultOrg(prime.default_clone_org ?? "");
      setCascadeMode(prime.default_cascade_mode);
      setHydrated(true);
    }
  }, [prime, hydrated]);

  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!owner.trim() || !repo.trim()) return toast.error("Owner and repo required");
    // Auto-sanitize: strip URLs down to just the repo name
    let cleanRepo = repo.trim();
    try {
      const parsed = new URL(cleanRepo);
      cleanRepo =
        parsed.pathname.replace(/^\//, "").replace(/\/$/, "").split("/").pop() || cleanRepo;
      setRepo(cleanRepo);
      toast.info(`Extracted repo name: ${cleanRepo}`);
    } catch {
      // Not a URL — good
    }
    if (cleanRepo.includes("://") || cleanRepo.includes("."))
      return toast.error("Repo should be the repository name only (e.g. 'my-repo'), not a URL");
    if (!branch.trim()) return toast.error("Default branch required");
    setSaving(true);
    const payload = {
      github_owner: owner.trim(),
      github_repo: cleanRepo,
      default_branch: branch.trim(),
      default_clone_org: defaultOrg.trim() || null,
      default_cascade_mode: cascadeMode,
    };
    try {
      // Re-check for an existing row right before write so a stale `prime`
      // snapshot doesn't make us insert a duplicate after another tab saved.
      const { data: existing, error: lookupErr } = await supabase
        .from("prime_config")
        .select("id")
        .limit(1)
        .maybeSingle();
      if (lookupErr) throw lookupErr;

      if (existing) {
        const { data: updated, error } = await supabase
          .from("prime_config")
          .update(payload)
          .eq("id", existing.id)
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!updated) throw new Error("Update returned no rows — check permissions");
      } else {
        const { error } = await supabase.from("prime_config").insert(payload);
        if (error) throw error;
      }
      toast.success("Prime config saved");
      // Refresh the backing data WITHOUT resetting hydrated — the form
      // already holds the correct values (they came from the inputs the
      // user just submitted). Setting hydrated=false before refresh()
      // caused a race: the useEffect would re-hydrate from STALE prime
      // data before refresh completed, locking in old values forever.
      await refresh();
      // Mark as hydrated so the next refresh doesn't clobber user edits
      setHydrated(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save prime config";
      // Surface the real DB error (RLS, NOT NULL, etc.) instead of swallowing.
      toast.error(msg);
      console.error("Prime config save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <ProfileEditorCard />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Github className="h-4 w-4" /> Prime repository
            {!canEditPrime && !rolesLoading ? (
              <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <Lock className="h-3 w-3" /> Admin only
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            The single source-of-truth codebase that all clones cascade from.
            {!canEditPrime && canViewPrime
              ? " View-only — ask an admin to change these values."
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {rolesLoading ? (
            <div className="md:col-span-2 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-muted-foreground">
              Checking permissions…
            </div>
          ) : !canViewPrime ? (
            <div className="md:col-span-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 font-mono text-xs text-warning">
              Your account does not have operator access. Ask an admin to grant you the operator or
              admin role to view or edit the Prime repository configuration.
            </div>
          ) : (
            <>
              {primeLoading && !prime ? (
                <div className="md:col-span-2 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-muted-foreground">
                  Loading prime configuration…
                </div>
              ) : null}
              {primeError ? (
                <div className="md:col-span-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
                  Failed to load prime config: {primeError}
                </div>
              ) : null}
              {!primeLoading && !prime && !primeError && canEditPrime ? (
                <div className="md:col-span-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 font-mono text-xs text-warning">
                  No prime config saved yet — fill in the fields below and click Save.
                </div>
              ) : null}
              {!primeLoading && !prime && !primeError && !canEditPrime ? (
                <div className="md:col-span-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 font-mono text-xs text-warning">
                  No prime config saved yet. An admin must configure the Prime repository.
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>GitHub owner</Label>
                <Input
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="my-org"
                  disabled={!canEditPrime}
                />
              </div>
              <div className="space-y-2">
                <Label>Repo</Label>
                <Input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="prime-codebase"
                  disabled={!canEditPrime}
                />
              </div>
              <div className="space-y-2">
                <Label>Default branch</Label>
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={!canEditPrime}
                />
              </div>
              <div className="space-y-2">
                <Label>Default org for new clones</Label>
                <Input
                  value={defaultOrg}
                  onChange={(e) => setDefaultOrg(e.target.value)}
                  placeholder="my-org"
                  disabled={!canEditPrime}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label className="flex items-center gap-2">
                  <Zap className="h-3.5 w-3.5" /> Default cascade mode (used on commit webhooks)
                </Label>
                <Select
                  value={cascadeMode}
                  onValueChange={(v) => setCascadeMode(v as CascadeMode)}
                  disabled={!canEditPrime}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pr">
                      PR — open a pull request on each clone for human review
                    </SelectItem>
                    <SelectItem value="auto_merge">
                      Auto-merge — push directly to each clone's default branch
                    </SelectItem>
                    <SelectItem value="notify">
                      Notify only — record the event, take no action
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {canEditPrime ? (
                <div className="md:col-span-2 flex justify-end">
                  <Button onClick={save} disabled={saving}>
                    {saving ? "Saving…" : "Save prime config"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <GitHubSetupWizard />

      <GitHubStatusCard />

      <PemKeyHelper />

      <WebhookDeliveriesPanel />

      {isAdmin && <GitHubSecretSyncCard target="prime" />}
      {isAdmin && <GitHubSecretSyncCard target="fleet" />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Github className="h-4 w-4" /> GitHub App
          </CardTitle>
          <CardDescription>
            Install the GitHub App on the org that will own clones to enable repo creation and PRs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline">Install GitHub App</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-accent" /> AI Layer
          </CardTitle>
          <CardDescription>
            Module detection, code automation, and the autonomous fleet manager — powered by the
            Lovable AI Gateway. No setup required.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div>
            · Module detection: <span className="font-mono text-foreground">enabled</span>
          </div>
          <div>
            · Code automation: <span className="font-mono text-foreground">enabled</span>
          </div>
          <div>
            · Autonomous fleet manager: <span className="font-mono text-foreground">enabled</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4 text-info" /> Cloudflare
          </CardTitle>
          <CardDescription>API token requested on first use.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
