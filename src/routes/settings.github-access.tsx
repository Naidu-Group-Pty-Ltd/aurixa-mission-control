import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Github } from "lucide-react";
import { auditFleetGithubAccess } from "@/lib/clone-github-access.functions";

export const Route = createFileRoute("/settings/github-access")({
  // Nested under the /settings layout, which already gates auth — wrapping in
  // ProtectedRoute again re-ran the role check and flashed inside the tabs.
  component: () => <Page />,
  head: () => ({ meta: [{ title: "GitHub App Access — Aurixa Systems" }] }),
});

function Page() {
  const audit = useMutation({
    mutationFn: () => auditFleetGithubAccess(),
    onSuccess: (r) => {
      toast.success(`Checked ${r.checked} clone(s) · ${r.ok} ok · ${r.failing.length} failing`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Audit failed"),
  });
  const r = audit.data;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Github className="h-5 w-5" /> GitHub App access
        </h1>
        <p className="text-sm text-muted-foreground">
          Verify the Aurixa GitHub App still has write access to every clone repository. Run before
          a cascade or handoff cutover.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fleet audit</CardTitle>
          <CardDescription>
            Iterates every non-archived clone and pings the installation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => audit.mutate()} disabled={audit.isPending}>
            {audit.isPending ? "Running…" : "Run fleet audit"}
          </Button>
          {r && (
            <div className="space-y-2 text-sm">
              <div>
                Checked <Badge variant="outline">{r.checked}</Badge> · ok{" "}
                <Badge variant="outline">{r.ok}</Badge> · failing{" "}
                <Badge variant={r.failing.length ? "destructive" : "outline"}>
                  {r.failing.length}
                </Badge>
              </div>
              {r.failing.length > 0 && (
                <ul className="text-xs space-y-1 rounded border p-2 max-h-96 overflow-auto">
                  {r.failing.map((f: any) => (
                    <li key={f.clone_id} className="border-b py-1">
                      <div className="flex justify-between">
                        <span className="font-mono">
                          {f.github_owner}/{f.github_repo}
                        </span>
                        <Badge variant="destructive">blocked</Badge>
                      </div>
                      {f.message && <div className="text-muted-foreground">{f.message}</div>}
                      {f.hint && <div className="text-muted-foreground">Hint: {f.hint}</div>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="text-xs text-muted-foreground">
                Generated {new Date(r.generated_at).toLocaleString()}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
