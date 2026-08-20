// Product feedback: serving the form, recording the answer, paying for it,
// and forwarding it to Make.com.
//
// The grant rule — 100 credits per WORKSPACE per campaign, however many people
// answer — lives in the database, not here. `submit_feedback` records the
// submission and attempts the grant in one transaction, and a UNIQUE
// constraint on (tenant, campaign) is what stops the second person earning it
// again. Doing that check in TypeScript would be a read-then-write, and two
// colleagues pressing submit together would both read "not yet granted".
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { planForTenant } from "@/server/current-plan.server";
import {
  buildFeedbackForm,
  sanitiseRatings,
  scoreOrNull,
  textOrNull,
  type FeedbackForm,
} from "@/lib/feedback/feedback-form";

const adminAny = supabaseAdmin;

/** Credits a workspace earns for answering. One award per campaign. */
export const FEEDBACK_REWARD_TOKENS = 100;

export type PromptState = {
  /** Whether to ASK. Workspace-level, so a team is not nagged repeatedly. */
  due: boolean;
  /**
   * Whether THIS PERSON has already had their say. What the form gates on —
   * `due` is the wrong question there, because many people may answer and only
   * the reward is once.
   */
  youAnswered: boolean;
  workspaceAnswered: boolean;
  campaignKey: string;
  reason: "onboarding" | "quarterly";
  /** False once someone in this workspace has already claimed the credits. */
  rewardAvailable: boolean;
  rewardTokens: number;
};

/**
 * Should this workspace be asked right now?
 *
 * Mission Control answers rather than each front end deciding, so every clone
 * inherits the same cadence — first 30 days, then quarterly — without the rule
 * being copied into code that ships separately and drifts.
 */
/** `module_ratings` is jsonb; keep only the numeric entries. */
function toRatingMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

export async function promptState(
  tenantId: string,
  originUserId?: string | null,
): Promise<PromptState | null> {
  const { data, error } = await adminAny.rpc("feedback_prompt_due", {
    _tenant_id: tenantId,
    _origin_user_id: originUserId ?? undefined,
  });
  if (error || !data || (data as { ok?: boolean }).ok === false) return null;
  const r = data as Record<string, unknown>;
  return {
    due: r.due === true,
    youAnswered: r.you_answered === true,
    workspaceAnswered: r.workspace_answered === true,
    campaignKey: String(r.campaign_key ?? ""),
    reason: r.reason === "onboarding" ? "onboarding" : "quarterly",
    rewardAvailable: r.reward_available === true,
    rewardTokens: Number(r.reward_tokens ?? FEEDBACK_REWARD_TOKENS),
  };
}

/** The questions this workspace gets asked, from the plan it is actually on. */
export async function formForTenant(tenantId: string): Promise<FeedbackForm> {
  const plan = await planForTenant(tenantId).catch(() => null);
  return buildFeedbackForm({ slug: plan?.slug ?? null, name: plan?.name ?? null });
}

export type SubmitInput = {
  tenantId: string;
  originUserId?: string | null;
  originUsername?: string | null;
  originSource?: string | null;
  overallRating?: unknown;
  recommendScore?: unknown;
  moduleRatings?: unknown;
  mostValuable?: unknown;
  biggestFrustration?: unknown;
  featureRequest?: unknown;
  additionalComments?: unknown;
};

export type SubmitResult = {
  ok: boolean;
  submissionId?: string;
  campaignKey?: string;
  creditsGranted?: number;
  /** True when a colleague already earned this campaign's credits. */
  alreadyGranted?: boolean;
  creditsExpireAt?: string | null;
  error?: string;
};

/**
 * Records a submission and pays for it.
 *
 * Everything the browser sent is re-validated against the form THIS workspace
 * would have been served, not against the form it claims to have filled in.
 * The page is public; a posted rating for a module the workspace does not have
 * would otherwise land a score against a product they have never opened.
 */
export async function submitFeedback(input: SubmitInput): Promise<SubmitResult> {
  try {
    const form = await formForTenant(input.tenantId);

    const payload = {
      origin_user_id: input.originUserId ?? null,
      origin_username: input.originUsername ?? null,
      origin_source: input.originSource ?? null,
      overall_rating: scoreOrNull(input.overallRating, 1, 5),
      recommend_score: scoreOrNull(input.recommendScore, 0, 10),
      module_ratings: sanitiseRatings(input.moduleRatings, form),
      most_valuable: textOrNull(input.mostValuable),
      biggest_frustration: textOrNull(input.biggestFrustration),
      feature_request: textOrNull(input.featureRequest),
      additional_comments: textOrNull(input.additionalComments),
    };

    // Something has to have been said. An empty form submitted for the credits
    // is not feedback, and paying for it teaches exactly the wrong lesson.
    const saidSomething =
      payload.overall_rating !== null ||
      payload.recommend_score !== null ||
      Object.keys(payload.module_ratings).length > 0 ||
      !!payload.most_valuable ||
      !!payload.biggest_frustration ||
      !!payload.feature_request ||
      !!payload.additional_comments;
    if (!saidSomething) return { ok: false, error: "empty_submission" };

    const { data, error } = await adminAny.rpc("submit_feedback", {
      _tenant_id: input.tenantId,
      _payload: payload,
    });
    if (error) return { ok: false, error: error.message };

    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === false) return { ok: false, error: String(r.error ?? "submit_failed") };

    return {
      ok: true,
      submissionId: typeof r.submission_id === "string" ? r.submission_id : undefined,
      campaignKey: typeof r.campaign_key === "string" ? r.campaign_key : undefined,
      creditsGranted: Number(r.credits_granted ?? 0),
      alreadyGranted: r.already_granted === true,
      creditsExpireAt: (r.credits_expire_at as string | null) ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ships a submission to the Make.com webhook, which files it in Airtable.
 *
 * Deliberately AFTER the submission is already saved and the credits already
 * granted. Make is a downstream reporting destination, not the system of
 * record — if it is unreachable the customer has still given feedback and
 * still earned their credits, and the row here can be replayed. Reversing that
 * order would let an outage at Make cost a customer their reward.
 */
export async function forwardToMake(
  submissionId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.FEEDBACK_MAKE_WEBHOOK_URL;
  if (!url) {
    // Not configured is not a failure — it is a deployment that has not wired
    // Make up yet. Recorded so it is visible rather than looking delivered.
    await mark(submissionId, false, "make_webhook_not_configured");
    return { ok: false, error: "make_webhook_not_configured" };
  }

  // A Make webhook URL is a bearer credential in a query string: it travels
  // through browsers' address bars, scenario exports and support threads, and
  // it never expires. Anyone holding one can post whatever they like into
  // Airtable. Signing the body means the scenario can tell our submissions
  // apart from someone else's, and the same mechanism and header name as
  // token-webhooks.server.ts so there is one thing to learn, not two.
  const serialised = JSON.stringify(body);
  const secret = process.env.FEEDBACK_MAKE_WEBHOOK_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Constant across every retry of the same submission, so the scenario can
    // drop a duplicate without inferring a key from the payload.
    "x-mc-idempotency-key": submissionId,
    "x-mc-event": "feedback.submitted",
  };
  if (secret) {
    headers["x-mc-signature"] = crypto
      .createHmac("sha256", secret)
      .update(serialised)
      .digest("hex");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: serialised,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      await mark(submissionId, false, `make_http_${res.status}: ${text}`);
      return { ok: false, error: `make_http_${res.status}` };
    }
    await mark(submissionId, true);
    return { ok: true };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const msg = aborted ? "make_timeout" : err instanceof Error ? err.message : String(err);
    await mark(submissionId, false, msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function mark(submissionId: string, ok: boolean, error?: string): Promise<void> {
  try {
    await adminAny.rpc("mark_feedback_forwarded", {
      _submission_id: submissionId,
      _ok: ok,
      _error: error ?? undefined,
    });
  } catch (err) {
    console.warn("[feedback] could not record delivery state", err);
  }
}

/**
 * The shape Make.com receives — flat, stable, and named for people rather than
 * for our schema, because the other end of this is an Airtable column that a
 * human reads.
 *
 * Module ratings are sent BOTH as an object and as a pre-rendered summary
 * line. Airtable has no good column type for an arbitrary key-value map, and
 * asking Make to build that string means the formatting lives in a scenario
 * nobody can review.
 */
/**
 * Build and send one submission's payload to Make.
 *
 * The single place delivery happens. Both the live POST and the retry sweep
 * call this, so a replayed row is byte-identical to its first attempt — which
 * is the entire promise of a replay, and the easiest thing to lose by having
 * the sweep assemble its own version.
 */
export async function deliverSubmission(
  submissionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: row } = await adminAny
    .from("feedback_submissions")
    .select(
      "id, campaign_key, tenant_id, clone_id, origin_user_id, origin_username, origin_source, plan_slug, plan_name, overall_rating, recommend_score, module_ratings, most_valuable, biggest_frustration, feature_request, additional_comments, created_at, forward_attempts",
    )
    .eq("id", submissionId)
    .maybeSingle();
  if (!row) return { ok: false, error: "submission_not_found" };

  const [{ data: tenant }, form, { data: grant }] = await Promise.all([
    adminAny
      .from("tenants")
      .select("display_name, external_ref")
      .eq("id", row.tenant_id)
      .maybeSingle(),
    formForTenant(row.tenant_id),
    // Read rather than passed in: on a retry hours later the caller has no
    // idea what was granted, and guessing zero would tell Airtable this
    // response earned nothing when it may have earned the hundred.
    adminAny
      .from("feedback_token_grants")
      .select("tokens")
      .eq("submission_id", submissionId)
      .maybeSingle(),
  ]);

  const labels = Object.fromEntries(form.questions.map((q) => [q.key, q.label]));

  return forwardToMake(
    row.id,
    makePayload({
      submissionId: row.id,
      campaignKey: row.campaign_key,
      tenantId: row.tenant_id,
      tenantRef: tenant?.external_ref ?? null,
      workspaceName: tenant?.display_name ?? null,
      cloneId: row.clone_id,
      originUserId: row.origin_user_id,
      originUsername: row.origin_username,
      originSource: row.origin_source,
      planSlug: row.plan_slug,
      planName: row.plan_name,
      overallRating: row.overall_rating,
      recommendScore: row.recommend_score,
      moduleRatings: toRatingMap(row.module_ratings),
      labels,
      mostValuable: row.most_valuable,
      biggestFrustration: row.biggest_frustration,
      featureRequest: row.feature_request,
      additionalComments: row.additional_comments,
      creditsGranted: Number(grant?.tokens ?? 0),
      submittedAt: row.created_at,
      attempt: Number(row.forward_attempts ?? 0) + 1,
    }),
  );
}

/**
 * Deliver everything the database says is due.
 *
 * Called by the cron hook. Sequential rather than parallel on purpose: this is
 * a backlog being drained after an outage, and firing twenty-five concurrent
 * requests at a service that has just come back up is how a recovery becomes a
 * second outage.
 */
export async function retryPendingForwards(
  limit = 25,
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const { data, error } = await adminAny.rpc("feedback_pending_forward", { _limit: limit });
  if (error || !Array.isArray(data)) return { attempted: 0, delivered: 0, failed: 0 };

  let delivered = 0;
  for (const r of data as Array<{ submission_id: string }>) {
    const result = await deliverSubmission(r.submission_id).catch(() => ({ ok: false }));
    if (result.ok) delivered += 1;
  }
  return { attempted: data.length, delivered, failed: data.length - delivered };
}

/**
 * The shape Make.com receives — flat, stable, and named for people rather than
 * for our schema, because the other end of this is an Airtable column that a
 * human reads.
 */
export function makePayload(args: {
  submissionId: string;
  campaignKey: string;
  tenantId: string;
  tenantRef: string | null;
  workspaceName: string | null;
  cloneId: string | null;
  originUserId: string | null;
  originUsername: string | null;
  originSource: string | null;
  planSlug: string | null;
  planName: string | null;
  overallRating: number | null;
  recommendScore: number | null;
  moduleRatings: Record<string, number>;
  labels: Record<string, string>;
  mostValuable: string | null;
  biggestFrustration: string | null;
  featureRequest: string | null;
  additionalComments: string | null;
  creditsGranted: number;
  submittedAt: string;
  /** 1 on the first try. Lets the scenario tell a replay from a new answer. */
  attempt?: number;
}): Record<string, unknown> {
  const summary = Object.entries(args.moduleRatings)
    .map(([key, score]) => `${args.labels[key] ?? key}: ${score}/5`)
    .sort()
    .join(" · ");

  // Module ratings keyed by the words a person would use rather than by our
  // slugs. The LLM stage in Make reads this: given `{"deal-pipeline": 2}` it
  // has to guess what that product is, and it guesses confidently and wrongly.
  // Given `{"Deal Pipeline": 2}` it does not have to guess at all.
  const labelled: Record<string, number> = {};
  for (const [key, score] of Object.entries(args.moduleRatings)) {
    labelled[args.labels[key] ?? key] = score;
  }

  const scores = Object.values(args.moduleRatings);
  const freeText = [
    args.mostValuable,
    args.biggestFrustration,
    args.featureRequest,
    args.additionalComments,
  ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);

  return {
    // Pinned so the scenario can branch if this shape ever changes, instead of
    // silently mapping absent fields to empty Airtable cells.
    schema_version: 2,
    submission_id: args.submissionId,
    submitted_at: args.submittedAt,
    attempt: args.attempt ?? 1,
    campaign: args.campaignKey,
    workspace_id: args.tenantId,
    workspace_ref: args.tenantRef,
    workspace_name: args.workspaceName,
    clone_id: args.cloneId,
    user_id: args.originUserId,
    user_name: args.originUsername,
    source: args.originSource,
    plan_slug: args.planSlug,
    plan_name: args.planName,
    overall_rating: args.overallRating,
    recommend_score: args.recommendScore,
    module_ratings: args.moduleRatings,
    module_ratings_labelled: labelled,
    module_ratings_summary: summary,
    modules_rated: scores.length,
    // Rounded to one decimal: the difference between 3.67 and 3.7 is not
    // information, and an Airtable column full of 3.6666666666666665 is worse
    // than useless to read.
    module_ratings_average:
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null,
    most_valuable: args.mostValuable,
    biggest_frustration: args.biggestFrustration,
    feature_request: args.featureRequest,
    additional_comments: args.additionalComments,
    // So the scenario can skip the LLM call outright when there is nothing to
    // read. A ratings-only submission is common, and paying for a model to
    // summarise four nulls is money spent to learn nothing.
    has_free_text: freeText.length > 0,
    free_text_chars: freeText.join(" ").length,
    credits_granted: args.creditsGranted,
  };
}
