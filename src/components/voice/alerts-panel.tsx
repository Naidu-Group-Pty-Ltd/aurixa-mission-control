// Call alert rules and their recent hits. A rule matches end-of-call facts
// (outcome, sentiment, duration, cost, escalation) in the drain and raises an
// operator notification.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm-dialog";
import { deleteAlertRule, listAlertRules, upsertAlertRule } from "@/lib/voice.functions";
import { MonoStatus } from "@/components/voice/tone";
import { BellRing, Trash2 } from "lucide-react";

const CONDITION_TYPES = [
  { value: "outcome", label: "outcome equals", hint: "e.g. voicemail" },
  { value: "sentiment", label: "sentiment equals", hint: "e.g. negative" },
  { value: "intent", label: "intent equals", hint: "e.g. finance_consult" },
  { value: "duration_gt", label: "duration over (s)", hint: "e.g. 900" },
  { value: "duration_lt", label: "duration under (s)", hint: "e.g. 20" },
  { value: "cost_gt", label: "cost over ($)", hint: "e.g. 0.50" },
  { value: "escalation_gte", label: "escalation at least", hint: "1–5" },
] as const;

export function AlertsPanel() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["voice", "alerts"],
    queryFn: () => listAlertRules({ data: {} }),
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [conditionType, setConditionType] =
    useState<(typeof CONDITION_TYPES)[number]["value"]>("sentiment");
  const [conditionValue, setConditionValue] = useState("");
  const [isPositive, setIsPositive] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      upsertAlertRule({
        data: { name, conditionType, conditionValue, isPositive },
      }),
    onSuccess: () => {
      toast.success("Alert rule saved");
      setOpen(false);
      setName("");
      setConditionValue("");
      qc.invalidateQueries({ queryKey: ["voice", "alerts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (rule: {
      id: string;
      name: string;
      condition_type: string;
      condition_value: string;
      is_positive: boolean;
      is_enabled: boolean;
      notify_operators: boolean;
    }) =>
      upsertAlertRule({
        data: {
          id: rule.id,
          name: rule.name,
          conditionType: rule.condition_type as (typeof CONDITION_TYPES)[number]["value"],
          conditionValue: rule.condition_value,
          isPositive: rule.is_positive,
          isEnabled: !rule.is_enabled,
          notifyOperators: rule.notify_operators,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voice", "alerts"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAlertRule({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voice", "alerts"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const rules = q.data?.rules ?? [];
  const history = q.data?.history ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Rules run on every completed call; hits notify operators.
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <BellRing className="mr-2 h-4 w-4" /> New rule
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New alert rule</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                placeholder="Rule name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex gap-2">
                <Select value={conditionType} onValueChange={(v) => setConditionType(v as never)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONDITION_TYPES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="flex-1"
                  placeholder={CONDITION_TYPES.find((c) => c.value === conditionType)?.hint}
                  value={conditionValue}
                  onChange={(e) => setConditionValue(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={isPositive} onCheckedChange={setIsPositive} /> Positive signal
                (celebrate rather than warn)
              </label>
              <Button
                className="w-full"
                disabled={!name.trim() || !conditionValue.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                Save rule
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {!q.isLoading && rules.length === 0 && (
        <EmptyState
          icon={<BellRing className="h-6 w-6" />}
          title="No alert rules"
          description="Create a rule to be told about the calls that matter."
        />
      )}

      <div className="space-y-2">
        {rules.map((rule) => (
          <RecordRow
            key={rule.id}
            spine={rule.is_enabled ? (rule.is_positive ? "ok" : "warn") : "idle"}
            className="flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{rule.name}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {rule.condition_type} = {rule.condition_value}
              </p>
            </div>
            <Switch checked={rule.is_enabled} onCheckedChange={() => toggle.mutate(rule)} />
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (
                  await confirm({ title: `Delete rule "${rule.name}"?`, confirmText: "Delete" })
                ) {
                  remove.mutate(rule.id);
                }
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </RecordRow>
        ))}
      </div>

      {history.length > 0 && (
        <div className="rule-top pt-4">
          <p className="label-mono mb-2 text-muted-foreground">recent hits</p>
          <div className="space-y-1">
            {history.slice(0, 20).map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{h.message}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <MonoStatus
                    label={h.is_positive ? "positive" : "alert"}
                    tone={h.is_positive ? "success" : "warning"}
                  />
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(h.triggered_at), { addSuffix: true })}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
