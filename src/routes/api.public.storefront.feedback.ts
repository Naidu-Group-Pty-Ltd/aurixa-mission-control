// The feedback form on aurixasystems.com.au/feedback.
//
// GET  — the questions THIS workspace should be asked, from the plan it is on.
// POST — the answers, the 100 credits, and the hand-off to Make.com.
//
// Authenticated the same way the pricing page is: possession of a `?h=`
// handoff minted server-to-server by the workspace, or a `?uid=` billing id.
// That is what makes the form work with no login on a marketing site while
// still knowing which workspace — and which person — is answering. Without a
// credential the form is readable but not submittable; there is nowhere to
// credit and nobody to attribute it to.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { loadValidHandoff } from "@/server/purchases.server";
import { tenantIdForBillingUserId } from "@/server/current-plan.server";
import {
  FEEDBACK_REWARD_TOKENS,
  deliverSubmission,
  formForTenant,
  promptState,
  submitFeedback,
} from "@/server/feedback.server";
import { buildFeedbackForm } from "@/lib/feedback/feedback-form";

const adminAny = supabaseAdmin;

type Caller = {
  tenantId: string | null;
  originUserId: string | null;
  originUsername: string | null;
  originSource: string | null;
};

/**
 * Who is answering, and for which workspace.
 *
 * A handoff carries the person outright — it was minted by the workspace for
 * this user, which is the whole reason feedback is reached through one. A uid
 * identifies the workspace but not the individual, so the response is recorded
 * against the workspace with no author. Both are better than a form that asks
 * people to type their own workspace name.
 *
 * A handoff is NOT consumed. It is single-use for checkout; leaving feedback
 * must not burn someone's ability to buy.
 */
async function resolveCaller(h: string | null, uid: string | null): Promise<Caller> {
  if (h) {
    const handoff = await loadValidHandoff(h).catch(() => null);
    if (handoff?.tenant_id) {
      return {
        tenantId: handoff.tenant_id,
        originUserId: handoff.origin_user_id ?? null,
        originUsername: handoff.origin_username ?? null,
        originSource: handoff.origin_source ?? "handoff",
      };
    }
  }
  if (uid) {
    const tenantId = await tenantIdForBillingUserId(uid).catch(() => null);
    if (tenantId) {
      return {
        tenantId,
        originUserId: uid,
        originUsername: null,
        originSource: "storefront_uid",
      };
    }
  }
  return { tenantId: null, originUserId: null, originUsername: null, originSource: null };
}

export const Route = createFileRoute("/api/public/storefront/feedback")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),

      GET: async ({ request }) => {
        const url = new URL(request.url);
        const caller = await resolveCaller(url.searchParams.get("h"), url.searchParams.get("uid"));

        // No credential still gets a form — someone who follows the link
        // without one should see what is being asked rather than an error.
        // It just cannot be submitted, and the page says so.
        if (!caller.tenantId) {
          return storefrontJson({
            ok: true,
            identified: false,
            form: buildFeedbackForm({ slug: null, name: null }),
            prompt: null,
            reward_tokens: FEEDBACK_REWARD_TOKENS,
          });
        }

        const [form, prompt, tenant] = await Promise.all([
          formForTenant(caller.tenantId),
          promptState(caller.tenantId, caller.originUserId),
          adminAny
            .from("tenants")
            .select("display_name, external_ref")
            .eq("id", caller.tenantId)
            .maybeSingle()
            .then((r) => r.data ?? null),
        ]);

        return storefrontJson({
          ok: true,
          identified: true,
          workspace_name: tenant?.display_name ?? tenant?.external_ref ?? null,
          respondent: caller.originUsername,
          form,
          prompt,
          reward_tokens: FEEDBACK_REWARD_TOKENS,
        });
      },

      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return storefrontJson({ ok: false, error: "invalid_body" }, 400);
        }

        const caller = await resolveCaller(
          typeof body.h === "string" ? body.h : null,
          typeof body.uid === "string" ? body.uid : null,
        );
        // Refused rather than stored anonymously: there would be nowhere to
        // credit the 100 tokens and no workspace to attribute the answer to.
        if (!caller.tenantId) {
          return storefrontJson({ ok: false, error: "workspace_required" }, 401);
        }

        const result = await submitFeedback({
          tenantId: caller.tenantId,
          originUserId: caller.originUserId,
          originUsername: caller.originUsername,
          originSource: caller.originSource,
          overallRating: body.overall_rating,
          recommendScore: body.recommend_score,
          moduleRatings: body.module_ratings,
          mostValuable: body.most_valuable,
          biggestFrustration: body.biggest_frustration,
          featureRequest: body.feature_request,
          additionalComments: body.additional_comments,
        });

        if (!result.ok || !result.submissionId) {
          return storefrontJson(
            { ok: false, error: result.error ?? "submit_failed" },
            result.error === "empty_submission" ? 400 : 500,
          );
        }

        // Everything below is reporting. The customer has already given
        // feedback and already earned their credits; a Make.com outage must
        // not turn that into a failed submission.
        //
        // Not awaited, and it does not need to be: if this attempt fails — or
        // the process dies before it finishes — the row stays due in
        // feedback_submissions and the retry sweep collects it. That is what
        // makes firing and forgetting honest here rather than lossy.
        void deliverSubmission(result.submissionId).catch((err) => {
          console.error("[feedback] forward failed", err);
        });

        return storefrontJson({
          ok: true,
          submission_id: result.submissionId,
          campaign_key: result.campaignKey,
          credits_granted: result.creditsGranted ?? 0,
          already_granted: result.alreadyGranted === true,
          credits_expire_at: result.creditsExpireAt,
        });
      },
    },
  },
});
