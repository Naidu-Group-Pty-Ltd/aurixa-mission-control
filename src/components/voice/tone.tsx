// Shared render helpers for the voice surfaces: tone → text class (status is
// a coloured word, never a filled chip — see docs/DESIGN_SYSTEM.md), and the
// small mono badges the call rows use.
import { cn } from "@/lib/utils";
import type { OutcomeTone } from "@/lib/voice-vocab";
import { outcomeLabel, outcomeTone, SENTIMENT_TONE, type Sentiment } from "@/lib/voice-vocab";

export const TONE_TEXT: Record<OutcomeTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
  neutral: "text-muted-foreground",
};

export function MonoStatus({
  label,
  tone,
  pulse,
  className,
}: {
  label: string;
  tone: OutcomeTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] whitespace-nowrap",
        TONE_TEXT[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 bg-current", pulse && "animate-pulse")} />
      {label}
    </span>
  );
}

export function OutcomeStatus({ outcome }: { outcome: string | null }) {
  return <MonoStatus label={outcomeLabel(outcome)} tone={outcomeTone(outcome)} />;
}

export function SentimentStatus({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  const tone = SENTIMENT_TONE[sentiment as Sentiment] ?? "neutral";
  return <MonoStatus label={sentiment} tone={tone} />;
}

/** Spine tone for a call row: live > negative > outcome category. */
export function callSpine(call: {
  call_status: string | null;
  sentiment: string | null;
  call_outcome: string | null;
}): "ok" | "warn" | "bad" | "live" | "idle" {
  if (["queued", "ringing", "in-progress", "forwarding"].includes(call.call_status ?? "")) {
    return "live";
  }
  if (call.sentiment === "negative") return "bad";
  switch (outcomeTone(call.call_outcome)) {
    case "success":
      return "ok";
    case "destructive":
      return "bad";
    case "warning":
      return "warn";
    default:
      return "idle";
  }
}
