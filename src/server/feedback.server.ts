// Product feedback: serving the form, recording the answer, paying for it,
// and forwarding it to Make.com.
//
// The grant rule — 100 credits per WORKSPACE per campaign, however many people
// answer — lives in the database, not here. `submit_feedback` records the
// submission and attempts the grant in one transaction, and a UNIQUE
// constraint on (tenant, campaign) is what stops the second person earning it
// again. Doing that check in TypeScript would be a read-then-write, and two
// colleagues pressing submit together would both read "not yet granted".
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { planForTenant } from "@/server/current-plan.server";
import {
  buildFeedbackForm,
  sanitiseRatings,
  scoreOrNull,
  textOrNull,
  type FeedbackForm,
} from "@/lib/feedback/feedback-form";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminAny = supabaseAdmin as any;

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
export async function promptState(
  tenantId: string,
  originUserId?: string | null,
): Promise<PromptState | null> {
  const { data, error } = await adminAny.rpc("feedback_prompt_due", {
    _tenant_id: tenantId,
    _origin_user_id: originUserId ?? null,
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
      _error: error ?? null,
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
}): Record<string, unknown> {
  const summary = Object.entries(args.moduleRatings)
    .map(([key, score]) => `${args.labels[key] ?? key}: ${score}/5`)
    .sort()
    .join(" · ");

  return {
    submission_id: args.submissionId,
    submitted_at: args.submittedAt,
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
    module_ratings_summary: summary,
    most_valuable: args.mostValuable,
    biggest_frustration: args.biggestFrustration,
    feature_request: args.featureRequest,
    additional_comments: args.additionalComments,
    credits_granted: args.creditsGranted,
  };
}
