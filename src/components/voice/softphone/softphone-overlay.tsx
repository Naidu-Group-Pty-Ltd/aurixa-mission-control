// Global softphone chrome: the incoming-call banner and the in-call dock.
// Rendered at the root so a ringing client reaches the operator on any page;
// the full console lives at /voice/phone.
import { useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTelephony } from "@/components/voice/softphone/telephony-provider";

export function formatCallDuration(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function CallTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums">{formatCallDuration(startedAt, now)}</span>;
}

export function SoftphoneOverlay() {
  const { incomingFrom, acceptIncoming, rejectIncoming, activeCall, hangup, toggleMute } =
    useTelephony();
  const location = useLocation();
  const onPhonePage = location.pathname.startsWith("/voice/phone");

  return (
    <>
      {incomingFrom && (
        <div className="fixed bottom-6 right-6 z-50 w-80">
          <div className="glass-strong space-y-3 border border-primary/40 p-4 shadow-lg">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-primary">
                incoming call
              </p>
              <p className="mt-1 truncate font-mono text-lg text-foreground">{incomingFrom}</p>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={acceptIncoming}>
                <Phone className="mr-2 h-4 w-4" /> Answer
              </Button>
              <Button variant="destructive" className="flex-1" onClick={rejectIncoming}>
                <PhoneOff className="mr-2 h-4 w-4" /> Decline
              </Button>
            </div>
          </div>
        </div>
      )}

      {activeCall && !onPhonePage && !incomingFrom && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="glass-strong flex items-center gap-3 border border-border p-3 shadow-lg">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono text-sm text-foreground">{activeCall.remote}</p>
              <p className="text-xs text-muted-foreground">
                <CallTimer startedAt={activeCall.startedAt} />
              </p>
            </div>
            <Button size="icon" variant="outline" onClick={toggleMute} aria-label="Toggle mute">
              {activeCall.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button size="icon" variant="destructive" onClick={hangup} aria-label="Hang up">
              <PhoneOff className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
