// Voice Agents — the fleet registry (inbound squad, outbound agents, phone
// numbers) and the campaign rules that decide when the tracker dials.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getFleet, upsertAgent } from "@/lib/voice.functions";
import { listCampaignRules, updateCampaignRule } from "@/lib/voice-outbound.functions";
import { MonoStatus } from "@/components/voice/tone";
import { Bot, PhoneCall, Users } from "lucide-react";

export const Route = createFileRoute("/voice/agents")({
  component: () => (
    <ProtectedRoute>
      <VoiceAgentsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Voice Agents — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "The VAPI fleet: the inbound reception squad, outbound follow-up agents, phone numbers and the campaign rules that trigger dials.",
      },
      { property: "og:title", content: "Voice Agents — Aurixa Mission Control" },
      { property: "og:description", content: "Inbound squad, outbound agents, cadences." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function secondsLabel(s: number): string {
  if (Math.abs(s) >= 3600 && Math.abs(s) % 3600 === 0) return `${s / 3600}h`;
  if (Math.abs(s) >= 60 && Math.abs(s) % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

function VoiceAgentsPage() {
  const qc = useQueryClient();
  const fleetQ = useQuery({ queryKey: ["voice", "fleet"], queryFn: () => getFleet({ data: {} }) });
  const rulesQ = useQuery({
    queryKey: ["voice", "campaign-rules"],
    queryFn: () => listCampaignRules({ data: {} }),
  });

  const agents = fleetQ.data?.agents ?? [];
  const squads = fleetQ.data?.squads ?? [];
  const phones = fleetQ.data?.phones ?? [];
  const rules = rulesQ.data ?? [];

  const toggleAgent = useMutation({
    mutationFn: (agent: (typeof agents)[number]) =>
      upsertAgent({
        data: {
          id: agent.id,
          vapiAssistantId: agent.vapi_assistant_id,
          name: agent.name,
          role: agent.role,
          direction: agent.direction as "inbound" | "outbound" | "both",
          squadId: agent.squad_id,
          isActive: !agent.is_active,
          description: agent.description,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["voice", "fleet"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const patchRule = useMutation({
    mutationFn: (input: {
      id: string;
      isEnabled?: boolean;
      vapiAssistantId?: string | null;
      vapiPhoneNumberId?: string | null;
      delaySeconds?: number;
      maxAttempts?: number;
    }) => updateCampaignRule({ data: input }),
    onSuccess: () => {
      toast.success("Rule updated");
      qc.invalidateQueries({ queryKey: ["voice", "campaign-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const inbound = agents.filter((a) => a.direction === "inbound");
  const outbound = agents.filter((a) => a.direction !== "inbound");

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="voice operations"
        title="Voice Agents"
        description="The inbound reception squad, the outbound calling agents, their phone numbers, and the rules that decide when a client-journey event becomes a dial."
      />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <MetricCell label="agents" value={agents.length} />
        <MetricCell label="squads" value={squads.length} />
        <MetricCell label="phone lines" value={phones.length} />
        <MetricCell label="active cadences" value={rules.filter((r) => r.is_enabled).length} />
      </div>

      <Tabs defaultValue="squad">
        <TabsList>
          <TabsTrigger value="squad">Inbound Squad</TabsTrigger>
          <TabsTrigger value="outbound">Outbound Agents</TabsTrigger>
          <TabsTrigger value="numbers">Phone Numbers</TabsTrigger>
          <TabsTrigger value="rules">Campaign Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="squad" className="space-y-4">
          {squads.map((squad) => (
            <div key={squad.id} className="glass p-5">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <p className="font-display text-lg">{squad.name}</p>
                <MonoStatus
                  label={squad.is_active ? "active" : "inactive"}
                  tone={squad.is_active ? "success" : "neutral"}
                />
              </div>
              {squad.description && (
                <p className="mt-1 text-sm text-muted-foreground">{squad.description}</p>
              )}
              <div className="mt-3 space-y-2">
                {inbound
                  .filter((a) => a.squad_id === squad.id)
                  .sort((a, b) => (a.squad_position ?? 99) - (b.squad_position ?? 99))
                  .map((a) => (
                    <AgentRow key={a.id} agent={a} onToggle={() => toggleAgent.mutate(a)} />
                  ))}
              </div>
            </div>
          ))}
          <div className="glass p-5">
            <p className="label-mono text-muted-foreground">handoff specialists</p>
            <div className="mt-3 space-y-2">
              {inbound
                .filter((a) => !a.squad_id)
                .map((a) => (
                  <AgentRow key={a.id} agent={a} onToggle={() => toggleAgent.mutate(a)} />
                ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="outbound" className="space-y-2">
          {outbound.map((a) => (
            <AgentRow key={a.id} agent={a} onToggle={() => toggleAgent.mutate(a)} />
          ))}
        </TabsContent>

        <TabsContent value="numbers" className="space-y-2">
          {phones.map((p) => (
            <RecordRow
              key={p.id}
              spine={p.is_active ? "ok" : "idle"}
              className="flex items-center gap-3 px-4 py-3"
            >
              <PhoneCall className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm">{p.phone_number ?? p.sip_uri ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {p.label}
                  {p.provider && ` · ${p.provider}`}
                  {p.routes_to && ` · routes to ${p.routes_to}`}
                </p>
              </div>
              <span className="hidden font-mono text-xs text-muted-foreground md:inline">
                {p.vapi_phone_number_id}
              </span>
            </RecordRow>
          ))}
        </TabsContent>

        <TabsContent value="rules" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Each rule maps a client-journey trigger to an agent and a cadence. Timing is relative to
            the trigger event, or to the appointment for anchored rules; quiet hours (8:00–20:00
            Sydney, Mon–Sat) apply to every dial.
          </p>
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              agents={agents}
              phones={phones}
              onPatch={(patch) => patchRule.mutate({ id: r.id, ...patch })}
            />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AgentRow({
  agent,
  onToggle,
}: {
  agent: {
    id: string;
    name: string;
    role: string | null;
    direction: string;
    description: string | null;
    vapi_assistant_id: string;
    squad_position: number | null;
    is_active: boolean;
  };
  onToggle: () => void;
}) {
  return (
    <RecordRow
      spine={agent.is_active ? "ok" : "idle"}
      className="flex items-center gap-3 px-4 py-3"
    >
      <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {agent.name}
          {agent.role && (
            <Badge variant="secondary" className="ml-2">
              {agent.role.replace(/_/g, " ")}
            </Badge>
          )}
          <Badge variant="outline" className="ml-1">
            {agent.direction}
          </Badge>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {agent.description ?? agent.vapi_assistant_id}
        </p>
      </div>
      <span className="hidden font-mono text-[10px] text-muted-foreground lg:inline">
        {agent.vapi_assistant_id}
      </span>
      <Switch checked={agent.is_active} onCheckedChange={onToggle} aria-label="Active" />
    </RecordRow>
  );
}

function RuleRow({
  rule,
  agents,
  phones,
  onPatch,
}: {
  rule: {
    id: string;
    trigger_type: string;
    label: string;
    is_enabled: boolean;
    vapi_assistant_id: string | null;
    vapi_phone_number_id: string | null;
    schedule_anchor: string;
    delay_seconds: number;
    anchor_offset_seconds: number;
    expiry_seconds: number | null;
    max_attempts: number;
    retry_delay_seconds: number;
  };
  agents: Array<{ vapi_assistant_id: string; name: string }>;
  phones: Array<{ vapi_phone_number_id: string; label: string; phone_number: string | null }>;
  onPatch: (patch: {
    isEnabled?: boolean;
    vapiAssistantId?: string | null;
    vapiPhoneNumberId?: string | null;
    delaySeconds?: number;
    maxAttempts?: number;
  }) => void;
}) {
  const [editingDelay, setEditingDelay] = useState<string | null>(null);
  const timing =
    rule.schedule_anchor === "appointment"
      ? `appointment ${rule.anchor_offset_seconds >= 0 ? "+" : "−"}${secondsLabel(Math.abs(rule.anchor_offset_seconds))}`
      : `event +${secondsLabel(rule.delay_seconds)}`;

  return (
    <RecordRow
      spine={rule.is_enabled ? "ok" : "idle"}
      className="flex flex-wrap items-center gap-3 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{rule.label}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {rule.trigger_type} · dials at {timing}
          {rule.expiry_seconds != null && ` · expires +${secondsLabel(rule.expiry_seconds)}`}
          {` · ${rule.max_attempts} attempt${rule.max_attempts === 1 ? "" : "s"}`}
        </p>
      </div>
      <Select
        value={rule.vapi_assistant_id ?? "none"}
        onValueChange={(v) => onPatch({ vapiAssistantId: v === "none" ? null : v })}
      >
        <SelectTrigger className="w-52">
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No agent (rule idle)</SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.vapi_assistant_id} value={a.vapi_assistant_id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={rule.vapi_phone_number_id ?? "none"}
        onValueChange={(v) => onPatch({ vapiPhoneNumberId: v === "none" ? null : v })}
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Line" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">VAPI default line</SelectItem>
          {phones.map((p) => (
            <SelectItem key={p.vapi_phone_number_id} value={p.vapi_phone_number_id}>
              {p.phone_number ?? p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {rule.schedule_anchor === "event" && (
        <Input
          className="w-24"
          value={editingDelay ?? String(rule.delay_seconds)}
          onChange={(e) => setEditingDelay(e.target.value)}
          onBlur={() => {
            const v = Number(editingDelay);
            if (editingDelay !== null && Number.isInteger(v) && v >= 0) {
              onPatch({ delaySeconds: v });
            }
            setEditingDelay(null);
          }}
          aria-label="Delay seconds"
        />
      )}
      <Switch
        checked={rule.is_enabled}
        onCheckedChange={(v) => onPatch({ isEnabled: v })}
        aria-label="Enabled"
      />
    </RecordRow>
  );
}
