import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Github,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  Shield,
  Key,
  Plug,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { validateGitHubSecrets, type ValidationResult } from "@/server/github-validate.functions";
import { getGitHubStatus, type GitHubStatus } from "@/server/github-status.functions";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";

type WizardStep = "validate" | "connect" | "verify";

export function GitHubSetupWizard() {
  const { session } = useAuth();
  const validateFn = useServerFn(validateGitHubSecrets);
  const statusFn = useServerFn(getGitHubStatus);

  const [step, setStep] = useState<WizardStep>("validate");
  const [loading, setLoading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runValidation = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await validateFn();
      setValidation(res);

      // Audit log
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await supabase.from("audit_log").insert({
        action: "github.secrets_validated",
        entity_type: "settings",
        actor_user_id: user?.id,
        metadata: {
          all_valid: res.allValid,
          results: res.secrets.map((s) => ({ name: s.name, valid: s.valid })),
        },
      });

      if (res.allValid) {
        setStep("connect");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setLoading(false);
    }
  };

  const runConnection = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await statusFn();
      setGhStatus(res);

      // Audit log
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await supabase.from("audit_log").insert({
        action: "github.wizard_connection_tested",
        entity_type: "settings",
        actor_user_id: user?.id,
        metadata: { configured: res.configured, ok: res.ok, app: res.app?.name },
      });

      if (res.ok && res.configured) {
        setStep("verify");
      }
    } catch (e) {
      let message = "Connection test failed";
      if (e instanceof Response) {
        try {
          message = (await e.text()) || `HTTP ${e.status}`;
        } catch {
          message = `HTTP ${e.status}`;
        }
      } else if (e instanceof Error) {
        message = e.message;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const steps: { key: WizardStep; label: string; icon: typeof Key }[] = [
    { key: "validate", label: "Validate secrets", icon: Key },
    { key: "connect", label: "Test connection", icon: Plug },
    { key: "verify", label: "Verify repos", icon: Shield },
  ];

  const stepIndex = steps.findIndex((s) => s.key === step);

  if (!session) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Github className="h-4 w-4" /> GitHub App setup wizard
        </CardTitle>
        <CardDescription>
          Step-by-step verification of your GitHub App secrets, installation, and repo access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Stepper */}
        <div className="flex items-center gap-1">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const isActive = i === stepIndex;
            const isDone = i < stepIndex;
            return (
              <div key={s.key} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40" />}
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                    isActive && "bg-primary/10 text-primary",
                    isDone && "text-success",
                    !isActive && !isDone && "text-muted-foreground/60",
                  )}
                >
                  {isDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        {step === "validate" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              We'll check that your GitHub App secrets are set and have the correct format before
              attempting a connection.
            </p>
            {validation && (
              <div className="space-y-2">
                {validation.secrets.map((s) => (
                  <div
                    key={s.name}
                    className={cn(
                      "flex items-start gap-3 rounded-md border p-3",
                      s.valid
                        ? "border-success/30 bg-success/5"
                        : "border-destructive/30 bg-destructive/5",
                    )}
                  >
                    {s.valid ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    )}
                    <div className="space-y-0.5">
                      <div className="font-mono text-xs font-medium">{s.name}</div>
                      {s.name === "GITHUB_APP_ID" && (
                        <div className="text-[11px] italic text-muted-foreground/70">
                          Your App's numeric ID — found in{" "}
                          <strong>GitHub App → General → App ID</strong> (e.g. 123456).
                        </div>
                      )}
                      {s.name === "GITHUB_APP_INSTALLATION_ID" && (
                        <div className="text-[11px] italic text-muted-foreground/70">
                          The number at the end of the URL when you click <em>Configure</em> on the
                          installed app (
                          <code className="bg-muted px-0.5">
                            …/installations/<strong>{"<ID>"}</strong>
                          </code>
                          ).
                        </div>
                      )}
                      {s.hint && <div className="text-xs text-muted-foreground">{s.hint}</div>}
                      {s.valid && <div className="text-xs text-success">Format valid ✓</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={runValidation} disabled={loading}>
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Key className="mr-2 h-4 w-4" />
                )}
                {validation ? "Re-validate" : "Validate secrets"}
              </Button>
              {validation?.allValid && (
                <Button variant="outline" onClick={() => setStep("connect")}>
                  Next <ArrowRight className="ml-2 h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        )}

        {step === "connect" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Secrets look good! Now we'll authenticate as your GitHub App and fetch installation
              details.
            </p>
            {ghStatus && !ghStatus.configured && (
              <div className="flex items-start gap-3 border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <div className="font-medium text-destructive">Connection failed</div>
                  <div className="text-muted-foreground">{ghStatus.error}</div>
                </div>
              </div>
            )}
            {ghStatus?.configured && ghStatus.app && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Tile
                    label="App"
                    value={ghStatus.app.name}
                    sub={`ID ${ghStatus.app.app_id}`}
                    ok
                  />
                  <Tile
                    label="Installation"
                    value={ghStatus.installation?.account ?? "Unknown"}
                    sub={`${ghStatus.installation?.visible_repo_count ?? 0} repos accessible`}
                    ok
                  />
                </div>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={runConnection} disabled={loading}>
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="mr-2 h-4 w-4" />
                )}
                Test connection
              </Button>
              {ghStatus?.configured && (
                <Button variant="outline" onClick={() => setStep("verify")}>
                  Next <ArrowRight className="ml-2 h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStep("validate");
                  setGhStatus(null);
                }}
              >
                Back
              </Button>
            </div>
          </div>
        )}

        {step === "verify" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connection successful! Here's the reachability status for your prime and clone repos.
            </p>
            {ghStatus && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Tile
                    label="App"
                    value={ghStatus.app?.name ?? "—"}
                    sub={ghStatus.app ? `ID ${ghStatus.app.app_id}` : undefined}
                    ok
                  />
                  <Tile
                    label="Repos reachable"
                    value={`${ghStatus.repos.filter((r) => r.ok).length}/${ghStatus.repos.length}`}
                    sub={
                      ghStatus.repos.length === 0
                        ? "No prime/clones configured"
                        : ghStatus.repos.every((r) => r.ok)
                          ? "All repos accessible"
                          : "Some repos unreachable"
                    }
                    ok={ghStatus.repos.length === 0 || ghStatus.repos.every((r) => r.ok)}
                  />
                </div>
                {ghStatus.repos.length > 0 && (
                  <ul className="space-y-1.5">
                    {ghStatus.repos.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-3 border border-border bg-surface px-3 py-2 text-sm"
                      >
                        {r.ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        )}
                        <div className="flex-1 truncate">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs">
                              {r.owner}/{r.repo}
                            </span>
                            <Badge variant="outline" className="text-[9px] uppercase">
                              {r.role}
                            </Badge>
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {r.branch}
                            {r.ok && r.default_branch_sha && <> · {r.default_branch_sha}</>}
                            {!r.ok && r.error && <> · {r.error}</>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setStep("connect");
                  runConnection();
                }}
                disabled={loading}
              >
                <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} />
                Re-check
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStep("connect")}>
                Back
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  label,
  value,
  sub,
  ok,
}: {
  label: string;
  value: string;
  sub?: string;
  ok?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        ok ? "border-success/20 bg-success/5" : "border-border bg-surface",
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm font-medium">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
