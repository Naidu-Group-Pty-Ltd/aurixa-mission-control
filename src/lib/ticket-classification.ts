// Pure criticality indexing for support tickets. Lives in /lib (not /server)
// so the tickets UI can show the same matrix the ingest endpoint applied,
// and so the rules are unit-testable without a database.
//
// The classifier is deliberately deterministic: a ticket's priority decides
// whether it enters the self-remediation pipeline at all, so "the model felt
// like P2 today" is not an acceptable failure mode. Scores come from a fixed
// category × breakage-vector matrix plus a small set of keyword escalators,
// and the band edges are pinned by tests.

export const TICKET_PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = [
  "security_threat",
  "api_outage",
  "provider_downtime",
  "bug",
  "performance",
  "data_issue",
  "access",
  "billing",
  "feature_request",
  "question",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const BREAKAGE_VECTORS = [
  "full_outage",
  "partial_outage",
  "degraded_performance",
  "single_feature",
  "intermittent",
  "cosmetic",
  "none",
] as const;
export type BreakageVector = (typeof BREAKAGE_VECTORS)[number];

/** The automated lane a ticket flows into when it is auto-remediable. */
export type RemediationLane = "security_scan" | "redeploy" | "monitor" | "rescan";

export type TicketClassification = {
  priority: TicketPriority;
  /** 0–100 composite score the band was read from — kept for audit. */
  score: number;
  slaMinutes: number;
  /**
   * True when the ticket may enter the self-remediation pipeline. Only P2
   * and below qualify, and only categories with a known remediation lane.
   */
  autoRemediable: boolean;
  /**
   * True when a human must validate before any remediation executes. P0/P1
   * always; categories where an automated "fix" can destroy value (client
   * data, money, access control) always, regardless of priority.
   */
  requiresHuman: boolean;
  lane: RemediationLane | null;
  reasons: string[];
};

// ── The matrix ───────────────────────────────────────────────────────────

const CATEGORY_BASE: Record<TicketCategory, number> = {
  security_threat: 80,
  api_outage: 70,
  data_issue: 65,
  provider_downtime: 55,
  access: 50,
  performance: 40,
  bug: 35,
  billing: 30,
  other: 15,
  question: 10,
  feature_request: 5,
};

const VECTOR_ADJUST: Record<BreakageVector, number> = {
  full_outage: 30,
  partial_outage: 18,
  degraded_performance: 10,
  intermittent: 6,
  single_feature: 2,
  cosmetic: -10,
  none: -20,
};

// Free-text escalators. These only ever raise a score — a reporter
// underselling an incident is common, overselling is handled by the human
// gate on P0/P1, so downgrading on text is never worth the risk.
const SECURITY_SIGNALS =
  /\b(breach|leak(ed|ing)?|expos(ed|ure)\s+(of\s+)?(a\s+|an\s+)?(secret|key|credential|token)|(secret|key|credential|token)s?\s+(was\s+|were\s+|got\s+)?(leaked|exposed|stolen)|credential|ransom|exfiltrat|unauthori[sz]ed\s+access|compromis)/i;
const OUTAGE_SIGNALS =
  /\b(production\s+(is\s+)?down|all\s+users|every\s+(user|client|workspace)|cannot\s+log\s?in|can't\s+log\s?in|data\s+loss|corrupt(ed)?)\b/i;

const SECURITY_SIGNAL_BOOST = 15;
const OUTAGE_SIGNAL_BOOST = 10;

// Band edges. score >= edge ⇒ that priority.
const BANDS: Array<{ edge: number; priority: TicketPriority }> = [
  { edge: 90, priority: "P0" },
  { edge: 70, priority: "P1" },
  { edge: 50, priority: "P2" },
  { edge: 25, priority: "P3" },
  { edge: 0, priority: "P4" },
];

export const PRIORITY_SLA_MINUTES: Record<TicketPriority, number> = {
  P0: 30,
  P1: 120,
  P2: 480,
  P3: 1440,
  P4: 4320,
};

/**
 * Categories whose automated "fix" could destroy value that no rollback
 * recovers: client data, money, or who-can-see-what. These always route to
 * a human regardless of priority — the "rare/edge cases" carve-out.
 */
const ALWAYS_HUMAN_CATEGORIES: ReadonlySet<TicketCategory> = new Set([
  "data_issue",
  "billing",
  "access",
]);

/** The lane each auto-remediable category flows into. */
const CATEGORY_LANE: Partial<Record<TicketCategory, RemediationLane>> = {
  security_threat: "security_scan",
  api_outage: "redeploy",
  provider_downtime: "monitor",
  bug: "rescan",
  performance: "rescan",
};

export type ClassifyTicketInput = {
  category: TicketCategory;
  breakageVector: BreakageVector;
  subject?: string | null;
  description?: string | null;
  impact?: string | null;
};

export function classifyTicket(input: ClassifyTicketInput): TicketClassification {
  const reasons: string[] = [];

  let score = CATEGORY_BASE[input.category];
  reasons.push(`category ${input.category} base ${CATEGORY_BASE[input.category]}`);

  score += VECTOR_ADJUST[input.breakageVector];
  reasons.push(
    `breakage vector ${input.breakageVector} ${VECTOR_ADJUST[input.breakageVector] >= 0 ? "+" : ""}${VECTOR_ADJUST[input.breakageVector]}`,
  );

  const text = [input.subject, input.description, input.impact].filter(Boolean).join("\n");
  if (SECURITY_SIGNALS.test(text)) {
    score += SECURITY_SIGNAL_BOOST;
    reasons.push(`security signal in report text +${SECURITY_SIGNAL_BOOST}`);
  }
  if (OUTAGE_SIGNALS.test(text)) {
    score += OUTAGE_SIGNAL_BOOST;
    reasons.push(`outage signal in report text +${OUTAGE_SIGNAL_BOOST}`);
  }

  score = Math.max(0, Math.min(100, score));

  const priority = BANDS.find((b) => score >= b.edge)!.priority;

  const humanByPriority = priority === "P0" || priority === "P1";
  const humanByCategory = ALWAYS_HUMAN_CATEGORIES.has(input.category);
  const requiresHuman = humanByPriority || humanByCategory;
  if (humanByPriority) reasons.push(`${priority} always requires human validation`);
  if (humanByCategory) reasons.push(`category ${input.category} always requires human validation`);

  const lane = CATEGORY_LANE[input.category] ?? null;
  const autoRemediable = !requiresHuman && lane !== null;
  if (autoRemediable) reasons.push(`eligible for self-remediation via ${lane} lane`);
  else if (!requiresHuman) reasons.push("no automated lane for this category");

  return {
    priority,
    score,
    slaMinutes: PRIORITY_SLA_MINUTES[priority],
    autoRemediable,
    requiresHuman,
    // Kept even when human-gated: the reviewer sees which lane an approval
    // would release the ticket into.
    lane,
    reasons,
  };
}

// ── Bridging the security scanner into the same policy ──────────────────

/**
 * Map a Codex finding severity onto the ticket priority scale so scan
 * findings and support tickets share one auto-remediation gate: medium and
 * below (⇒ P2 and below) may self-heal, critical/high (⇒ P0/P1) never do.
 */
export function severityToPriority(severity: string): TicketPriority {
  switch (severity) {
    case "critical":
      return "P0";
    case "high":
      return "P1";
    case "medium":
      return "P2";
    case "low":
      return "P3";
    default:
      return "P4";
  }
}

/** True when `priority` is `threshold` or less urgent (P2 ≤ P2, P3 ≤ P2…). */
export function priorityAtOrBelow(priority: TicketPriority, threshold: TicketPriority): boolean {
  return TICKET_PRIORITIES.indexOf(priority) >= TICKET_PRIORITIES.indexOf(threshold);
}
