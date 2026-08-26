// The call-log vocabulary, ported verbatim from the prime repo's Call Logs
// page so the two surfaces read a call the same way: how a raw VAPI
// `endedReason` maps to an outcome category, how sentiment renders, and the
// quality-score rubric. Pure and client-safe — no imports, no IO.

export type OutcomeCategory =
  | "success"
  | "voicemail"
  | "no-answer"
  | "busy"
  | "timeout"
  | "cancelled"
  | "error"
  | "other";

/** Collapse a raw VAPI endedReason (or legacy outcome) into a category. */
export function getOutcomeCategory(outcome: string | null | undefined): OutcomeCategory {
  if (!outcome) return "other";
  const o = outcome.toLowerCase();
  if (o === "completed" || o === "customer-ended-call" || o === "assistant-ended-call") {
    return "success";
  }
  if (o === "assistant-forwarded-call") return "success";
  if (o.includes("voicemail")) return "voicemail";
  if (o === "customer-did-not-answer" || o === "no-answer") return "no-answer";
  if (o === "customer-busy" || o === "busy") return "busy";
  if (o.includes("silence-timed-out") || o.includes("max-duration") || o === "timeout") {
    return "timeout";
  }
  if (o.includes("cancel")) return "cancelled";
  if (
    o === "blacklisted" ||
    o === "killed" ||
    o === "failed" ||
    o.includes("error") ||
    o.includes("failed")
  ) {
    return "error";
  }
  return "other";
}

export type OutcomeTone = "success" | "warning" | "destructive" | "info" | "neutral";

export const OUTCOME_DISPLAY: Record<string, { label: string; tone: OutcomeTone }> = {
  "customer-ended-call": { label: "Customer ended", tone: "success" },
  "assistant-ended-call": { label: "Assistant ended", tone: "success" },
  "assistant-forwarded-call": { label: "Forwarded", tone: "info" },
  voicemail: { label: "Voicemail", tone: "warning" },
  "customer-did-not-answer": { label: "No answer", tone: "warning" },
  "customer-busy": { label: "Busy", tone: "warning" },
  "silence-timed-out": { label: "Silence timeout", tone: "warning" },
  "exceeded-max-duration": { label: "Max duration", tone: "warning" },
  "manually-canceled": { label: "Canceled", tone: "neutral" },
  completed: { label: "Completed", tone: "success" },
  "no-answer": { label: "No answer", tone: "warning" },
  busy: { label: "Busy", tone: "warning" },
  failed: { label: "Failed", tone: "destructive" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  timeout: { label: "Timeout", tone: "warning" },
  "stale-timeout": { label: "Stale (auto-closed)", tone: "neutral" },
  blacklisted: { label: "Blacklisted", tone: "destructive" },
  killed: { label: "Killed", tone: "destructive" },
};

/** Human label for any outcome, with a title-cased fallback for new reasons. */
export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "Unknown";
  const known = OUTCOME_DISPLAY[outcome];
  if (known) return known.label;
  return outcome
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function outcomeTone(outcome: string | null | undefined): OutcomeTone {
  if (!outcome) return "neutral";
  const known = OUTCOME_DISPLAY[outcome];
  if (known) return known.tone;
  switch (getOutcomeCategory(outcome)) {
    case "success":
      return "success";
    case "error":
      return "destructive";
    case "cancelled":
    case "other":
      return "neutral";
    default:
      return "warning";
  }
}

export type Sentiment = "positive" | "neutral" | "negative" | "mixed";

export const SENTIMENT_TONE: Record<Sentiment, OutcomeTone> = {
  positive: "success",
  negative: "destructive",
  neutral: "neutral",
  mixed: "warning",
};

export const CALL_INTENTS = [
  "discovery_booking",
  "strategy_booking",
  "finance_consult",
  "general_inquiry",
] as const;

export const INTENT_LABELS: Record<string, string> = {
  discovery_booking: "Discovery booking",
  strategy_booking: "Strategy booking",
  finance_consult: "Finance consult",
  general_inquiry: "General inquiry",
};

/**
 * The quality-score rubric from the prime repo, unchanged: sentiment /30,
 * duration /25, outcome /30, cost efficiency /10, transcript presence /5.
 */
export function callQualityScore(input: {
  sentiment: string | null;
  durationSeconds: number | null;
  outcome: string | null;
  cost: number | null;
  hasTranscript: boolean;
}): {
  total: number;
  sentiment: number;
  duration: number;
  outcome: number;
  cost: number;
  data: number;
} {
  let sentimentScore = 15;
  switch (input.sentiment) {
    case "positive":
      sentimentScore = 30;
      break;
    case "mixed":
      sentimentScore = 20;
      break;
    case "neutral":
      sentimentScore = 15;
      break;
    case "negative":
      sentimentScore = 5;
      break;
    default:
      sentimentScore = 15;
  }

  const mins = (input.durationSeconds ?? 0) / 60;
  let durationScore: number;
  if (mins >= 2 && mins <= 10) durationScore = 25;
  else if (mins >= 1 && mins < 2) durationScore = 15;
  else if (mins > 10 && mins <= 20) durationScore = 20;
  else if (mins > 20 && mins <= 30) durationScore = 15;
  else if (mins > 30) durationScore = 10;
  else durationScore = 5;

  let outcomeScore: number;
  switch (getOutcomeCategory(input.outcome)) {
    case "success":
      outcomeScore = 30;
      break;
    case "voicemail":
      outcomeScore = 15;
      break;
    case "no-answer":
    case "busy":
      outcomeScore = 10;
      break;
    case "error":
    case "cancelled":
      outcomeScore = 5;
      break;
    default:
      outcomeScore = 10;
  }

  const cost = input.cost ?? 0;
  let costScore: number;
  if (cost < 0.05) costScore = 10;
  else if (cost < 0.15) costScore = 8;
  else if (cost < 0.3) costScore = 6;
  else if (cost < 0.5) costScore = 4;
  else costScore = 2;

  const dataScore = input.hasTranscript ? 5 : 0;

  return {
    total: sentimentScore + durationScore + outcomeScore + costScore + dataScore,
    sentiment: sentimentScore,
    duration: durationScore,
    outcome: outcomeScore,
    cost: costScore,
    data: dataScore,
  };
}

/** mm:ss for a call duration. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Documented root-cause vocabulary for negative-call review. */
export const ROOT_CAUSE_CATEGORIES = [
  "pricing_objection",
  "service_complaint",
  "agent_confusion",
  "long_hold_time",
  "unresolved_query",
  "technical_issue",
  "miscommunication",
  "customer_frustration",
  "wrong_transfer",
  "information_gap",
] as const;

export const RESOLUTION_STATUSES = ["needs_review", "reviewed", "resolved", "escalated"] as const;
