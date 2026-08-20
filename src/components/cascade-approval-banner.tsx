import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck, Loader2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approveCascade, rejectCascade } from "@/server/cascade-approvals.functions";
import { formatDistanceToNow } from "@/lib/format";

type ApprovalRow = {
  id: string;
  approver_user_id: string;
  decision: "approved" | "rejected";
  reason: string | null;
  created_at: string;
};

export function CascadeApprovalBanner({
  cascadeEventId,
  initiatedBy,
  requiresApproval,
  approvedAt,
  approvedBy,
  reasonHint,
  onChange,
}: {
  cascadeEventId: string;
  initiatedBy: string | null;
  requiresApproval: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  reasonHint?: string | null;
  onChange: () => void;
}) {
  const approveFn = useServerFn(approveCascade);
  const rejectFn = useServerFn(rejectCascade);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [me, setMe] = useState<string | null>(null);
  const [history, setHistory] = useState<ApprovalRow[]>([]);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, []);

  // Reload approval history whenever the parent re-fetches the event OR a
  // realtime change touches cascade_approvals for this event (so a co-worker's
  // approve/reject updates the banner without refresh).
  useEffect(() => {
    let cancel = false;
    const load = () => {
      void supabase
        .from("cascade_approvals")
        .select("id, approver_user_id, decision, reason, created_at")
        .eq("cascade_event_id", cascadeEventId)
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          if (cancel) return;
          setHistory((data as ApprovalRow[] | null) ?? []);
        });
    };
    load();
    const channel = supabase
      .channel(`cascade-approvals-${cascadeEventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "cascade_approvals",
          filter: `cascade_event_id=eq.${cascadeEventId}`,
        },
        () => {
          load();
          onChange();
        },
      )
      .subscribe();
    return () => {
      cancel = true;
      void supabase.removeChannel(channel);
    };
  }, [cascadeEventId, approvedAt, onChange]);

  if (!requiresApproval) return null;

  const isInitiator = me && initiatedBy && me === initiatedBy;
  const isApproved = !!approvedAt;

  const approve = async () => {
    setBusy("approve");
    try {
      const res = await approveFn({ data: { cascadeEventId, reason: reason.trim() || undefined } });
      if (!res.ok) toast.error(res.error);
      else toast.success("Cascade approved — engine running");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(null);
      onChange();
    }
  };

  const reject = async () => {
    setBusy("reject");
    try {
      const res = await rejectFn({ data: { cascadeEventId, reason: reason.trim() || undefined } });
      if (!res.ok) toast.error(res.error);
      else toast.success("Cascade rejected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rejection failed");
    } finally {
      setBusy(null);
      onChange();
    }
  };

  return (
    <Card
      className={isApproved ? "border-success/40 bg-success/5" : "border-warning/40 bg-warning/5"}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {isApproved ? (
            <ShieldCheck className="h-4 w-4 text-success" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-warning" />
          )}
          {isApproved ? "Approved" : "Approval required"}
        </CardTitle>
        <CardDescription>
          {isApproved
            ? `Approved ${formatDistanceToNow(approvedAt)}${approvedBy ? ` by operator ${approvedBy.slice(0, 8)}` : ""}.`
            : (reasonHint ?? "This cascade exceeds the safety threshold.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isApproved && !isInitiator && me && (
          <>
            <Textarea
              placeholder="Optional note for the audit log…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={approve} disabled={busy !== null} size="sm">
                {busy === "approve" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                )}
                Approve & run
              </Button>
              <Button
                onClick={reject}
                disabled={busy !== null}
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                {busy === "reject" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="mr-1.5 h-3.5 w-3.5" />
                )}
                Reject
              </Button>
            </div>
          </>
        )}
        {!isApproved && isInitiator && (
          <p className="border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            You initiated this cascade — a different operator must approve before it can run.
          </p>
        )}
        {history.length > 0 && (
          <div className="space-y-1 border-t border-border/40 pt-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              History
            </div>
            {history.map((h) => (
              <div key={h.id} className="font-mono text-[11px] text-muted-foreground">
                · {h.decision} by {h.approver_user_id.slice(0, 8)} ·{" "}
                {formatDistanceToNow(h.created_at)}
                {h.reason ? ` — ${h.reason}` : ""}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
