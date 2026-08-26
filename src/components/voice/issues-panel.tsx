// Negative-call review queue: negative-sentiment and escalated calls, worked
// through the resolution workflow (needs_review → reviewed/resolved/escalated).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { listCalls } from "@/lib/voice.functions";
import { RESOLUTION_STATUSES } from "@/lib/voice-vocab";
import { MonoStatus, OutcomeStatus } from "@/components/voice/tone";
import { CheckCircle2 } from "lucide-react";

export function IssuesPanel({ onOpenCall }: { onOpenCall: (id: string) => void }) {
  const [status, setStatus] = useState<string>("needs_review");
  const q = useQuery({
    queryKey: ["voice", "issues", status],
    queryFn: () => listCalls({ data: { sentiment: "negative", limit: 100 } }),
  });

  const calls = (q.data?.calls ?? []).filter(
    (c) => status === "all" || c.resolution_status === status,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Negative-sentiment calls, worked through review.
        </p>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all statuses</SelectItem>
            {RESOLUTION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!q.isLoading && calls.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 className="h-6 w-6" />}
          title="Nothing needs review"
          description="No negative calls in this bucket."
        />
      )}

      <div className="space-y-2">
        {calls.map((c) => (
          <RecordRow
            key={c.id}
            spine={c.resolution_status === "resolved" ? "ok" : "bad"}
            className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/30"
            onClick={() => onOpenCall(c.id)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {c.customer_name || c.phone_number || "Unknown caller"}
                {c.escalation_severity != null && (
                  <Badge variant="destructive" className="ml-2">
                    sev {c.escalation_severity}
                  </Badge>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">{c.summary ?? "No summary"}</p>
            </div>
            {c.started_at && (
              <span className="hidden font-mono text-xs text-muted-foreground md:inline">
                {format(new Date(c.started_at), "MMM d, h:mm a")}
              </span>
            )}
            <OutcomeStatus outcome={c.call_outcome} />
            <MonoStatus
              label={(c.resolution_status ?? "needs_review").replace(/_/g, " ")}
              tone={
                c.resolution_status === "resolved"
                  ? "success"
                  : c.resolution_status === "escalated"
                    ? "destructive"
                    : "warning"
              }
            />
          </RecordRow>
        ))}
      </div>
    </div>
  );
}
