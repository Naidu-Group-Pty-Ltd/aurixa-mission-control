import { createFileRoute, Link } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { useEffect, useState, useCallback } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CalendarClock, Play, Trash2, Plus, Power, PowerOff } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  createSchedule,
  deleteSchedule,
  runScheduleNow,
  updateSchedule,
} from "@/server/schedules.functions";
import { bulkDeleteSchedules, bulkUpdateSchedules } from "@/server/bulk-ops.functions";
import { describeCron } from "@/lib/cron";
import { formatDistanceToNow } from "@/lib/format";
import { ScheduleRecentFires } from "@/components/schedule-recent-fires";
import { RecordRow } from "@/components/record-row";

export const Route = createFileRoute("/schedules")({
  component: () => (
    <ProtectedRoute>
      <SchedulesPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Schedules — Aurixa Systems Mission Control" }] }),
});

type Sched = {
  id: string;
  name: string;
  kind: "fleet_cascade" | "module_sync";
  cron_expression: string;
  mode: "pr" | "auto_merge" | "notify";
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  notes: string | null;
  scope_filter: Record<string, unknown>;
};

function SchedulesPage() {
  const confirm = useConfirm();
  const [list, setList] = useState<Sched[]>([]);
  const [loading, setLoading] = useState(true);
  const create = useServerFn(createSchedule);
  const update = useServerFn(updateSchedule);
  const del = useServerFn(deleteSchedule);
  const runNow = useServerFn(runScheduleNow);
  const bulkToggleFn = useServerFn(bulkUpdateSchedules);
  const bulkDeleteFn = useServerFn(bulkDeleteSchedules);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await (supabase as any)
      .from("cascade_schedules")
      .select("*")
      .order("created_at", { ascending: false });
    setList((data ?? []) as Sched[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [kind, setKind] = useState<"fleet_cascade" | "module_sync">("fleet_cascade");
  const [mode, setMode] = useState<"pr" | "auto_merge" | "notify">("pr");
  const [busy, setBusy] = useState(false);

  const onCreate = async () => {
    if (!name) return toast.error("Name required");
    setBusy(true);
    try {
      const res = await create({ data: { name, kind, cron_expression: cron, mode } });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Schedule created");
        setName("");
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="label-mono">recurring jobs</p>
        <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Schedules</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cron-driven cascades and module syncs. Times in UTC.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New schedule</CardTitle>
          <CardDescription>
            5-field cron, e.g. <code className="font-mono">0 9 * * 1</code> = Mondays 09:00 UTC.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-5">
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input
              placeholder="0 * * * *"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="font-mono"
            />
            <Select value={kind} onValueChange={(v) => setKind(v as any)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fleet_cascade">Fleet cascade</SelectItem>
                <SelectItem value="module_sync">Module sync</SelectItem>
              </SelectContent>
            </Select>
            <Select value={mode} onValueChange={(v) => setMode(v as any)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pr">PR</SelectItem>
                <SelectItem value="auto_merge">Auto-merge</SelectItem>
                <SelectItem value="notify">Notify</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={onCreate} disabled={busy}>
              <Plus className="mr-1 h-4 w-4" /> Create
            </Button>
          </div>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            preview · {describeCron(cron)}
          </p>
        </CardContent>
      </Card>

      <BulkActionBar count={selected.size} noun="schedule" onClear={() => setSelected(new Set())}>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const r = await bulkToggleFn({ data: { ids: Array.from(selected), enabled: true } });
            if (r.ok) {
              toast.success(`Enabled ${r.count}`);
              setSelected(new Set());
              refresh();
            } else toast.error(r.error);
          }}
        >
          <Power className="mr-1 h-3.5 w-3.5" /> Enable
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const r = await bulkToggleFn({ data: { ids: Array.from(selected), enabled: false } });
            if (r.ok) {
              toast.success(`Disabled ${r.count}`);
              setSelected(new Set());
              refresh();
            } else toast.error(r.error);
          }}
        >
          <PowerOff className="mr-1 h-3.5 w-3.5" /> Disable
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={async () => {
            if (
              !(await confirm({
                title: `Delete ${selected.size} schedule(s)?`,
                confirmText: "Delete",
                destructive: true,
              }))
            )
              return;
            const r = await bulkDeleteFn({ data: { ids: Array.from(selected) } });
            if (r.ok) {
              toast.success(`Deleted ${r.count}`);
              setSelected(new Set());
              refresh();
            } else toast.error(r.error);
          }}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
        </Button>
      </BulkActionBar>

      <section className="space-y-2">
        {loading ? (
          <div className="font-mono text-sm text-muted-foreground">loading…</div>
        ) : list.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              <CalendarClock className="mx-auto mb-2 h-8 w-8 opacity-50" />
              No schedules yet.
            </CardContent>
          </Card>
        ) : (
          list.map((s) => (
            <RecordRow key={s.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Checkbox
                      checked={selected.has(s.id)}
                      onCheckedChange={() => toggleSel(s.id)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{s.name}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {s.kind.replace("_", " ")}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {s.mode.replace("_", " ")}
                        </Badge>
                        <code className="bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {s.cron_expression}
                        </code>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {describeCron(s.cron_expression)}
                        {s.last_run_at && <> · last {formatDistanceToNow(s.last_run_at)}</>}
                        {s.next_run_at && <> · next {formatDistanceToNow(s.next_run_at)}</>}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={async (v) => {
                        const res = await update({ data: { id: s.id, patch: { enabled: v } } });
                        if (!res.ok) toast.error(res.error);
                        refresh();
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const out = await runNow({ data: { id: s.id } });
                        if (!out.ok) toast.error(out.error ?? "Run failed");
                        else if (out.cascade_event_id) {
                          toast.success("Schedule executed", {
                            action: {
                              label: "View",
                              onClick: () => {
                                window.location.href = `/cascades/${out.cascade_event_id}`;
                              },
                            },
                          });
                        } else toast.success("Schedule executed");
                        refresh();
                      }}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" /> Run now
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: "Delete this schedule?",
                            confirmText: "Delete",
                            destructive: true,
                          }))
                        )
                          return;
                        const res = await del({ data: { id: s.id } });
                        if (!res.ok) toast.error(res.error);
                        else {
                          toast.success("Deleted");
                          refresh();
                        }
                      }}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="border-t pt-3">
                  <ScheduleRecentFires scheduleId={s.id} />
                </div>
              </CardContent>
            </RecordRow>
          ))
        )}
      </section>

      <p className="font-mono text-[11px] text-muted-foreground">
        Tip: Schedules tick every minute via the{" "}
        <Link to="/audit-log" className="underline">
          /hooks/run-schedules
        </Link>{" "}
        cron job.
      </p>
    </div>
  );
}
