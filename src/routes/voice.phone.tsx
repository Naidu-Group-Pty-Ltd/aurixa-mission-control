// Phone — the operator softphone. Make and receive real phone calls from the
// browser, carried by Twilio Voice. Until the Twilio number and secrets
// exist the page reports exactly what is missing and everything else stays
// inert; the moment they land, the same page is a working phone.
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MonoStatus } from "@/components/voice/tone";
import { useTelephony } from "@/components/voice/softphone/telephony-provider";
import { formatCallDuration } from "@/components/voice/softphone/softphone-overlay";
import {
  getTelephonyStatus,
  listPhoneCalls,
  searchDialableContacts,
  setTelephonyRinging,
} from "@/lib/telephony.functions";
import {
  Delete,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
} from "lucide-react";

export const Route = createFileRoute("/voice/phone")({
  component: () => (
    <ProtectedRoute>
      <PhonePage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Phone — Aurixa Mission Control" },
      {
        name: "description",
        content: "The operator softphone: make and receive client phone calls from the browser.",
      },
      { property: "og:title", content: "Phone — Aurixa Mission Control" },
      { property: "og:description", content: "Browser calling for Mission Control operators." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const PHASE_LABEL: Record<string, string> = {
  disabled: "Phone off",
  unconfigured: "Twilio not configured",
  connecting: "Connecting…",
  ready: "Ready",
  error: "Error",
};

const PHASE_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "destructive"> = {
  disabled: "neutral",
  unconfigured: "warning",
  connecting: "info",
  ready: "success",
  error: "destructive",
};

const CALL_SPINE: Record<string, SpineTone> = {
  completed: "ok",
  "in-progress": "live",
  ringing: "live",
  initiated: "idle",
  "no-answer": "warn",
  busy: "warn",
  canceled: "idle",
  failed: "bad",
};

const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

function PhonePage() {
  const qc = useQueryClient();
  const phone = useTelephony();
  const [dialInput, setDialInput] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [direction, setDirection] = useState<"all" | "inbound" | "outbound">("all");

  const statusQ = useQuery({
    queryKey: ["telephony", "status"],
    queryFn: () => getTelephonyStatus(),
    refetchInterval: 30_000,
  });
  const callsQ = useQuery({
    queryKey: ["telephony", "calls", direction],
    queryFn: () => listPhoneCalls({ data: { direction } }),
    refetchInterval: 15_000,
  });
  const contactsQ = useQuery({
    queryKey: ["telephony", "contacts", contactSearch],
    queryFn: () => searchDialableContacts({ data: { search: contactSearch } }),
    enabled: contactSearch.trim().length >= 2,
  });

  // Refresh the ledger shortly after a call ends so the row appears.
  const inCall = Boolean(phone.activeCall);
  useEffect(() => {
    if (!inCall) {
      const t = setTimeout(
        () => void qc.invalidateQueries({ queryKey: ["telephony", "calls"] }),
        2500,
      );
      return () => clearTimeout(t);
    }
  }, [inCall, qc]);

  const status = statusQ.data;
  const calls = callsQ.data?.calls ?? [];
  const myRegistration = status?.registrations.find((r) => r.identity === status.identity);
  const counts = useMemo(() => {
    const today = new Date().toDateString();
    const todays = calls.filter((c) => new Date(c.created_at).toDateString() === today);
    return {
      today: todays.length,
      missed: todays.filter(
        (c) => c.direction === "inbound" && ["no-answer", "busy", "failed", "canceled"].includes(c.status),
      ).length,
      connected: todays.filter((c) => c.status === "completed").length,
    };
  }, [calls]);

  const dial = async (raw: string) => {
    const to = raw.replace(/[^\d+*#]/g, "");
    if (!to) return;
    if (phone.phase !== "ready") {
      toast.error(
        phone.phase === "unconfigured"
          ? "Twilio is not configured yet — add the secrets first."
          : "Switch the phone on first.",
      );
      return;
    }
    await phone.makeCall(to);
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="voice operations"
        title="Phone"
        description="The operator softphone: real client calls, made and answered in the browser, carried by Twilio and ledgered against the CRM."
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Phone on</span>
            <Switch
              checked={phone.enabled}
              onCheckedChange={(on) => phone.setEnabled(on)}
              aria-label="Enable the softphone"
            />
          </div>
        }
      />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-5">
        <MetricCell label="line state" value={PHASE_LABEL[phone.phase] ?? phone.phase} />
        <MetricCell
          label="caller id"
          value={status?.configured ? (status.callerId ?? "—") : "not set"}
        />
        <MetricCell label="calls today" value={counts.today} />
        <MetricCell label="connected" value={counts.connected} />
        <MetricCell
          label="missed"
          value={counts.missed}
          tone="destructive"
          alarm={counts.missed > 0}
        />
      </div>

      {phone.phase === "unconfigured" && (
        <div className="glass border border-amber-500/40 p-4">
          <p className="text-sm font-medium text-foreground">
            Twilio is not connected yet — the softphone is built and waiting.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Once the number is purchased, add these Worker secrets and the phone comes alive
            without a code change:{" "}
            <span className="font-mono text-xs">{phone.missing.join(", ")}</span>. Point the
            TwiML App's voice URL at{" "}
            <span className="font-mono text-xs">/api/public/telephony/voice</span>, the number's
            voice URL at <span className="font-mono text-xs">/api/public/telephony/incoming</span>{" "}
            and status callbacks at{" "}
            <span className="font-mono text-xs">/api/public/telephony/status</span>.
          </p>
        </div>
      )}
      {phone.phase === "error" && (
        <div className="glass border border-destructive/40 p-4">
          <p className="text-sm font-medium text-destructive">Softphone error</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{phone.error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* ---- dialer / active call ---- */}
        <div className="space-y-6">
          {phone.activeCall ? (
            <div className="glass-strong space-y-4 p-5">
              <div className="flex items-center justify-between">
                <MonoStatus tone="success" label="live call" />
                <Badge variant="outline">
                  {phone.activeCall.direction === "inbound" ? "inbound" : "outbound"}
                </Badge>
              </div>
              <div>
                <p className="truncate font-mono text-2xl text-foreground">
                  {phone.activeCall.remote}
                </p>
                <LiveTimer startedAt={phone.activeCall.startedAt} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {KEYPAD.map((k) => (
                  <Button
                    key={k}
                    variant="outline"
                    className="font-mono text-base"
                    onClick={() => phone.sendDigits(k)}
                  >
                    {k}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={phone.toggleMute}>
                  {phone.activeCall.muted ? (
                    <>
                      <MicOff className="mr-2 h-4 w-4" /> Unmute
                    </>
                  ) : (
                    <>
                      <Mic className="mr-2 h-4 w-4" /> Mute
                    </>
                  )}
                </Button>
                <Button variant="destructive" className="flex-1" onClick={phone.hangup}>
                  <PhoneOff className="mr-2 h-4 w-4" /> Hang up
                </Button>
              </div>
            </div>
          ) : (
            <div className="glass space-y-4 p-5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                dialer
              </p>
              <div className="flex gap-2">
                <Input
                  value={dialInput}
                  onChange={(e) => setDialInput(e.target.value)}
                  placeholder="+61 4xx xxx xxx"
                  className="font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void dial(dialInput);
                  }}
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setDialInput((v) => v.slice(0, -1))}
                  aria-label="Delete digit"
                >
                  <Delete className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {KEYPAD.map((k) => (
                  <Button
                    key={k}
                    variant="outline"
                    className="font-mono text-base"
                    onClick={() => setDialInput((v) => v + k)}
                  >
                    {k}
                  </Button>
                ))}
              </div>
              <Button
                className="w-full"
                disabled={!dialInput.trim() || phone.phase !== "ready"}
                onClick={() => void dial(dialInput)}
              >
                <PhoneCall className="mr-2 h-4 w-4" /> Call
              </Button>
            </div>
          )}

          <div className="glass space-y-3 p-5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              call a contact
            </p>
            <Input
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              placeholder="Search contacts by name or number…"
            />
            <div className="space-y-1">
              {(contactsQ.data?.contacts ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
                  onClick={() => c.phone && void dial(c.phone)}
                >
                  <span className="truncate text-sm text-foreground">
                    {[c.first_name, c.last_name].filter(Boolean).join(" ")}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.phone}</span>
                </button>
              ))}
              {contactSearch.trim().length >= 2 &&
                (contactsQ.data?.contacts ?? []).length === 0 &&
                !contactsQ.isFetching && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No dialable contact found.</p>
                )}
            </div>
          </div>

          <div className="glass space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  incoming ringing
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Ring this browser when clients call the Aurixa number.
                </p>
              </div>
              <Switch
                checked={myRegistration?.ring_enabled ?? true}
                onCheckedChange={(on) => {
                  void setTelephonyRinging({ data: { ringEnabled: on } }).then(() =>
                    qc.invalidateQueries({ queryKey: ["telephony", "status"] }),
                  );
                }}
                aria-label="Ring this browser for incoming calls"
              />
            </div>
            <div className="space-y-1">
              {(status?.registrations ?? []).map((r) => (
                <div key={r.identity} className="flex items-center justify-between text-xs">
                  <span className="truncate font-mono text-muted-foreground">
                    {r.display_name || r.identity}
                    {r.identity === status?.identity ? " (you)" : ""}
                  </span>
                  <MonoStatus
                    tone={r.fresh && r.ring_enabled ? "success" : "neutral"}
                    label={r.fresh ? (r.ring_enabled ? "ringing" : "silenced") : "offline"}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ---- call history ---- */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              recent calls
            </p>
            <div className="flex gap-1">
              {(["all", "inbound", "outbound"] as const).map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={direction === d ? "default" : "outline"}
                  onClick={() => setDirection(d)}
                >
                  {d}
                </Button>
              ))}
            </div>
          </div>
          {calls.length === 0 ? (
            <EmptyState
              icon={<Phone className="h-8 w-8" />}
              title="No calls yet"
              description="Operator calls land here the moment the first one is placed or received."
            />
          ) : (
            <div className="space-y-1">
              {calls.map((c) => (
                <RecordRow
                  key={c.id}
                  spine={CALL_SPINE[c.status] ?? "idle"}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {c.direction === "inbound" ? (
                      ["no-answer", "busy", "failed", "canceled"].includes(c.status) ? (
                        <PhoneMissed className="h-4 w-4 shrink-0 text-destructive" />
                      ) : (
                        <PhoneIncoming className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )
                    ) : (
                      <PhoneOutgoing className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {c.customer_name || c.phone_number}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {c.phone_number}
                        {c.contact_id && (
                          <>
                            {" · "}
                            <Link
                              to="/crm/journey"
                              className="underline-offset-2 hover:underline"
                            >
                              journey
                            </Link>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {typeof c.duration_seconds === "number" && c.duration_seconds > 0 && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {Math.floor(c.duration_seconds / 60)}:
                        {String(c.duration_seconds % 60).padStart(2, "0")}
                      </span>
                    )}
                    <MonoStatus
                      tone={
                        c.status === "completed"
                          ? "success"
                          : ["failed", "busy", "no-answer"].includes(c.status)
                            ? "destructive"
                            : ["ringing", "in-progress"].includes(c.status)
                              ? "info"
                              : "neutral"
                      }
                      label={c.status}
                    />
                    <span className="w-24 text-right text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </RecordRow>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <p className="mt-1 font-mono text-sm text-muted-foreground">
      {formatCallDuration(startedAt, now)}
    </p>
  );
}
