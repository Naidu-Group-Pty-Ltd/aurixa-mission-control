// @ts-nocheck
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Client Fit Analysis engine.
//
// Cross-examines a lead / account against what Aurixa Systems actually sells
// (read live from the pricing catalog — never hardcoded) plus whatever the
// operators have put in the fit knowledge base, asks the AI gateway for
// per-dimension scores + evidence, and computes the weighted total in code so
// the score can never drift from the rubric.
//
// Three principles the engine enforces rather than merely requests:
//
//   * A dimension the model did not assess is *unknown*, not zero. It leaves
//     the denominator; the analysis reports how much of the rubric it covered.
//   * A score with no cited evidence cannot exceed the dimension's ceiling. The
//     prompt has always said an unevidenced high score is a failure; now the
//     scorer means it.
//   * One sample is an opinion. The engine scores each prospect several times
//     independently and reconciles by median, and how much the samples
//     disagreed is part of the output.
import type { SupabaseClient } from "@supabase/supabase-js";
import { callAi } from "./ai-gateway.server";

export const FIT_STALE_DAYS = 90;

/** Independent scoring passes per analysis. Odd, so a median is a real sample. */
export const DEFAULT_SAMPLES = 3;

/** How much of the prompt the knowledge base may occupy, in characters. */
export const KNOWLEDGE_BUDGET_CHARS = 24_000;

export type FitGrade = "A" | "B" | "C" | "D" | "F";

export type FitBand = {
  grade: string;
  verdict: string;
  min_score: number;
  label?: string;
  sort_order?: number;
};

/** The bands the engine has always applied, used when the table is unreachable. */
export const FALLBACK_BANDS: FitBand[] = [
  { grade: "A", verdict: "strong_fit", min_score: 85, sort_order: 1 },
  { grade: "B", verdict: "fit", min_score: 70, sort_order: 2 },
  { grade: "C", verdict: "conditional", min_score: 55, sort_order: 3 },
  { grade: "D", verdict: "poor_fit", min_score: 40, sort_order: 4 },
  { grade: "F", verdict: "decline", min_score: 0, sort_order: 5 },
];

/** The band a score falls into. Bands are sorted high to low and the last one wins. */
export function bandFor(score: number, bands: FitBand[] = FALLBACK_BANDS): FitBand {
  const ordered = [...(bands.length ? bands : FALLBACK_BANDS)].sort(
    (a, b) => Number(b.min_score) - Number(a.min_score),
  );
  return ordered.find((b) => score >= Number(b.min_score)) ?? ordered[ordered.length - 1];
}

export function gradeFor(score: number, bands: FitBand[] = FALLBACK_BANDS): FitGrade {
  return bandFor(score, bands).grade as FitGrade;
}

export function verdictFor(score: number, bands: FitBand[] = FALLBACK_BANDS): string {
  return bandFor(score, bands).verdict;
}

/* --------------------------- capability corpus ---------------------------- */

export async function buildCapabilityCorpus(sb: SupabaseClient<any>) {
  const [modules, plans, roles, packages] = await Promise.all([
    sb
      .from("addon_modules")
      .select(
        "slug, name, category, description, price_min_cents, price_max_cents, included_in_plans",
      )
      .eq("is_active", true)
      .order("sort_order"),
    sb
      .from("seat_plans")
      .select(
        "slug, name, description, seat_limit, device_limit_per_seat, price_cents, overage_policy",
      )
      .eq("is_active", true),
    sb
      .from("seat_roles")
      .select("slug, name, description, price_min_cents, price_max_cents")
      .eq("is_active", true)
      .order("sort_order"),
    sb
      .from("setup_packages")
      .select(
        "slug, name, description, price_min_cents, price_max_cents, applies_to_plans, deliverables",
      )
      .eq("is_active", true)
      .order("sort_order"),
  ]);

  return {
    modules: modules.data ?? [],
    plans: plans.data ?? [],
    seat_roles: roles.data ?? [],
    setup_packages: packages.data ?? [],
  };
}

/* ------------------------------ knowledge base ---------------------------- */

export type KnowledgeEntry = {
  id: string;
  title: string;
  kind: string;
  content: string;
  summary?: string | null;
  tags?: string[] | null;
  pinned?: boolean | null;
};

/** Kinds that bear on a fit judgement most directly, when budget is tight. */
const KIND_PRIORITY: Record<string, number> = {
  disqualification: 5,
  icp: 4,
  positioning: 3,
  case_study: 3,
  objection: 2,
  pricing: 2,
  process: 1,
  other: 0,
};

const WORD = /[a-z0-9]+/g;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "they",
  "their",
  "have",
  "has",
  "our",
  "are",
  "was",
  "were",
  "will",
  "would",
  "about",
  "into",
  "your",
  "you",
  "not",
  "but",
  "all",
  "any",
  "can",
  "com",
  "www",
  "https",
  "http",
]);

function tokenise(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * Chooses which knowledge entries reach the prompt.
 *
 * Pinned entries always go in — that is what pinning is for, and it is how the
 * ideal-customer profile and the decline policy stay in front of the analyst on
 * every run. The rest compete on overlap with this particular prospect, then on
 * how directly their kind bears on a fit judgement.
 *
 * The budget is a character count rather than a token count deliberately: it is
 * the quantity we can measure exactly, and erring small costs a little context
 * where erring large costs the whole call.
 */
export function selectKnowledge(
  entries: KnowledgeEntry[],
  subjectText: string,
  budgetChars = KNOWLEDGE_BUDGET_CHARS,
): { selected: KnowledgeEntry[]; skipped: number; usedChars: number } {
  const usable = entries.filter((e) => (e.content ?? "").trim().length > 0);
  const subjectTokens = tokenise(subjectText);

  const scored = usable.map((entry) => {
    const haystack = `${entry.title} ${entry.summary ?? ""} ${(entry.tags ?? []).join(" ")} ${entry.content.slice(0, 4000)}`;
    const tokens = tokenise(haystack);
    let overlap = 0;
    for (const token of tokens) if (subjectTokens.has(token)) overlap += 1;
    // Normalise so a long document does not out-rank a precise one purely by
    // having more words in it.
    const relevance = tokens.size ? overlap / Math.sqrt(tokens.size) : 0;
    return { entry, relevance, priority: KIND_PRIORITY[entry.kind] ?? 0 };
  });

  scored.sort((a, b) => {
    const pinnedDiff = Number(Boolean(b.entry.pinned)) - Number(Boolean(a.entry.pinned));
    if (pinnedDiff) return pinnedDiff;
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.entry.title.localeCompare(b.entry.title);
  });

  const selected: KnowledgeEntry[] = [];
  let usedChars = 0;
  let skipped = 0;

  for (const { entry } of scored) {
    const cost = entry.content.length + entry.title.length + 40;
    if (usedChars + cost > budgetChars) {
      skipped += 1;
      continue;
    }
    selected.push(entry);
    usedChars += cost;
  }

  return { selected, skipped, usedChars };
}

export function renderKnowledge(entries: KnowledgeEntry[]): string {
  if (!entries.length) {
    return "(no internal knowledge base entries — judge on the capability corpus alone)";
  }
  return entries
    .map((e) => {
      const tags = (e.tags ?? []).length ? ` · tags: ${(e.tags ?? []).join(", ")}` : "";
      return `### [${e.kind}] ${e.title}${e.pinned ? " (pinned)" : ""}${tags}\n${e.content.trim()}`;
    })
    .join("\n\n");
}

/* ------------------------------- enrichment ------------------------------- */

function domainFromEmail(email?: string | null): string | null {
  if (!email || !email.includes("@")) return null;
  const d = email.split("@")[1]?.toLowerCase().trim();
  if (!d) return null;
  const free = [
    "gmail.com",
    "outlook.com",
    "hotmail.com",
    "yahoo.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
    "live.com",
    "bigpond.com",
  ];
  return free.includes(d) ? null : d;
}

export function candidateWebsite(input: {
  website?: string | null;
  email?: string | null;
}): string | null {
  const raw = (input.website ?? "").trim();
  if (raw) return raw.startsWith("http") ? raw : `https://${raw}`;
  const d = domainFromEmail(input.email);
  return d ? `https://${d}` : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort, time-boxed public site fetch. Failure degrades confidence, never fails the run. */
export async function fetchSiteSnapshot(url: string | null): Promise<{
  url: string | null;
  reachable: boolean;
  title: string | null;
  text: string | null;
  error?: string;
}> {
  if (!url) return { url: null, reachable: false, title: null, text: null, error: "no_website" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "AurixaFitBot/1.0 (+https://aurixasystems.com.au)" },
    });
    if (!res.ok) {
      return { url, reachable: false, title: null, text: null, error: `http_${res.status}` };
    }
    const html = (await res.text()).slice(0, 400_000);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
    const meta =
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
    const text = `${meta ? meta + "\n\n" : ""}${stripHtml(html)}`.slice(0, 12_000);
    return { url, reachable: true, title, text };
  } catch (err) {
    return {
      url,
      reachable: false,
      title: null,
      text: null,
      error: err instanceof Error ? err.name : "fetch_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------- prompt --------------------------------- */

export function buildPrompt(args: {
  subject: Record<string, unknown>;
  site: {
    url: string | null;
    reachable: boolean;
    title: string | null;
    text: string | null;
    error?: string;
  };
  corpus: Awaited<ReturnType<typeof buildCapabilityCorpus>>;
  rubric: { dimension: string; label: string; description: string | null; weight: number }[];
  knowledge?: KnowledgeEntry[];
}) {
  const dims = args.rubric
    .map((r) => `- ${r.dimension} (${r.label}, weight ${r.weight}): ${r.description ?? ""}`)
    .join("\n");
  const dimensionList = args.rubric.map((r) => r.dimension).join(", ");

  return `You are the Client Fit Analyst for Aurixa Systems, an Australian platform vendor.
Your job: cross-examine a prospective client against what Aurixa actually sells, validate the
details they submitted, and produce an evidence-backed compatibility assessment.

## PROSPECT SUBMISSION (claimed, unverified)
${JSON.stringify(args.subject, null, 2)}

## PUBLIC WEBSITE RESEARCH
URL: ${args.site.url ?? "(none found)"}
Reachable: ${args.site.reachable}${args.site.error ? ` (${args.site.error})` : ""}
Title: ${args.site.title ?? "(none)"}
Extracted copy:
${args.site.text ? args.site.text.slice(0, 9000) : "(no public copy retrieved — treat every claim as UNVERIFIED and lower confidence)"}

## AURIXA CAPABILITY CORPUS (the only things we can actually sell)
${JSON.stringify(args.corpus, null, 2)}

## AURIXA INTERNAL KNOWLEDGE (ideal customer profile, positioning, precedent, decline policy)
${renderKnowledge(args.knowledge ?? [])}

## SCORING DIMENSIONS
${dims}

## RULES
- Return one entry for EVERY dimension in this list, using these exact identifiers: ${dimensionList}.
  If you cannot assess one, still return it with your best estimate and evidence explaining the
  gap. A dimension you omit is treated as unassessed and is excluded from the score — which
  weakens the analysis rather than helping the prospect.
- Score each dimension 0-100 on its own merit. Do NOT compute a weighted total; that is done downstream.
- For "risk", 100 means no red flags and 0 means disqualifying risk.
- Every dimension needs at least one evidence item. Evidence must quote or cite the prospect
  submission, the website copy, or the internal knowledge above. A dimension with no evidence has
  its score capped by the scorer, so guessing high gains nothing — cite or say you cannot.
- Set verified=true only where the evidence is external to the prospect's own claims. A prospect
  restating their own submission is not verification.
- Never invent modules, plans, prices or capabilities that are not in the capability corpus.
  Slugs that do not exist there are stripped downstream and recorded against this analysis.
- Where the internal knowledge states a disqualification rule, apply it and cite it.
- Be blunt about poor fits. A high score with no verifiable evidence is a failure.

## OUTPUT — strict JSON, no markdown fences
{
  "headline": "one sentence verdict",
  "research_summary": "2-4 paragraphs: what this business actually does, size signals, verified vs claimed",
  "confidence": 0-100,
  "dimensions": [
    { "dimension": "problem_solution", "raw_score": 0-100, "rationale": "...", "verified": true,
      "evidence": [{ "source": "submission|website|knowledge", "quote": "...", "note": "..." }] }
  ],
  "correlation_map": [
    { "pain_point": "...", "module_slug": "...", "module_name": "...", "how_it_solves": "...", "expected_outcome": "..." }
  ],
  "recommended_plan": {
    "plan_slug": "...", "plan_name": "...",
    "addon_module_slugs": ["..."],
    "setup_package_slug": "...",
    "seat_estimate": 0,
    "rationale": "..."
  },
  "risks": [{ "risk": "...", "severity": "low|medium|high", "mitigation": "..." }],
  "open_questions": ["question for the discovery call"],
  "validation": [
    { "field": "entity_name", "claimed": "...", "status": "confirmed|contradicted|unverifiable", "note": "..." }
  ]
}`;
}

/* ------------------------------ reconciliation ---------------------------- */

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

type AiDimension = {
  dimension?: string;
  raw_score?: unknown;
  rationale?: unknown;
  verified?: unknown;
  evidence?: unknown;
};

function evidenceOf(dim: AiDimension | undefined): unknown[] {
  if (!dim || !Array.isArray(dim.evidence)) return [];
  // An evidence item is only evidence if it says something.
  return dim.evidence.filter((e) => {
    if (!e || typeof e !== "object") return typeof e === "string" && e.trim().length > 0;
    const item = e as Record<string, unknown>;
    return Boolean(
      String(item.quote ?? "").trim() ||
      String(item.note ?? "").trim() ||
      String(item.source ?? "").trim(),
    );
  });
}

function numericScore(dim: AiDimension | undefined): number | null {
  if (!dim) return null;
  const n = Number(dim.raw_score);
  return Number.isFinite(n) ? clamp(n) : null;
}

/**
 * Merges several independent samples into one set of dimension readings.
 *
 * Per dimension: the score is the median of the samples that answered it, the
 * evidence is the union across samples (deduped), and the rationale comes from
 * whichever sample sat closest to that median — merged prose reads like nobody
 * wrote it, and the nearest sample is at least internally coherent.
 */
export function reconcileSamples(samples: AiDimension[][]): Map<
  string,
  {
    raw_score: number;
    spread: number;
    rationale: string;
    verified: boolean;
    evidence: unknown[];
    answers: number;
  }
> {
  const out = new Map<string, any>();
  const dimensions = new Set<string>();
  for (const sample of samples) {
    for (const dim of sample) if (dim?.dimension) dimensions.add(String(dim.dimension));
  }

  for (const name of dimensions) {
    const readings = samples
      .map((sample) => sample.find((d) => String(d?.dimension) === name))
      .filter(Boolean) as AiDimension[];
    const scores = readings.map(numericScore).filter((n): n is number => n !== null);
    if (!scores.length) continue;

    const mid = median(scores);
    const spread = scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0;

    let closest = readings[0];
    let bestDelta = Infinity;
    for (const reading of readings) {
      const score = numericScore(reading);
      if (score === null) continue;
      const delta = Math.abs(score - mid);
      if (delta < bestDelta) {
        bestDelta = delta;
        closest = reading;
      }
    }

    // Union the evidence, keyed on its text so the same citation appearing in
    // every sample counts once.
    const seen = new Set<string>();
    const evidence: unknown[] = [];
    for (const reading of readings) {
      for (const item of evidenceOf(reading)) {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(item);
      }
    }

    // A majority has to agree before a dimension counts as externally verified.
    const verifiedVotes = readings.filter((r) => r.verified === true).length;

    out.set(name, {
      raw_score: mid,
      spread,
      rationale:
        String(closest?.rationale ?? "").trim() || "No assessment returned for this dimension.",
      verified: verifiedVotes * 2 > readings.length,
      evidence,
      answers: scores.length,
    });
  }

  return out;
}

/* --------------------------------- scoring -------------------------------- */

export type RubricRow = {
  dimension: string;
  label: string;
  weight: number;
  sort_order?: number;
  is_veto?: boolean | null;
  veto_below?: number | null;
  evidence_required?: boolean | null;
  unevidenced_ceiling?: number | null;
};

/**
 * Turns reconciled dimension readings into the analysis score.
 *
 * The denominator is the weight of the dimensions that were actually assessed,
 * not the whole rubric. Scoring an unanswered dimension as zero — which is what
 * the previous implementation did — quietly punished the prospect for the
 * model's omission, and did so invisibly. Now the omission is reported as
 * coverage and the score means "of what we assessed".
 */
export function scoreAnalysis(
  rubric: RubricRow[],
  aiDimensions: AiDimension[] | Map<string, any>,
  bands: FitBand[] = FALLBACK_BANDS,
) {
  const readings =
    aiDimensions instanceof Map ? aiDimensions : reconcileSamples([aiDimensions ?? []]);

  const totalWeight = rubric.reduce((s, r) => s + Number(r.weight || 0), 0);
  let answeredWeight = 0;
  let evidenceCount = 0;
  let verifiedWeight = 0;
  const skipped: string[] = [];
  const capped: string[] = [];

  const rows = rubric.map((r, i) => {
    const reading = readings.get(r.dimension);
    const weight = Number(r.weight || 0);
    const answered = Boolean(reading);
    const evidence = reading?.evidence ?? [];
    const hasEvidence = evidence.length > 0;

    let raw = answered ? clamp(Number(reading.raw_score)) : 0;

    // No evidence, no confidence: the ceiling applies however sure the model
    // sounded. This is the rule the prompt has always stated.
    const ceiling = Number(r.unevidenced_ceiling ?? 55);
    const requiresEvidence = r.evidence_required !== false;
    const wasCapped = answered && requiresEvidence && !hasEvidence && raw > ceiling;
    if (wasCapped) {
      raw = ceiling;
      capped.push(r.dimension);
    }

    if (!answered) skipped.push(r.dimension);
    if (answered) {
      answeredWeight += weight;
      evidenceCount += evidence.length;
      // The model's own "verified" claim is not enough — it has to have cited
      // something for the claim to mean anything.
      if (reading.verified && hasEvidence) verifiedWeight += weight;
    }

    return {
      dimension: r.dimension,
      label: r.label,
      weight,
      raw_score: raw,
      // Filled in below, once the denominator is known.
      weighted_score: 0,
      rationale: answered
        ? reading.rationale
        : "The model returned no assessment for this dimension; it is excluded from the score.",
      evidence,
      verified: Boolean(answered && reading.verified && hasEvidence),
      answered,
      capped: wasCapped,
      is_veto: Boolean(r.is_veto),
      raw_spread: answered ? Number(reading.spread ?? 0) : null,
      sort_order: r.sort_order ?? i,
    };
  });

  const denominator = answeredWeight || 1;
  for (const row of rows) {
    row.weighted_score = row.answered
      ? Number(((row.raw_score * row.weight) / denominator).toFixed(2))
      : 0;
  }

  const score = Number(rows.reduce((s, r) => s + r.weighted_score, 0).toFixed(2));
  const coverage = totalWeight ? Number(((answeredWeight / totalWeight) * 100).toFixed(1)) : 0;
  const verifiedRatio = answeredWeight
    ? Number(((verifiedWeight / answeredWeight) * 100).toFixed(1))
    : 0;

  // Veto: an explicit flag on the rubric row, so renaming or reordering the
  // dimension cannot quietly remove the gate.
  const vetoRows = rubric.filter((r) => r.is_veto);
  const triggered = vetoRows.filter((r) => {
    const reading = readings.get(r.dimension);
    if (!reading) return false;
    const threshold = Number(r.veto_below ?? 0);
    return clamp(Number(reading.raw_score)) <= threshold;
  });

  const band = bandFor(score, bands);
  const vetoed = triggered.length > 0;

  return {
    rows,
    score,
    coverage,
    grade: band.grade as FitGrade,
    verdict: vetoed ? "decline" : band.verdict,
    evidence_count: evidenceCount,
    verified_ratio: verifiedRatio,
    veto: {
      // No active veto dimension is a fact worth surfacing: it means nothing
      // can decline a prospect on risk alone.
      configured: vetoRows.length > 0,
      triggered: triggered.map((r) => r.dimension),
    },
    integrity: {
      dimensions_skipped: skipped,
      dimensions_capped: capped,
    },
  };
}

/* ------------------------------- confidence ------------------------------- */

/**
 * How much the analysis should be trusted, derived from what can be measured.
 *
 * The model reports its own confidence, and a model's self-assessment is the
 * least reliable number in the response — it has no way to know whether the
 * website fetch succeeded, whether the samples agreed, or how much of the
 * rubric it covered. So the measurable signals set a ceiling, and the model may
 * only lower it from there.
 */
export function computeConfidence(input: {
  modelConfidence: number | null;
  coverage: number;
  verifiedRatio: number;
  agreement: number;
  siteReachable: boolean;
  evidenceCount: number;
  dimensionCount: number;
}): { confidence: number; basis: Record<string, number | boolean> } {
  const coverage = clamp(input.coverage);
  const verified = clamp(input.verifiedRatio);
  const agreement = clamp(input.agreement);

  // Evidence density, expressed as a fraction of "two citations per dimension",
  // which is the point past which more citations stop telling us much.
  const target = Math.max(1, input.dimensionCount * 2);
  const density = clamp((input.evidenceCount / target) * 100);

  const ceiling = coverage * 0.3 + verified * 0.25 + agreement * 0.25 + density * 0.2;

  // An unreachable website means every claim rests on the prospect's own word.
  const siteCap = input.siteReachable ? 100 : 45;

  const model = input.modelConfidence === null ? 100 : clamp(input.modelConfidence);
  const confidence = Math.round(Math.min(ceiling, siteCap, model));

  return {
    confidence,
    basis: {
      coverage,
      verified_ratio: verified,
      sample_agreement: agreement,
      evidence_density: Math.round(density),
      site_reachable: input.siteReachable,
      model_self_report: input.modelConfidence === null ? -1 : clamp(input.modelConfidence),
      signal_ceiling: Math.round(ceiling),
    },
  };
}

/**
 * How much the independent samples agreed, as 0-100.
 *
 * A spread of 40 points on a 0-100 dimension is treated as total disagreement;
 * anything wider is not more informative than that.
 */
export function agreementFrom(spreads: number[]): number {
  if (!spreads.length) return 100;
  const mean = spreads.reduce((s, v) => s + v, 0) / spreads.length;
  return Math.round(clamp(100 - (mean / 40) * 100));
}

/* ---------------------------- corpus validation --------------------------- */

export type CorpusSlugs = {
  modules: Set<string>;
  plans: Set<string>;
  setup_packages: Set<string>;
};

export function corpusSlugs(corpus: {
  modules?: { slug?: string }[];
  plans?: { slug?: string }[];
  setup_packages?: { slug?: string }[];
}): CorpusSlugs {
  const collect = (rows?: { slug?: string }[]) =>
    new Set((rows ?? []).map((r) => String(r?.slug ?? "").trim()).filter(Boolean));
  return {
    modules: collect(corpus.modules),
    plans: collect(corpus.plans),
    setup_packages: collect(corpus.setup_packages),
  };
}

/**
 * Strips capabilities Aurixa does not sell.
 *
 * The prompt forbids inventing them, but a forbidden thing that nothing checks
 * is a suggestion. An invented module slug in a recommendation reaches an
 * operator as a promise to a client, so anything not in the corpus is removed
 * and recorded rather than passed on.
 */
export function validateAgainstCorpus(
  parsed: Record<string, any>,
  slugs: CorpusSlugs,
): { plan: Record<string, any>; correlation: any[]; hallucinated: string[] } {
  const hallucinated: string[] = [];
  const keep = (slug: unknown, set: Set<string>, kind: string): string | null => {
    const value = String(slug ?? "").trim();
    if (!value) return null;
    if (set.has(value)) return value;
    hallucinated.push(`${kind}:${value}`);
    return null;
  };

  const rawPlan = (parsed.recommended_plan ?? {}) as Record<string, any>;
  const plan: Record<string, any> = {
    ...rawPlan,
    plan_slug: keep(rawPlan.plan_slug, slugs.plans, "plan"),
    setup_package_slug: keep(rawPlan.setup_package_slug, slugs.setup_packages, "setup_package"),
    addon_module_slugs: (Array.isArray(rawPlan.addon_module_slugs)
      ? rawPlan.addon_module_slugs
      : []
    )
      .map((s: unknown) => keep(s, slugs.modules, "module"))
      .filter(Boolean),
  };

  const correlation = (Array.isArray(parsed.correlation_map) ? parsed.correlation_map : []).map(
    (row: any) => {
      const slug = keep(row?.module_slug, slugs.modules, "module");
      // A pain point mapped to a module we do not sell is not a mapping. Keep
      // the pain point — it is real, and belongs in the discovery call.
      return slug ? { ...row, module_slug: slug } : { ...row, module_slug: null, unmapped: true };
    },
  );

  return { plan, correlation, hallucinated: [...new Set(hallucinated)] };
}

/* ------------------------------ response parse ---------------------------- */

export function parseAiJson(content: string): Record<string, any> {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("ai_response_not_json");
    return JSON.parse(match[0]);
  }
}

/* ---------------------------------- run ----------------------------------- */

export async function runFitEngine(opts: {
  sb: SupabaseClient<any>;
  analysisId: string;
  subject: Record<string, unknown>;
  website: string | null;
  model?: string;
  userId?: string | null;
  samples?: number;
}) {
  const { sb, analysisId } = opts;
  await sb.from("crm_fit_analyses").update({ status: "running" }).eq("id", analysisId);

  try {
    const [corpus, rubricRes, bandsRes, knowledgeRes, site] = await Promise.all([
      buildCapabilityCorpus(sb),
      sb.from("crm_fit_rubric").select("*").eq("active", true).order("sort_order"),
      sb
        .from("crm_fit_bands")
        .select("*")
        .eq("active", true)
        .order("min_score", { ascending: false }),
      sb
        .from("crm_fit_knowledge")
        .select("id, title, kind, content, summary, tags, pinned")
        .eq("active", true),
      fetchSiteSnapshot(opts.website),
    ]);
    const rubric = (rubricRes.data ?? []) as RubricRow[];
    if (!rubric.length) throw new Error("fit_rubric_empty");
    const bands = (bandsRes.data ?? []).length ? (bandsRes.data as FitBand[]) : FALLBACK_BANDS;

    const subjectText = `${JSON.stringify(opts.subject)} ${site.title ?? ""} ${site.text ?? ""}`;
    const { selected: knowledge, skipped: knowledgeSkipped } = selectKnowledge(
      (knowledgeRes.data ?? []) as KnowledgeEntry[],
      subjectText,
    );

    const model = opts.model ?? "google/gemini-3.6-flash";
    const sampleCount = Math.max(1, Math.min(5, opts.samples ?? DEFAULT_SAMPLES));
    const prompt = buildPrompt({ subject: opts.subject, site, corpus, rubric, knowledge });

    // Independent passes. One is an opinion; the median of several is a
    // reading, and how far they spread is itself a signal.
    const settled = await Promise.allSettled(
      Array.from({ length: sampleCount }, () =>
        callAi({
          feature: "client_fit_analysis",
          model,
          json: true,
          system:
            "You are a rigorous B2B solution-fit analyst. You never fabricate capabilities or evidence. You output strict JSON only.",
          prompt,
          userId: opts.userId ?? null,
          supabase: sb,
        }),
      ),
    );

    const parsedSamples: Record<string, any>[] = [];
    let tokens = 0;
    let failedSamples = 0;
    for (const result of settled) {
      if (result.status !== "fulfilled") {
        failedSamples += 1;
        continue;
      }
      tokens += result.value.tokens || 0;
      try {
        parsedSamples.push(parseAiJson(result.value.content));
      } catch {
        failedSamples += 1;
      }
    }
    if (!parsedSamples.length) throw new Error("ai_response_not_json");

    const readings = reconcileSamples(
      parsedSamples.map((p) => (Array.isArray(p.dimensions) ? p.dimensions : [])),
    );
    const scored = scoreAnalysis(rubric, readings, bands);

    // Narrative comes from a single sample rather than a merge — spliced prose
    // reads like nobody wrote it. The representative sample is the one whose
    // dimension scores sit closest to the reconciled medians.
    const representative = pickRepresentative(parsedSamples, readings);

    const slugs = corpusSlugs(corpus);
    const { plan, correlation, hallucinated } = validateAgainstCorpus(representative, slugs);

    const spreads = scored.rows
      .filter((r) => r.answered && r.raw_spread !== null)
      .map((r) => Number(r.raw_spread));
    const agreement = parsedSamples.length > 1 ? agreementFrom(spreads) : 100;

    const modelConfidences = parsedSamples
      .map((p) => Number(p.confidence))
      .filter((n) => Number.isFinite(n));
    const { confidence, basis } = computeConfidence({
      modelConfidence: modelConfidences.length ? median(modelConfidences) : null,
      coverage: scored.coverage,
      verifiedRatio: scored.verified_ratio,
      agreement,
      siteReachable: site.reachable,
      evidenceCount: scored.evidence_count,
      dimensionCount: rubric.length,
    });

    await sb.from("crm_fit_dimension_scores").delete().eq("analysis_id", analysisId);
    await sb
      .from("crm_fit_dimension_scores")
      .insert(scored.rows.map((r) => ({ analysis_id: analysisId, ...r })));

    await sb
      .from("crm_fit_analyses")
      .update({
        status: "complete",
        score: scored.score,
        grade: scored.grade,
        verdict: scored.verdict,
        confidence,
        coverage: scored.coverage,
        samples: parsedSamples.length,
        agreement,
        evidence_count: scored.evidence_count,
        verified_ratio: scored.verified_ratio,
        confidence_basis: basis,
        integrity: {
          ...scored.integrity,
          hallucinated_slugs: hallucinated,
          veto: scored.veto,
          failed_samples: failedSamples,
          knowledge_entries_used: knowledge.length,
          knowledge_entries_skipped: knowledgeSkipped,
          site_error: site.error ?? null,
        },
        knowledge_ids: knowledge.map((k) => k.id),
        headline: representative.headline ?? null,
        research_summary: representative.research_summary ?? null,
        correlation_map: correlation,
        recommended_plan: plan,
        risks: representative.risks ?? [],
        open_questions: representative.open_questions ?? [],
        validation: representative.validation ?? [],
        raw_response: { samples: parsedSamples },
        model,
        tokens_used: tokens || null,
        completed_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", analysisId);

    return {
      ok: true,
      score: scored.score,
      grade: scored.grade,
      verdict: scored.verdict,
      confidence,
      coverage: scored.coverage,
      agreement,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sb
      .from("crm_fit_analyses")
      .update({ status: "failed", error: message.slice(0, 500) })
      .eq("id", analysisId);
    return { ok: false, error: message };
  }
}

/** The sample whose dimension scores sit closest to the reconciled medians. */
export function pickRepresentative(
  samples: Record<string, any>[],
  readings: Map<string, { raw_score: number }>,
): Record<string, any> {
  if (samples.length <= 1) return samples[0] ?? {};
  let best = samples[0];
  let bestDistance = Infinity;
  for (const sample of samples) {
    const dims = Array.isArray(sample.dimensions) ? sample.dimensions : [];
    let distance = 0;
    let counted = 0;
    for (const dim of dims) {
      const reading = readings.get(String(dim?.dimension));
      const score = Number(dim?.raw_score);
      if (!reading || !Number.isFinite(score)) continue;
      distance += Math.abs(score - reading.raw_score);
      counted += 1;
    }
    // A sample that answered nothing we recognise is not representative of
    // anything, however small its distance.
    const normalised = counted ? distance / counted : Infinity;
    if (normalised < bestDistance) {
      bestDistance = normalised;
      best = sample;
    }
  }
  return best;
}
