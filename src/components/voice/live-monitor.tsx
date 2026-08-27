// Live calls — polls every 5s while visible; phantom rows are excluded by the
// server (30-minute hard stop) and closed by the drain.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { killCall, listLiveCalls } from "@/lib/voice.functions";
import { useConfirm } from "@/components/confirm-dialog";
import { MonoStatus } from "@/components/voice/tone";
import { PhoneIncoming, PhoneOutgoing, PhoneOff } from "lucide-react";

export function LiveMonitor() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["voice", "live"],
    queryFn: () => listLiveCalls({ data: {} }),
    refetchInterval: 5000,
  });

  const kill = useMutation({
    mutationFn: (id: string) => killCall({ data: { id } }),
    onSuccess: (r) => {
      toast.success(r.result === "terminated" ? "Call terminated" : `Kill result: ${r.result}`);
      qc.invalidateQueries({ queryKey: ["voice"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const calls = q.data ?? [];
  if (!q.isLoading && calls.length === 0) {
    return (
      <EmptyState
        icon={<PhoneIncoming className="h-6 w-6" />}
        title="No live calls"
        description="Calls appear here the moment VAPI reports them ringing."
      />
    );
  }

  return (
    <div className="space-y-2">
      {calls.map((c) => (
        <RecordRow key={c.id} spine="live" className="flex items-center gap-3 px-4 py-3">
          {c.call_direction === "outbound" ? (
            <PhoneOutgoing className="h-4 w-4 shrink-0 text-info" />
          ) : (
            <PhoneIncoming className="h-4 w-4 shrink-0 text-success" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {c.customer_name || c.phone_number || "Unknown caller"}
              {c.is_squad_call && (
                <Badge variant="secondary" className="ml-2">
                  {c.squad_name ?? "squad"}
                </Badge>
              )}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {c.agent_name ?? c.agent_id ?? "—"}
              {c.started_at &&
                ` · started ${formatDistanceToNow(new Date(c.started_at), { addSuffix: true })}`}
            </p>
          </div>
          <MonoStatus label={c.call_status ?? "live"} tone="info" pulse />
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={kill.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: "End this live call?",
                  description: "The caller is disconnected immediately.",
                  confirmText: "End call",
                })
              ) {
                kill.mutate(c.id);
              }
            }}
          >
            <PhoneOff className="mr-1 h-3 w-3" /> Kill
          </Button>
        </RecordRow>
      ))}
    </div>
  );
}
