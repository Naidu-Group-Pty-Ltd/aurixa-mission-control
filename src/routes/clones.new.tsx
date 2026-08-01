// @ts-nocheck
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useModules, usePrimeConfig } from "@/lib/queries";
import { TierModulePicker, type TierSelection } from "@/components/tier-module-picker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GitFork, Copy, Layers, Info, Shield, Check, Database } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useServerFn } from "@tanstack/react-start";
import { provisionClone } from "@/server/clone-provisioning.functions";
import { provisionBackend } from "@/lib/backend-provisioning.functions";
import { enqueueEdgeJob } from "@/server/edge-provisioning.functions";
import { requestCloneSubdomain } from "@/server/subdomain-hosting.functions";
import {
  checkGithubAppPreflight,
  type GithubPreflightResult,
} from "@/lib/github-preflight.functions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";

export const Route = createFileRoute("/clones/new")({
  component: () => (
    <ProtectedRoute>
      <NewClone />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Provision clone — Aurixa Systems Mission Control" }] }),
});

type Method = "fork" | "template" | "clone";

const METHODS: {
  value: Method;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  pros: string[];
  cons: string[];
  recommended?: string;
}[] = [
  {
    value: "fork",
    title: "Fork",
    icon: GitFork,
    pros: ["Keeps Git history link to prime", "Easiest upstream tracking", "Native to GitHub"],
    cons: ["Same network as prime — visibility leaks possible", "Org transfer is awkward"],
  },
  {
    value: "template",
    title: "Template Repo",
    icon: Copy,
    recommended: "Recommended for client-isolated deployments",
    pros: [
      "Fully independent repo — no fork relationship",
      "Clean for client handover",
      "Best privacy isolation",
    ],
    cons: ["No automatic upstream link — cascade engine handles sync"],
  },
  {
    value: "clone",
    title: "Independent Clone",
    icon: Layers,
    pros: ["Total decoupling — own org, own ACL", "Strip history if needed"],
    cons: ["Heaviest setup", "All sync handled by cascade engine"],
  },
];

function NewClone() {
  const nav = useNavigate();
  const { data: modules } = useModules();
  const { data: prime } = usePrimeConfig();
  const provision = useServerFn(provisionClone);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [method, setMethod] = useState<Method>("template");
  const [ownerMode, setOwnerMode] = useState<"org" | "transfer">("org");
  const [transferTarget, setTransferTarget] = useState("");
  const [cloudflare, setCloudflare] = useState(false);
  const [edgeProvider, setEdgeProvider] = useState<"cloudflare" | "aws" | "azure">("cloudflare");
  const [edgeHostname, setEdgeHostname] = useState("");
  const [edgePreset, setEdgePreset] = useState("balanced");
  const [subdomainEnabled, setSubdomainEnabled] = useState(true);
  const [subdomainSlug, setSubdomainSlug] = useState("");
  const requestSubdomainFn = useServerFn(requestCloneSubdomain);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [tierSelection, setTierSelection] = useState<TierSelection>({
    planSlug: null,
    addonSlugs: [],
  });
  const [notes, setNotes] = useState("");
  const [billingUserId, setBillingUserId] = useState("");
  const [billingStripeCustomerId, setBillingStripeCustomerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [dedicatedBackend, setDedicatedBackend] = useState(true);
  // Isolated tenant: hard-requires a dedicated backend. Defaults true for
  // template/independent clones (typical client-isolated setup). (Audit #11.)
  const [isolatedTenant, setIsolatedTenant] = useState(true);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [backendRegion, setBackendRegion] = useState("us-east-1");
  const provisionBackendFn = useServerFn(provisionBackend);
  const enqueueEdge = useServerFn(enqueueEdgeJob);
  // Issue #13: idempotency key for the whole submit. Generated once per
  // wizard mount so a double-click / retry lands on the same clone row
  // instead of forking a second GitHub repo. Rotated after a fresh
  // (non-idempotent) success in case the operator wants to create another.
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const preflightFn = useServerFn(checkGithubAppPreflight);
  const [preflight, setPreflight] = useState<GithubPreflightResult | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);

  // Default the org field to the prime's default_clone_org once it loads
  useEffect(() => {
    if (prime?.default_clone_org && !transferTarget) {
      // Pre-populate transfer target as a hint, but don't force ownerMode
    }
  }, [prime, transferTarget]);

  const togglePick = (id: string) => {
    const n = new Set(picked);
    n.has(id) ? n.delete(id) : n.add(id);
    setPicked(n);
  };

  const currentTargetOwner = () =>
    ownerMode === "transfer"
      ? transferTarget.trim()
      : prime?.default_clone_org?.trim() || prime?.github_owner?.trim() || "";

  const runPreflight = async (): Promise<GithubPreflightResult | null> => {
    if (method === "clone") return null;
    const owner = currentTargetOwner();
    if (!owner) return null;
    setPreflightBusy(true);
    try {
      const res = await preflightFn({
        data: {
          targetOwner: owner,
          method,
          templateOwner: method === "template" ? (prime?.github_owner ?? null) : null,
          templateRepo: method === "template" ? (prime?.github_repo ?? null) : null,
        },
      });
      setPreflight(res);
      return res;
    } catch (e) {
      const err: GithubPreflightResult = {
        ok: false,
        appConfigured: false,
        installationFound: false,
        targetOwner: owner,
        message: e instanceof Error ? e.message : "Preflight failed",
      };
      setPreflight(err);
      return err;
    } finally {
      setPreflightBusy(false);
    }
  };

  // Auto-run preflight when the target owner or method changes.
  useEffect(() => {
    setPreflight(null);
    const owner = currentTargetOwner();
    if (!owner || method === "clone") return;
    const t = setTimeout(() => {
      runPreflight();
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    method,
    ownerMode,
    transferTarget,
    prime?.default_clone_org,
    prime?.github_owner,
    prime?.github_repo,
  ]);

  // Isolated tenants ALWAYS need a dedicated backend — enforce it as the
  // wizard's source of truth so the checkbox never drifts out of sync.
  useEffect(() => {
    if (isolatedTenant && !dedicatedBackend) setDedicatedBackend(true);
  }, [isolatedTenant, dedicatedBackend]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (isolatedTenant && !dedicatedBackend) {
      toast.error("Isolated tenants require a dedicated backend");
      return;
    }
    if (dedicatedBackend && !adminEmail.trim()) {
      toast.error("Admin email is required for dedicated backend");
      return;
    }
    if (dedicatedBackend && adminPassword.length < 8) {
      toast.error("Admin password must be at least 8 characters");
      return;
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const targetOwner =
      ownerMode === "transfer"
        ? transferTarget.trim()
        : prime?.default_clone_org?.trim() || prime?.github_owner?.trim() || "";

    if ((method === "fork" || method === "template") && !targetOwner) {
      toast.error(
        ownerMode === "transfer"
          ? "Enter the GitHub org/user that will own the new repo"
          : "Set a default clone org in Settings, or pick 'Transfer to client' and enter one",
      );
      return;
    }

    // GitHub App preflight — fail fast before we create the clone row.
    if (method !== "clone") {
      const pf = await runPreflight();
      if (pf && !pf.ok) {
        toast.error(pf.message || "GitHub App preflight failed. See details above.");
        return;
      }
    }

    setBusy(true);
    try {
      // Derive the slug suffix from the idempotency key so retries reuse
      // the same target repo name — otherwise the second attempt would
      // race against a partially-created GitHub repo. (Audit finding #13.)
      const slugSuffix = idempotencyKey
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 6)
        .toLowerCase();
      const result = await provision({
        data: {
          name,
          slug: `${slug}-${slugSuffix}`,
          method,
          targetOwner: targetOwner || "manual",
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          cloudflareEnabled: cloudflare,
          notes,
          moduleIds: Array.from(picked),
          planSlug: tierSelection.planSlug,
          addonSlugs: tierSelection.addonSlugs,
          isolatedTenant,
          billingUserId: billingUserId.trim() || null,
          billingStripeCustomerId: billingStripeCustomerId.trim() || null,
          idempotencyKey,
        },
      });

      if (!result.ok) {
        toast.error(result.error);
        setBusy(false);
        return;
      }

      if ("idempotent" in result && result.idempotent) {
        toast.info("Clone already provisioned for this submission — reusing existing record.");
      } else {
        toast.success(
          method === "clone"
            ? "Clone registered (independent — wire up the repo manually)"
            : `Clone provisioned${result.githubUrl ? " on GitHub" : ""}`,
        );
      }

      // Enqueue backend provisioning if enabled. The wizard only awaits the
      // enqueue (fast); the actual provisioning is executed by the pg_cron
      // drain worker so it survives navigation and Worker request limits.
      if (dedicatedBackend) {
        try {
          const backendResult = await provisionBackendFn({
            data: {
              cloneId: result.cloneId,
              cloneName: name,
              region: backendRegion,
              adminEmail,
              adminPassword,
              // Issue #12: do NOT pass moduleIds here. provisionClone has
              // already written the authoritative set to `clone_modules`;
              // the backend server fn reads from there so the two tracks
              // cannot drift if the picker state changes mid-submit.
            },
          });

          if ("ok" in backendResult && backendResult.ok) {
            toast.info(
              "Backend queued — the background worker will provision it in ~1–2 minutes. You can watch progress on the clone page.",
            );
          } else if ("error" in backendResult) {
            toast.error(`Backend queue failed: ${backendResult.error}`);
          }
        } catch (e) {
          toast.error(`Backend queue failed: ${e instanceof Error ? e.message : "unknown"}`);
        }
      }

      // Enqueue edge attach if user chose one.
      if (cloudflare) {
        try {
          await enqueueEdge({
            data: {
              cloneId: result.cloneId,
              providerSlug: edgeProvider,
              action: "attach",
              payload: {
                hostname: edgeHostname.trim() || undefined,
                posturePreset: edgePreset,
              },
            },
          });
          toast.info(
            edgeProvider === "cloudflare"
              ? "Edge attach queued — worker will run within a minute"
              : `${edgeProvider.toUpperCase()} waitlisted — coming soon`,
          );
        } catch (e) {
          toast.error(`Edge enqueue failed: ${e instanceof Error ? e.message : "unknown"}`);
        }
      }

      // Enqueue subdomain provisioning (dormant until CF is configured).
      if (subdomainEnabled) {
        const desired = (subdomainSlug.trim() || slug)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 63);
        if (desired) {
          try {
            const r = await requestSubdomainFn({
              data: { cloneId: result.cloneId, slug: desired },
            });
            toast.info(
              r.status === "queued"
                ? `Subdomain queued — ${r.fqdn}`
                : `Subdomain reserved (${r.fqdn}) — will provision once Cloudflare is configured`,
            );
          } catch (e) {
            toast.error(`Subdomain request failed: ${e instanceof Error ? e.message : "unknown"}`);
          }
        }
      }

      setBusy(false);
      nav({ to: "/clones/$cloneId", params: { cloneId: result.cloneId } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Provisioning failed");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
          provisioning
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">New clone</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Spin up a child instance of the prime codebase.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1 · Identity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="acme-prod" />
          </div>
          <div className="space-y-2">
            <Label>Tags (comma-separated)</Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="client, eu-west, prod"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2 · Provisioning method</CardTitle>
          <CardDescription>How should the new repo come into existence?</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {METHODS.map((m) => {
            const Icon = m.icon;
            const active = method === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setMethod(m.value)}
                className={cn(
                  "relative rounded-lg border p-4 text-left transition-all",
                  active
                    ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--color-primary)]"
                    : "border-border bg-card hover:border-primary/40",
                )}
              >
                {m.recommended && (
                  <Badge className="absolute -right-2 -top-2 bg-accent text-accent-foreground">
                    Recommended
                  </Badge>
                )}
                <div className="flex items-center justify-between">
                  <Icon
                    className={cn("h-5 w-5", active ? "text-primary" : "text-muted-foreground")}
                  />
                  {active && <Check className="h-4 w-4 text-primary" />}
                </div>
                <div className="mt-3 font-mono font-semibold">{m.title}</div>
                {m.recommended && (
                  <div className="mt-1 text-[11px] text-accent">{m.recommended}</div>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="mt-3 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                      <Info className="h-3 w-3" /> pros & cons
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-2 text-xs">
                      <div>
                        <div className="font-mono uppercase text-success">pros</div>
                        <ul className="mt-1 list-disc pl-4">
                          {m.pros.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="font-mono uppercase text-warning">cons</div>
                        <ul className="mt-1 list-disc pl-4">
                          {m.cons.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </button>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3 · Ownership</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setOwnerMode("org")}
              className={cn(
                "flex-1 rounded-md border p-3 text-left text-sm",
                ownerMode === "org" ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <div className="font-mono text-xs uppercase text-muted-foreground">default</div>
              <div className="font-medium">Your org owns it</div>
              <div className="text-xs text-muted-foreground">Transferable later</div>
            </button>
            <button
              type="button"
              onClick={() => setOwnerMode("transfer")}
              className={cn(
                "flex-1 rounded-md border p-3 text-left text-sm",
                ownerMode === "transfer" ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <div className="font-mono text-xs uppercase text-muted-foreground">handover</div>
              <div className="font-medium">Transfer to client</div>
              <div className="text-xs text-muted-foreground">Provide their GitHub login/email</div>
            </button>
          </div>
          {ownerMode === "transfer" && (
            <Input
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              placeholder="client-org-or-username"
            />
          )}

          {method !== "clone" && (
            <div className="pt-1">
              {preflightBusy && !preflight ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking GitHub App installation…
                </div>
              ) : preflight ? (
                <Alert
                  variant={preflight.ok ? "default" : "destructive"}
                  className={cn(
                    preflight.ok && "border-success/40 bg-success/5 text-success-foreground",
                  )}
                >
                  <div className="flex items-start gap-2">
                    {preflight.ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4" />
                    )}
                    <div className="flex-1">
                      <AlertTitle className="text-xs font-mono uppercase tracking-wider">
                        {preflight.ok ? "GitHub App ready" : "GitHub App preflight failed"}
                      </AlertTitle>
                      <AlertDescription className="mt-1 text-xs">
                        {preflight.message}
                        {preflight.hint && (
                          <div className="mt-1 opacity-80">Hint: {preflight.hint}</div>
                        )}
                        <div className="mt-2 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => runPreflight()}
                            className="font-mono text-[11px] underline underline-offset-2"
                            disabled={preflightBusy}
                          >
                            re-check
                          </button>
                          {!preflight.installationFound && (
                            <a
                              href="https://github.com/apps"
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-[11px] underline underline-offset-2"
                            >
                              install app →
                            </a>
                          )}
                        </div>
                      </AlertDescription>
                    </div>
                  </div>
                </Alert>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <TierModulePicker
        modules={modules}
        picked={picked}
        onPickedChange={setPicked}
        selection={tierSelection}
        onSelectionChange={setTierSelection}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-primary" /> 5 · Dedicated backend
          </CardTitle>
          <CardDescription>
            Provision an isolated Supabase project replicating the prime repo's backend architecture
            — schemas, tables, RLS, edge functions, and secret names as empty shells. No live data
            is copied. The admin user will be auto-created with full access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
            <Checkbox
              checked={isolatedTenant}
              onCheckedChange={(v) => setIsolatedTenant(!!v)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Isolated tenant</div>
              <div className="text-xs text-muted-foreground">
                Locks this clone to its own dedicated backend. Recommended for client-owned
                deployments. While enabled, the backend cannot be deleted and this clone cannot fall
                back to the prime database.
              </div>
            </div>
          </label>
          <label
            className={cn(
              "flex items-center gap-3",
              isolatedTenant ? "cursor-not-allowed opacity-70" : "cursor-pointer",
            )}
          >
            <Checkbox
              checked={dedicatedBackend}
              onCheckedChange={(v) => !isolatedTenant && setDedicatedBackend(!!v)}
              disabled={isolatedTenant}
            />
            <span className="text-sm">
              Provision a dedicated backend for this clone
              {isolatedTenant && (
                <span className="ml-2 text-xs text-muted-foreground">
                  (required — isolated tenant)
                </span>
              )}
            </span>
          </label>
          {dedicatedBackend && (
            <div className="grid gap-4 md:grid-cols-2 rounded-md border border-border p-4">
              <div className="space-y-2">
                <Label>Admin email</Label>
                <Input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@client.com"
                />
              </div>
              <div className="space-y-2">
                <Label>Admin password</Label>
                <Input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Min 8 characters"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Region</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={backendRegion}
                  onChange={(e) => setBackendRegion(e.target.value)}
                >
                  <option value="us-east-1">US East (Virginia)</option>
                  <option value="us-west-1">US West (Oregon)</option>
                  <option value="eu-west-1">EU West (Ireland)</option>
                  <option value="eu-west-2">EU West (London)</option>
                  <option value="eu-central-1">EU Central (Frankfurt)</option>
                  <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                  <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
                  <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-info" /> 6 · Edge security (optional)
          </CardTitle>
          <CardDescription>
            Wrap the front-end with an edge/CDN provider for WAF, bot mitigation, rate limiting, and
            DDoS. Cloudflare is live today; AWS &amp; Azure are on the waitlist.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex cursor-pointer items-center gap-3">
            <Checkbox checked={cloudflare} onCheckedChange={(v) => setCloudflare(!!v)} />
            <span className="text-sm">Attach an edge provider to this clone</span>
          </label>
          {cloudflare && (
            <div className="grid gap-3 rounded-md border border-border p-4 md:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">Provider</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={edgeProvider}
                  onChange={(e) =>
                    setEdgeProvider(e.target.value as "cloudflare" | "aws" | "azure")
                  }
                >
                  <option value="cloudflare">Cloudflare</option>
                  <option value="aws">AWS CloudFront (waitlist)</option>
                  <option value="azure">Azure Front Door (waitlist)</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Hostname {edgeProvider !== "cloudflare" && "(optional)"}
                </Label>
                <Input
                  value={edgeHostname}
                  onChange={(e) => setEdgeHostname(e.target.value)}
                  placeholder="app.example.com"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Posture preset</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={edgePreset}
                  onChange={(e) => setEdgePreset(e.target.value)}
                >
                  <option value="lenient">Lenient</option>
                  <option value="balanced">Balanced</option>
                  <option value="strict">Strict</option>
                  <option value="under_attack">Under Attack</option>
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-info" /> 6b · Subdomain hosting
          </CardTitle>
          <CardDescription>
            Every clone gets an{" "}
            <code className="rounded bg-muted px-1 text-xs">&lt;slug&gt;.aurixasystems.com.au</code>{" "}
            subdomain via Cloudflare DNS. Dormant if Cloudflare isn't configured yet — the record
            fans out automatically once{" "}
            <a href="/settings/domains" className="underline">
              Settings → Domains
            </a>{" "}
            is populated.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex cursor-pointer items-center gap-3">
            <Checkbox
              checked={subdomainEnabled}
              onCheckedChange={(v) => setSubdomainEnabled(!!v)}
            />
            <span className="text-sm">Reserve a subdomain for this clone</span>
          </label>
          {subdomainEnabled && (
            <div className="grid gap-3 rounded-md border border-border p-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Subdomain (leave blank to use the clone slug)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={subdomainSlug}
                    onChange={(e) => setSubdomainSlug(e.target.value)}
                    placeholder={
                      name
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "-")
                        .replace(/^-|-$/g, "") || "my-clone"
                    }
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    .aurixasystems.com.au
                  </span>
                </div>
              </div>
              <div className="text-xs text-muted-foreground self-end">
                Reserved slugs (www, api, admin, …) are blocked. Availability is checked on submit;
                conflicts surface as an error.
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">7 · Billing &amp; tracking</CardTitle>
          <CardDescription>
            The tracking user ID ties this clone's Stripe payments, purchased products and token
            usage together. It also becomes the <span className="font-mono">?uid=</span> key the
            Aurixa Systems pricing page uses to send this client straight into checkout.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Tracking user ID</Label>
            <Input
              value={billingUserId}
              onChange={(e) => setBillingUserId(e.target.value)}
              placeholder="e.g. acme-corp or a CRM user id"
            />
            <p className="text-xs text-muted-foreground">
              Unique per clone. Leave blank to assign later.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Stripe customer ID (optional)</Label>
            <Input
              value={billingStripeCustomerId}
              onChange={(e) => setBillingStripeCustomerId(e.target.value)}
              placeholder="cus_…"
            />
            <p className="text-xs text-muted-foreground">
              Reuse an existing Stripe customer for this client, if you have one.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => nav({ to: "/dashboard" })}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={submit}>
          {busy ? "Provisioning…" : "Provision clone"}
        </Button>
      </div>
    </div>
  );
}
