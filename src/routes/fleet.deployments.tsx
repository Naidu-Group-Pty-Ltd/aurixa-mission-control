// Where every clone is served from, and whether what is serving is what we
// last pushed.
//
// Two facts per clone and they are separate on purpose: `status` is the
// deployment lifecycle, `last_build_state` is the health of the most recent
// production build. A clone can be LIVE with a FAILED build — up, serving the
// previous artefact, and not running the code somebody merged an hour ago.
// Collapsing those into one badge is how that goes unnoticed for a week.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { MetricBar, type Metric } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, ExternalLink, RefreshCw, Rocket, Search } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "@/lib/format";
import {
  enrolFleetInDeployments,
  listFleetDeployments,
  reconcilePendingDeployments,
} from "@/server/deployment-provisioning.functions";

type Row = Awaited<ReturnType<typeof listFleetDeployments>>["rows"][number];

/** The lifecycle reading decides the spine; the build decides whether it is qualified. */
const SPINE: Record<string, SpineTone> = {
  live: "ok",
  broken: "bad",
  working: "live",
  waiting: "warn",
  absent: "idle",
};

function Deployments() {
  const list = useServerFn(listFleetDeployments);
  const enrol = useServerFn(enrolFleetInDeployments);
  const reconcile = useServerFn(reconcilePendingDeployments);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isPending, refetch } = useQuery({
    queryKey: ["fleet-deployments"],
    queryFn: () => list(),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const all = (data?.rows ?? []) as Row[];
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter((r) =>
      [r.clones?.name, r.clones?.slug, r.domain, r.provider_origin]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [data, q]);

  const metrics = useMemo<Metric[]>(() => {
    const all = (data?.rows ?? []) as Row[];
    const by = (reading: string) => all.filter((r) => r.reading?.reading === reading).length;
    // Counted independently of the lifecycle: this is the number the page exists
    // for, and it is invisible everywhere else in the product.
    const staleBuilds = all.filter(
      (r) => r.status === "live" && r.last_build_state === "error",
    ).length;
    return [
      { label: "clones", value: all.length },
      { label: "live", value: by("live") },
      { label: "in flight", value: by("working"), tone: "primary", alarm: by("working") > 0 },
      { label: "waiting", value: by("waiting"), tone: "warning", alarm: by("waiting") > 0 },
      { label: "failed", value: by("broken"), tone: "destructive", alarm: by("broken") > 0 },
      {
        label: "stale build",
        value: staleBuilds,
        tone: "warning",
        alarm: staleBuilds > 0,
        note: staleBuilds ? "serving old code" : undefined,
      },
    ];
  }, [data]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      const result = (await fn()) as Record<string, unknown>;
      toast.success(ok, { description: JSON.stringify(result) });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet-wide"
        title="Deployments"
        description={
          data
            ? `Every clone is staged on ${data.providerSlug}. ${
                data.providerConfigured
                  ? "The provider token is configured."
                  : "No provider token is configured — nothing has been attempted."
              }`
            : "Where every clone is served from."
        }
        actions={
          <>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                act("dry", () => enrol({ data: { dryRun: true } }), "Dry run complete")
              }
            >
              <Search className="mr-2 h-4 w-4" /> Preview enrolment
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => act("reconcile", () => reconcile(), "Dormant rows re-queued")}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Reconcile dormant
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() =>
                act("enrol", () => enrol({ data: { dryRun: false } }), "Fleet enrolled")
              }
            >
              <Rocket className="mr-2 h-4 w-4" /> Enrol fleet
            </Button>
          </>
        }
      />

      <MetricBar metrics={metrics} />

      <div className="relative max-w-sm">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="search by name or domain…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-9 font-mono text-sm"
        />
      </div>

      {/* The enrolment button writes to every clone in the fleet, so the preview
          is the default and this says what the difference is. */}
      <Card>
        <CardHeader>
          <CardTitle>What enrolment does</CardTitle>
          <CardDescription>
            Creates a deployment row for each clone that has none, and reserves its subdomain
            through the same allocator provisioning uses. It never touches a clone that already has
            a row — a declined or detached deployment is a decision, not a gap.
          </CardDescription>
        </CardHeader>
      </Card>

      {isPending ? (
        <p className="label-mono">loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Rocket />}
          title={q ? "No deployments match" : "No clone has a deployment yet"}
          description={
            q
              ? "Try clearing the search."
              : "Enrol the fleet to give every clone a deployment row and a name in the Aurixa zone."
          }
        />
      ) : (
        <section className="space-y-2">
          {rows.map((row) => {
            const staleBuild = row.status === "live" && row.last_build_state === "error";
            return (
              <RecordRow
                key={row.clone_id}
                spine={staleBuild ? "warn" : (SPINE[row.reading?.reading ?? "absent"] ?? "idle")}
                className="p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link
                      to="/clones/$cloneId"
                      params={{ cloneId: row.clone_id }}
                      className="font-display block truncate text-[1.0625rem] leading-tight hover:text-primary"
                    >
                      {row.clones?.name ?? row.clone_id}
                    </Link>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {row.domain ?? row.expectedFqdn ?? "no domain"}
                      {row.provider_origin
                        ? ` · ${row.provider_origin.replace(/^https?:\/\//, "")}`
                        : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-[10px] tracking-[0.18em] uppercase">
                      {row.reading?.label ?? row.status}
                    </div>
                    {row.last_deployed_at && (
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                        built {formatDistanceToNow(row.last_deployed_at)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Said in words, not as a colour: "live" and "the last build
                    failed" are both true at once and the second one is the one
                    nothing else in the product will tell you. */}
                {staleBuild && (
                  <p className="mt-3 flex items-start gap-2 font-mono text-[10px] tracking-[0.14em] text-warning uppercase">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    serving the previous build — the latest push did not ship
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                  <span>{row.provider_slug}</span>
                  {row.status_detail && (
                    <>
                      <span aria-hidden className="text-border-strong">
                        ·
                      </span>
                      <span className="tracking-normal normal-case">{row.status_detail}</span>
                    </>
                  )}
                  {row.domain && (
                    <a
                      href={`https://${row.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1.5 hover:text-primary"
                    >
                      <ExternalLink className="h-3 w-3" /> open
                    </a>
                  )}
                </div>
              </RecordRow>
            );
          })}
        </section>
      )}
    </div>
  );
}

export const Route = createFileRoute("/fleet/deployments")({
  component: () => (
    <ProtectedRoute requireRole="admin">
      <Deployments />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Deployments — Aurixa Systems Mission Control" }] }),
});
