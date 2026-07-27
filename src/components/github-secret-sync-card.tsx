// @ts-nocheck
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  syncPrimeActionsSecrets,
  syncCloneActionsSecrets,
  syncAllCloneActionsSecrets,
  listGithubSecretSyncs,
} from "@/lib/github-secrets.functions";

type Props =
  | { target: "prime" }
  | { target: "clone"; cloneId: string }
  | { target: "fleet" };

export function GitHubSecretSyncCard(props: Props) {
  const syncPrime = useServerFn(syncPrimeActionsSecrets);
  const syncClone = useServerFn(syncCloneActionsSecrets);
  const syncAll = useServerFn(syncAllCloneActionsSecrets);
  const list = useServerFn(listGithubSecretSyncs);
  const [busy, setBusy] = useState(false);

  const listInput =
    props.target === "clone"
      ? { cloneId: props.cloneId, limit: 5 }
      : props.target === "prime"
        ? { targetKind: "prime" as const, limit: 5 }
        : { limit: 10 };

  const { data, refetch } = useQuery({
    queryKey: ["github-secret-syncs", props.target, (props as any).cloneId],
    queryFn: async () => list({ data: listInput }),
  });

  const rows: any[] = data?.rows ?? [];
  const last = rows[0];

  async function run() {
    setBusy(true);
    try {
      const res =
        props.target === "prime"
          ? await syncPrime()
          : props.target === "clone"
            ? await syncClone({ data: { cloneId: props.cloneId } })
            : await syncAll();
      if (res?.ok) {
        toast.success(
          props.target === "fleet"
            ? `Synced ${res.ok}/${res.attempted} clones`
            : `Wrote ${res.written?.length ?? 0} secret(s)`,
        );
      } else {
        toast.error(res?.error ?? `Sync failed — see history`);
      }
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  const label =
    props.target === "prime"
      ? "Sync to Prime repo"
      : props.target === "clone"
        ? "Sync to this clone's repo"
        : "Sync to all clone repos";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> GitHub Actions secrets
        </CardTitle>
        <CardDescription>
          Push <code>CODEX_SECURITY_API_KEY</code>,{" "}
          <code>CODEX_REMEDIATION_WEBHOOK_SECRET</code>, and{" "}
          <code>CODEX_CALLBACK_URL</code> directly to the target repo. Uses the
          Aurixa GitHub App installation and libsodium sealed-box encryption —
          values never appear in the browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Button onClick={run} disabled={busy}>
            {busy ? "Syncing…" : label}
          </Button>
          {last && (
            <div className="text-xs text-muted-foreground">
              Last: {new Date(last.created_at).toLocaleString()}{" "}
              <Badge variant={last.ok ? "default" : "destructive"} className="ml-1">
                {last.ok ? "ok" : "failed"}
              </Badge>
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <div className="space-y-1 rounded-md border p-2 text-xs">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <div className="truncate font-mono">
                  {r.owner}/{r.repo}
                  <span className="ml-2 text-muted-foreground">
                    · {r.trigger_source}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    +{r.written?.length ?? 0} wrote
                    {r.failed?.length ? ` · ${r.failed.length} failed` : ""}
                  </span>
                  <Badge variant={r.ok ? "secondary" : "destructive"}>
                    {r.ok ? "ok" : "err"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
        {last?.failed?.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive">
            {last.failed.map((f: any) => (
              <div key={f.name}>
                {f.name}: {f.error}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
