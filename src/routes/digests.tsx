import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPager } from "@/components/list-pager";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecordRow } from "@/components/record-row";
import { Newspaper, Sparkles, RefreshCw } from "lucide-react";
import { aiGenerateFleetDigest, listFleetDigests } from "@/server/ai-features.functions";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/digests")({
  component: () => (
    <ProtectedRoute>
      <DigestsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Fleet Digests — Aurixa Systems Mission Control" }] }),
});

function DigestsPage() {
  const listFn = useServerFn(listFleetDigests);
  const genFn = useServerFn(aiGenerateFleetDigest);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["digests"], queryFn: () => listFn() });
  const [page, setPage] = useState(0);
  const digests = q.data?.digests ?? [];
  const PAGE_SIZE = 8;
  const pageCount = Math.max(1, Math.ceil(digests.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageDigests = digests.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);
  const gen = useMutation({
    mutationFn: () => genFn(),
    onSuccess: () => {
      toast.success("Digest generated");
      qc.invalidateQueries({ queryKey: ["digests"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center bg-accent/15 ring-1 ring-accent/40">
          <Newspaper className="h-5 w-5 text-accent" />
        </div>
        <div className="flex-1">
          <p className="label-mono">ai briefings</p>
          <h1 className="font-display text-[2.125rem] leading-[1.05]">Fleet Digests</h1>
          <p className="text-sm text-muted-foreground">
            AI-summarized weekly fleet operations briefings.
          </p>
        </div>
        <Button onClick={() => gen.mutate()} disabled={gen.isPending}>
          {gen.isPending ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          Generate now
        </Button>
      </header>

      {digests.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No digests yet. Click <strong>Generate now</strong> to produce the first one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {pageDigests.map((d) => (
            <RecordRow key={d.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {format(new Date(d.period_start), "MMM d")} –{" "}
                      {format(new Date(d.period_end), "MMM d, yyyy")}
                    </CardTitle>
                    <CardDescription>
                      Generated {format(new Date(d.created_at), "PPp")}
                    </CardDescription>
                  </div>
                  <Badge variant="outline">{d.generated_by_model}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {d.summary_markdown}
                </pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(d.metrics as Record<string, any>).map(([k, v]) => (
                    <Badge key={k} variant="outline" className="font-mono text-[10px]">
                      {k}: {String(v)}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </RecordRow>
          ))}
          <ListPager page={clampedPage} pageCount={pageCount} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
