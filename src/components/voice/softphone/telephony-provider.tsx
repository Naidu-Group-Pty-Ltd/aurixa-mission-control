// The operator softphone runtime — a Twilio Voice Device living at the app
// root so inbound calls ring on every page, not just /voice/phone.
//
// Lifecycle: disabled (operator hasn't switched the phone on) → unconfigured
// (Twilio env secrets missing — a reported state, never an error) →
// connecting → ready. The SDK is imported lazily so operators who never
// touch the phone never download it; tokens refresh themselves on the
// device's tokenWillExpire; a 60-second heartbeat keeps this browser inside
// the inbound ring window, and closing the tab lets the registration go
// stale on its own.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  issueTelephonyToken,
  telephonyHeartbeat,
} from "@/lib/telephony.functions";

type TwilioCall = {
  accept: () => void;
  reject: () => void;
  disconnect: () => void;
  mute: (muted: boolean) => void;
  isMuted: () => boolean;
  sendDigits: (digits: string) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  parameters: Record<string, string>;
};

type TwilioDevice = {
  register: () => Promise<void>;
  destroy: () => void;
  updateToken: (token: string) => void;
  connect: (options: { params: Record<string, string> }) => Promise<TwilioCall>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type SoftphonePhase =
  | "disabled"
  | "unconfigured"
  | "connecting"
  | "ready"
  | "error";

export type ActiveCall = {
  direction: "inbound" | "outbound";
  remote: string;
  startedAt: number;
  muted: boolean;
};

type TelephonyContextValue = {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  phase: SoftphonePhase;
  missing: string[];
  error: string | null;
  identity: string | null;
  activeCall: ActiveCall | null;
  incomingFrom: string | null;
  makeCall: (to: string) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
};

const TelephonyContext = createContext<TelephonyContextValue | null>(null);

export function useTelephony(): TelephonyContextValue {
  const ctx = useContext(TelephonyContext);
  if (!ctx) throw new Error("useTelephony must be used inside TelephonyProvider");
  return ctx;
}

const ENABLED_KEY = "aurixa.telephony.enabled";

function readEnabled(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

export function TelephonyProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [enabled, setEnabledState] = useState(false);
  const [phase, setPhase] = useState<SoftphonePhase>("disabled");
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [incomingFrom, setIncomingFrom] = useState<string | null>(null);

  const deviceRef = useRef<TwilioDevice | null>(null);
  const callRef = useRef<TwilioCall | null>(null);
  const incomingRef = useRef<TwilioCall | null>(null);

  // Hydration-safe read of the persisted switch.
  useEffect(() => {
    setEnabledState(readEnabled());
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    try {
      localStorage.setItem(ENABLED_KEY, on ? "true" : "false");
    } catch {
      // storage unavailable — the in-memory switch still works for this tab
    }
    setEnabledState(on);
  }, []);

  const attachCall = useCallback((call: TwilioCall, direction: "inbound" | "outbound", remote: string) => {
    callRef.current = call;
    setActiveCall({ direction, remote, startedAt: Date.now(), muted: false });
    call.on("disconnect", () => {
      callRef.current = null;
      setActiveCall(null);
    });
    call.on("cancel", () => {
      callRef.current = null;
      setActiveCall(null);
    });
    call.on("error", () => {
      callRef.current = null;
      setActiveCall(null);
    });
  }, []);

  // Boot / tear down the Device with the enabled switch and the session.
  useEffect(() => {
    if (!session || !enabled) {
      deviceRef.current?.destroy();
      deviceRef.current = null;
      setPhase(session ? "disabled" : "disabled");
      setActiveCall(null);
      setIncomingFrom(null);
      return;
    }
    let cancelled = false;

    async function boot() {
      setPhase("connecting");
      setError(null);
      try {
        const issued = await issueTelephonyToken({ data: {} });
        if (cancelled) return;
        if (!issued.configured) {
          setMissing(issued.missing);
          setPhase("unconfigured");
          return;
        }
        setIdentity(issued.identity);
        // The vendored dist bundle is an IIFE that attaches `Twilio` to
        // window; the package's ESM build imports Node's `events`, which the
        // client bundler externals to an empty stub, and its exports map
        // hides the dist build — see src/vendor/README.md.
        await import("@/vendor/twilio-voice-sdk.min.js");
        const sdk = (window as unknown as {
          Twilio?: { Device: new (token: string, options?: Record<string, unknown>) => TwilioDevice };
        }).Twilio;
        if (!sdk) throw new Error("Twilio SDK failed to load");
        if (cancelled) return;
        const device = new sdk.Device(issued.token, {
          logLevel: "error",
          closeProtection: true,
        });
        deviceRef.current = device;

        device.on("registered", () => {
          if (!cancelled) setPhase("ready");
        });
        device.on("error", (err) => {
          const message = (err as { message?: string })?.message ?? "device error";
          console.error("[softphone]", message);
          if (!cancelled) {
            setError(message);
            setPhase("error");
          }
        });
        device.on("tokenWillExpire", () => {
          void issueTelephonyToken({ data: {} }).then((next) => {
            if (next.configured && deviceRef.current) deviceRef.current.updateToken(next.token);
          });
        });
        device.on("incoming", (raw) => {
          const call = raw as TwilioCall;
          const from = call.parameters?.From ?? "unknown caller";
          incomingRef.current = call;
          setIncomingFrom(from);
          call.on("cancel", () => {
            incomingRef.current = null;
            setIncomingFrom(null);
          });
          call.on("disconnect", () => {
            incomingRef.current = null;
            setIncomingFrom(null);
          });
        });
        await device.register();
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setPhase("error");
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, [session, enabled]);

  // Registration heartbeat — the inbound ring window.
  useEffect(() => {
    if (phase !== "ready") return;
    const interval = setInterval(() => {
      void telephonyHeartbeat().catch(() => undefined);
    }, 60_000);
    return () => clearInterval(interval);
  }, [phase]);

  const makeCall = useCallback(
    async (to: string) => {
      const device = deviceRef.current;
      if (!device || phase !== "ready") {
        toast.error("The phone is not connected yet.");
        return;
      }
      if (callRef.current) {
        toast.error("A call is already in progress.");
        return;
      }
      const call = await device.connect({ params: { To: to } });
      attachCall(call, "outbound", to);
    },
    [phase, attachCall],
  );

  const hangup = useCallback(() => {
    callRef.current?.disconnect();
  }, []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !call.isMuted();
    call.mute(next);
    setActiveCall((prev) => (prev ? { ...prev, muted: next } : prev));
  }, []);

  const sendDigits = useCallback((digits: string) => {
    callRef.current?.sendDigits(digits);
  }, []);

  const acceptIncoming = useCallback(() => {
    const call = incomingRef.current;
    if (!call) return;
    call.accept();
    const from = call.parameters?.From ?? "unknown caller";
    incomingRef.current = null;
    setIncomingFrom(null);
    attachCall(call, "inbound", from);
  }, [attachCall]);

  const rejectIncoming = useCallback(() => {
    incomingRef.current?.reject();
    incomingRef.current = null;
    setIncomingFrom(null);
  }, []);

  const value = useMemo<TelephonyContextValue>(
    () => ({
      enabled,
      setEnabled,
      phase,
      missing,
      error,
      identity,
      activeCall,
      incomingFrom,
      makeCall,
      hangup,
      toggleMute,
      sendDigits,
      acceptIncoming,
      rejectIncoming,
    }),
    [
      enabled,
      setEnabled,
      phase,
      missing,
      error,
      identity,
      activeCall,
      incomingFrom,
      makeCall,
      hangup,
      toggleMute,
      sendDigits,
      acceptIncoming,
      rejectIncoming,
    ],
  );

  return <TelephonyContext.Provider value={value}>{children}</TelephonyContext.Provider>;
}
