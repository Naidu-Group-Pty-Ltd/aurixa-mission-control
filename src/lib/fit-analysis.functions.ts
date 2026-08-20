// @ts-nocheck
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
// Client Fit Analysis — server functions.
//
// A fit analysis is an immutable, versioned record. Re-running never mutates
// a prior report; it inserts version N+1 so the decision trail survives.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator, requireAdmin } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

const VERDICTS = ["strong_fit", "fit", "conditional", "poor_fit", "decline"] as const;

/** Verdicts that clear a deal to advance to contract/SLA. */
export const PASSING_VERDICTS = ["strong_fit", "fit", "conditional"] as const;
export const FIT_STALE_DAYS = 90;

export const FIT_GRADE_LABELS: Record<string, string> = {
  A: "Excellent fit",
  B: "Good fit",
  C: "Conditional fit",
  D: "Weak fit",
  F: "Not a fit",
};

export const FIT_VERDICT_LABELS: Record<string, string> = {
  strong_fit: "Strong fit",
  fit: "Fit",
  conditional: "Conditional",
  poor_fit: "Poor fit",
  decline: "Decline",
};

/**
 * What the analyst is told about a waitlist lead.
 *
 * The priority-access funnel collects this in three sittings, and only the
 * first was reaching the engine. Stage 2 — the Business Readiness Questionnaire
 * — is by some distance the most substantial qualification data the business
 * holds: the systems they run, what they need integrated, how much data has to
 * migrate, their security and procurement requirements, and the budget they
 * have approved. Scoring commercial and technical fit without it was guesswork
 * dressed as analysis.
 *
 * Claims are labelled by where they came from and how far the applicant got, so
 * the analyst can weigh a considered Stage 2 answer differently from a
 * sixty-second Stage 1 form.
 */
export function buildLeadSubject(
  lead: Record<string, any>,
  operatorNotes?: string | null,
): Record<string, unknown> {
  const stageReached = Number(lead.stage ?? 1);

  const stageTwo =
    lead.stage2_completed_at || lead.stage2_next_step || lead.stage2_summary
      ? {
          completed_at: lead.stage2_completed_at,
          status: lead.stage2_status,
          preferred_next_step: lead.stage2_next_step,
          approved_investment_range: lead.stage2_investment,
          implementation_timeline: lead.stage2_timeline,
          // The applicant's own account of their operation, in their words.
          summary: lead.stage2_summary,
          answers:
            lead.stage2_answers && Object.keys(lead.stage2_answers).length
              ? lead.stage2_answers
              : undefined,
        }
      : null;

  const stageThree = lead.stage3_booked_at
    ? {
        booked_at: lead.stage3_booked_at,
        status: lead.stage3_status,
        session_start: lead.stage3_session_start,
        applicant_time_zone: lead.stage3_time_zone,
      }
    : null;

  return {
    // ── Stage 1: the priority access application ──
    application_id: lead.application_id,
    entity_name: lead.entity_name,
    entity_classification: lead.entity_classification,
    contact_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
    contact_role: lead.role,
    email: lead.email,
    mobile_number: lead.mobile_number,
    annual_transaction_volume: lead.transaction_volume,
    current_tech_stack_bottlenecks: lead.tech_stack_bottlenecks,
    priority_areas_to_improve: (lead.primary_areas ?? []).length ? lead.primary_areas : undefined,
    applicant_additional_notes: lead.additional_notes,
    form_version: lead.form_version,
    submitted_at: lead.submitted_at,

    // ── Stage 2 and 3: how far they have actually come ──
    funnel_stage_reached: stageReached,
    readiness_questionnaire: stageTwo,
    strategic_review_booking: stageThree,

    // ── Provenance ──
    // How they found us is a genuine fit signal: a referral and a cold ad click
    // are not the same prospect, and the analyst should be able to say so.
    source: lead.source,
    page: lead.page,
    attribution: {
      landing_page: lead.landing_page,
      referrer: lead.referrer,
      utm_source: lead.utm_source,
      utm_medium: lead.utm_medium,
      utm_campaign: lead.utm_campaign,
    },
    marketing_consent: lead.marketing_consent,

    // ── Ours, not theirs ──
    operator_notes: [lead.notes, operatorNotes].filter(Boolean).join("\n") || undefined,
    airtable_status: lead.airtable_status,
  };
}

/* -------------------------------- reading --------------------------------- */

export const listFitAnalyses = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["all", "queued", "running", "complete", "failed"]).default("all"),
        verdict: z.enum(["all", ...VERDICTS]).default("all"),
        search: z.string().max(200).default(""),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_fit_analyses")
      .select(
        "id, account_id, lead_id, subject_name, subject_email, subject_website, version, status, score, grade, verdict, override_verdict, confidence, coverage, agreement, samples, verified_ratio, evidence_count, integrity, headline, model, error, completed_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.verdict !== "all") q = q.eq("verdict", data.verdict);
    if (data.search.trim()) q = q.ilike("subject_name", `%${data.search.trim()}%`);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const getFitAnalysis = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const [analysis, dimensions] = await Promise.all([
      sb.from("crm_fit_analyses").select("*").eq("id", data.id).maybeSingle(),
      sb
        .from("crm_fit_dimension_scores")
        .select("*")
        .eq("analysis_id", data.id)
        .order("sort_order"),
    ]);
    if (analysis.error) throw analysis.error;
    if (!analysis.data) throw new Error("fit_analysis_not_found");
    return { analysis: analysis.data, dimensions: dimensions.data ?? [] };
  });

/** Every analysis for one subject, newest first — powers the account "Fit" tab. */
export const getFitHistory = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({ accountId: uuid.optional(), leadId: uuid.optional() })
      .refine((v) => v.accountId || v.leadId, "subject_required")
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_fit_analyses")
      .select("*")
      .order("version", { ascending: false })
      .limit(20);
    q = data.accountId ? q.eq("account_id", data.accountId) : q.eq("lead_id", data.leadId);
    const { data: rows, error } = await q;
    if (error) throw error;
    const latest = rows?.[0];
    let dimensions: any[] = [];
    if (latest) {
      const { data: dims } = await context.supabase
        .from("crm_fit_dimension_scores")
        .select("*")
        .eq("analysis_id", latest.id)
        .order("sort_order");
      dimensions = dims ?? [];
    }
    return { history: rows ?? [], latest: latest ?? null, dimensions };
  });

export const getFitRubric = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("crm_fit_rubric").select("*").order("sort_order");
    return data ?? [];
  });

export const updateFitRubric = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        rows: z
          .array(
            z.object({
              id: uuid,
              weight: z.number().min(0).max(100),
              active: z.boolean().optional(),
            }),
          )
          .max(20),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    for (const row of data.rows) {
      const { error } = await context.supabase
        .from("crm_fit_rubric")
        .update({ weight: row.weight, ...(row.active === undefined ? {} : { active: row.active }) })
        .eq("id", row.id);
      if (error) throw error;
    }
    return { ok: true };
  });

/* -------------------------------- running ---------------------------------- */

export const runFitAnalysis = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        accountId: uuid.optional(),
        leadId: uuid.optional(),
        websiteOverride: z.string().max(300).optional(),
        notes: z.string().max(2000).optional(),
        // Independent scoring passes. Each is a separate model call, so this is
        // the accuracy/cost dial: 3 is the default because the median of three
        // is materially steadier than one opinion, 1 is the cheap check, and 5
        // is for a decision worth the spend.
        samples: z.number().int().min(1).max(5).optional(),
      })
      .refine((v) => v.accountId || v.leadId, "subject_required")
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { candidateWebsite, runFitEngine } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/fit-analysis.server"
    );

    let subject: Record<string, unknown> = {};
    let subjectName = "";
    let subjectEmail: string | null = null;
    let websiteHint: string | null = null;

    if (data.accountId) {
      const { data: account, error } = await sb
        .from("crm_accounts")
        .select("*, crm_contacts(first_name, last_name, email, phone, is_primary)")
        .eq("id", data.accountId)
        .maybeSingle();
      if (error) throw error;
      if (!account) throw new Error("account_not_found");
      const primary =
        (account.crm_contacts ?? []).find((c: any) => c.is_primary) ?? account.crm_contacts?.[0];
      subjectName = account.name;
      subjectEmail = primary?.email ?? null;
      websiteHint = account.website ?? null;
      // An account converted from the waitlist still has the funnel behind it.
      // Re-analysing without the questionnaire the client filled in would throw
      // away the best evidence we hold about them.
      const { data: originLead } = await sb
        .from("waitlist_leads")
        .select("*")
        .eq("account_id", data.accountId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      subject = {
        entity_name: account.name,
        entity_classification: account.classification,
        lifecycle_stage: account.lifecycle_stage,
        website: account.website,
        tags: account.tags,
        notes: [account.notes, data.notes].filter(Boolean).join("\n"),
        mrr_cents: account.mrr_cents,
        arr_cents: account.arr_cents,
        primary_contact: primary
          ? {
              name: `${primary.first_name ?? ""} ${primary.last_name ?? ""}`.trim(),
              email: primary.email,
              phone: primary.phone,
            }
          : null,
        ...(originLead ? { origin_application: buildLeadSubject(originLead) } : {}),
      };
    } else {
      const { data: lead, error } = await sb
        .from("waitlist_leads")
        .select("*")
        .eq("id", data.leadId)
        .maybeSingle();
      if (error) throw error;
      if (!lead) throw new Error("lead_not_found");
      subjectName = lead.entity_name || `${lead.first_name} ${lead.last_name}`.trim();
      subjectEmail = lead.email;
      subject = buildLeadSubject(lead, data.notes);
    }

    const website =
      (data.websiteOverride?.trim()
        ? data.websiteOverride.trim().startsWith("http")
          ? data.websiteOverride.trim()
          : `https://${data.websiteOverride.trim()}`
        : null) ?? candidateWebsite({ website: websiteHint, email: subjectEmail });

    // Version = prior count + 1 for this subject.
    const countQ = sb.from("crm_fit_analyses").select("id", { count: "exact", head: true });
    const { count } = await (data.accountId
      ? countQ.eq("account_id", data.accountId)
      : countQ.eq("lead_id", data.leadId));

    const { data: created, error: insertError } = await sb
      .from("crm_fit_analyses")
      .insert({
        account_id: data.accountId ?? null,
        lead_id: data.leadId ?? null,
        subject_name: subjectName,
        subject_email: subjectEmail,
        subject_website: website,
        version: (count ?? 0) + 1,
        status: "queued",
        input_snapshot: subject,
        requested_by: context.userId,
      })
      .select("id, version")
      .single();
    if (insertError) throw insertError;

    const result = await runFitEngine({
      sb,
      analysisId: created.id,
      subject,
      website,
      userId: context.userId,
      samples: data.samples,
    });

    if (data.accountId) {
      // `crm_activities` has `title` (NOT NULL) and `actor_user_id`. This wrote
      // `subject` and `created_by`, so every account analysis lost its timeline
      // entry to a not-null violation nobody was checking for.
      const { error: activityError } = await sb.from("crm_activities").insert({
        account_id: data.accountId,
        kind: "system",
        title: `Client fit analysis v${created.version}`,
        body: result.ok
          ? [
              `Score ${result.score}/100 · Grade ${result.grade} · ${result.verdict}`,
              `Confidence ${result.confidence}% · coverage ${result.coverage}% · sample agreement ${result.agreement}%`,
            ].join("\n")
          : `Analysis failed: ${result.error}`,
        actor_user_id: context.userId,
        entity_type: "crm_fit_analysis",
        entity_id: created.id,
        metadata: { version: created.version, ok: result.ok },
      });
      // The analysis itself is stored and returned either way — a missing
      // timeline entry is worth logging, not worth failing the run over.
      if (activityError) console.error("fit analysis activity insert failed", activityError);
    }

    return { id: created.id, version: created.version, ...result };
  });

export const overrideFitVerdict = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        verdict: z.enum(VERDICTS),
        reason: z.string().min(5).max(2000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("crm_fit_analyses")
      .update({
        override_verdict: data.verdict,
        override_reason: data.reason,
        override_by: context.userId,
        override_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/* ------------------------------- deal gating ------------------------------- */

/**
 * Gate check used before a deal advances to contract/SLA. Returns whether a
 * fresh, passing analysis exists for the account.
 */
export const checkFitGate = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ accountId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("crm_fit_analyses")
      .select("id, score, grade, verdict, override_verdict, status, completed_at, version")
      .eq("account_id", data.accountId)
      .eq("status", "complete")
      .order("version", { ascending: false })
      .limit(1);
    const latest = rows?.[0];
    if (!latest) return { allowed: false, reason: "no_analysis", latest: null };

    const effective = latest.override_verdict ?? latest.verdict;
    const ageDays = latest.completed_at
      ? (Date.now() - new Date(latest.completed_at).getTime()) / 86_400_000
      : Infinity;
    if (ageDays > FIT_STALE_DAYS) return { allowed: false, reason: "stale", latest };
    if (!PASSING_VERDICTS.includes(effective as any))
      return { allowed: false, reason: "failed_verdict", latest };
    return { allowed: true, reason: "ok", latest };
  });
