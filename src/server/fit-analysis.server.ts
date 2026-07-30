// @ts-nocheck
// Client Fit Analysis engine.
//
// Cross-examines a lead / account against what Aurixa Systems actually sells
// (read live from the pricing catalog — never hardcoded), asks the AI gateway
// for per-dimension scores + evidence, then computes the weighted total in
// code so the score can never drift from the rubric.
import type { SupabaseClient } from "@supabase/supabase-js";
import { callAi } from "./ai-gateway.server";

export const FIT_STALE_DAYS = 90;

export type FitGrade = "A" | "B" | "C" | "D" | "F";

export function gradeFor(score: number): FitGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function verdictFor(score: number, riskScore: number): string {
  if (riskScore <= 25) return "decline";
  if (score >= 85) return "strong_fit";
  if (score >= 70) return "fit";
  if (score >= 55) return "conditional";
  if (score >= 40) return "poor_fit";
  return "decline";
}

/* --------------------------- capability corpus ---------------------------- */

export async function buildCapabilityCorpus(sb: SupabaseClient<any>) {
  const [modules, plans, roles, packages] = await Promise.all([
    sb
      .from("addon_modules")
      .select("slug, name, category, description, price_min_cents, price_max_cents, included_in_plans")
      .eq("is_active", true)
      .order("sort_order"),
    sb
      .from("seat_plans")
      .select("slug, name, description, seat_limit, device_limit_per_seat, price_cents, overage_policy")
      .eq("is_active", true),
    sb
      .from("seat_roles")
      .select("slug, name, description, price_min_cents, price_max_cents")
      .eq("is_active", true)
      .order("sort_order"),
    sb
      .from("setup_packages")
      .select("slug, name, description, price_min_cents, price_max_cents, applies_to_plans, deliverables")
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
  site: { url: string | null; reachable: boolean; title: string | null; text: string | null; error?: string };
  corpus: Awaited<ReturnType<typeof buildCapabilityCorpus>>;
  rubric: { dimension: string; label: string; description: string | null; weight: number }[];
}) {
  const dims = args.rubric
    .map((r) => `- ${r.dimension} (${r.label}, weight ${r.weight}): ${r.description ?? ""}`)
    .join("\n");

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

## SCORING DIMENSIONS
${dims}

## RULES
- Score each dimension 0-100 on its own merit. Do NOT compute a weighted total; that is done downstream.
- For "risk", 100 means no red flags and 0 means disqualifying risk.
- Every dimension needs at least one evidence item. Evidence must quote or cite the prospect
  submission or the website copy. If you have neither, say so and set verified=false.
- Never invent modules, plans, prices or capabilities that are not in the capability corpus.
- Recommend only slugs that exist in the corpus.
- Be blunt about poor fits. A high score with no verifiable evidence is a failure.

## OUTPUT — strict JSON, no markdown fences
{
  "headline": "one sentence verdict",
  "research_summary": "2-4 paragraphs: what this business actually does, size signals, verified vs claimed",
  "confidence": 0-100,
  "dimensions": [
    { "dimension": "problem_solution", "raw_score": 0-100, "rationale": "...", "verified": true,
      "evidence": [{ "source": "submission|website", "quote": "...", "note": "..." }] }
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

/* --------------------------------- scoring -------------------------------- */

export function scoreAnalysis(
  rubric: { dimension: string; label: string; weight: number; sort_order?: number }[],
  aiDimensions: { dimension: string; raw_score?: number; rationale?: string; verified?: boolean; evidence?: unknown }[],
) {
  const byDim = new Map(aiDimensions.map((d) => [d.dimension, d]));
  const totalWeight = rubric.reduce((s, r) => s + Number(r.weight || 0), 0) || 1;

  const rows = rubric.map((r, i) => {
    const ai = byDim.get(r.dimension);
    const raw = Math.max(0, Math.min(100, Number(ai?.raw_score ?? 0)));
    return {
      dimension: r.dimension,
      label: r.label,
      weight: Number(r.weight),
      raw_score: raw,
      weighted_score: Number(((raw * Number(r.weight)) / totalWeight).toFixed(2)),
      rationale: ai?.rationale ?? "No assessment returned for this dimension.",
      evidence: Array.isArray(ai?.evidence) ? ai!.evidence : [],
      verified: Boolean(ai?.verified),
      sort_order: r.sort_order ?? i,
    };
  });

  const score = Number(rows.reduce((s, r) => s + r.weighted_score, 0).toFixed(2));
  const risk = rows.find((r) => r.dimension === "risk")?.raw_score ?? 100;
  return { rows, score, grade: gradeFor(score), verdict: verdictFor(score, risk) };
}

/* ---------------------------------- run ----------------------------------- */

export async function runFitEngine(opts: {
  sb: SupabaseClient<any>;
  analysisId: string;
  subject: Record<string, unknown>;
  website: string | null;
  model?: string;
  userId?: string | null;
}) {
  const { sb, analysisId } = opts;
  await sb.from("crm_fit_analyses").update({ status: "running" }).eq("id", analysisId);

  try {
    const [corpus, rubricRes, site] = await Promise.all([
      buildCapabilityCorpus(sb),
      sb.from("crm_fit_rubric").select("*").eq("active", true).order("sort_order"),
      fetchSiteSnapshot(opts.website),
    ]);
    const rubric = rubricRes.data ?? [];
    if (!rubric.length) throw new Error("fit_rubric_empty");

    const model = opts.model ?? "google/gemini-3.6-flash";
    const { content, tokens } = await callAi({
      feature: "client_fit_analysis",
      model,
      json: true,
      system:
        "You are a rigorous B2B solution-fit analyst. You never fabricate capabilities or evidence. You output strict JSON only.",
      prompt: buildPrompt({ subject: opts.subject, site, corpus, rubric }),
      userId: opts.userId ?? null,
      supabase: sb,
    });

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("ai_response_not_json");
      parsed = JSON.parse(m[0]);
    }

    const { rows, score, grade, verdict } = scoreAnalysis(rubric, parsed.dimensions ?? []);

    // Unreachable site caps confidence — an unverified high score must look unverified.
    let confidence = Math.max(0, Math.min(100, Number(parsed.confidence ?? 50)));
    if (!site.reachable) confidence = Math.min(confidence, 45);

    await sb.from("crm_fit_dimension_scores").delete().eq("analysis_id", analysisId);
    await sb.from("crm_fit_dimension_scores").insert(
      rows.map((r) => ({ analysis_id: analysisId, ...r })),
    );

    await sb
      .from("crm_fit_analyses")
      .update({
        status: "complete",
        score,
        grade,
        verdict,
        confidence,
        headline: parsed.headline ?? null,
        research_summary: parsed.research_summary ?? null,
        correlation_map: parsed.correlation_map ?? [],
        recommended_plan: parsed.recommended_plan ?? {},
        risks: parsed.risks ?? [],
        open_questions: parsed.open_questions ?? [],
        validation: parsed.validation ?? [],
        raw_response: parsed,
        model,
        tokens_used: tokens || null,
        completed_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", analysisId);

    return { ok: true, score, grade, verdict, confidence };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sb
      .from("crm_fit_analyses")
      .update({ status: "failed", error: message.slice(0, 500) })
      .eq("id", analysisId);
    return { ok: false, error: message };
  }
}
