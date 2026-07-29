// "Should I ask this workspace for feedback, and where do I send them?"
//
// The cadence lives here rather than in each front end — first 30 days, then
// quarterly — so a clone created next year inherits it without shipping the
// rule into code that deploys separately and drifts.
//
// Answering also mints the deep link, because the link is the hard part: the
// feedback page is on a marketing domain with no login, so the workspace and
// the person have to be carried across in an attributed handoff minted
// server-to-server. A front end cannot make one of those for itself.
import { createFileRoute } from "@tanstack/react-router";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { createHandoff, storefrontPricingBase } from "@/server/billing-handoffs.server";
import { promptState } from "@/server/feedback.server";

/**
 * Where the feedback form lives.
 *
 * Derived from the pricing site rather than configured separately: they are
 * the same deployment, and a second environment variable is a second thing to
 * get wrong. PUBLIC_PRICING_SITE_URL already points at
 * https://aurixasystems.com.au/pricing, so the sibling route is /feedback.
 */
function feedbackBase(): string {
  const explicit = process.env.PUBLIC_FEEDBACK_URL;
  if (explicit && /^https?:\/\//.test(explicit)) return explicit.replace(/\/+$/, "");
  return storefrontPricingBase().replace(/\/pricing\/?$/, "") + "/feedback";
}

export const Route = createFileRoute("/api/public/tokens/feedback-prompt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "tokens:read",
          "tokens:meter",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(key.id);
        if (!rl.ok) return jsonResponse({ ok: false, error: "rate_limited" }, 429);

        const url = new URL(request.url);
        const tenantRef = url.searchParams.get("tenant_ref");
        if (!tenantRef || tenantRef.length > 200) {
          return jsonResponse({ ok: false, error: "tenant_ref_required" }, 400);
        }

        const tenant = await ensureTenant(
          key.clone_id,
          tenantRef,
          url.searchParams.get("display_name") ?? undefined,
        );
        if (!tenant.ok) return jsonResponse(tenant, 500);

        // `force` is for testing the form on demand. It changes only whether a
        // LINK is minted — never whether credits are granted, which the unique
        // constraint on feedback_token_grants decides and nothing here can
        // reach. Minting handoffs is already something a clone can do through
        // the top-up endpoint, so this grants no capability it did not have.
        const force = url.searchParams.get("force") === "1";

        const state = await promptState(tenant.tenantId, url.searchParams.get("origin_user_id"));
        // A prompt is the least important thing on a dashboard. If the lookup
        // fails, say "not due" rather than an error — the workspace will be
        // asked on the next load. Unless forced, in which case a caller is
        // deliberately testing and should still get a usable link.
        if (!state && !force) return jsonResponse({ ok: true, due: false });

        if (state && !state.due && !force) {
          return jsonResponse({
            ok: true,
            due: false,
            campaign_key: state.campaignKey,
            reason: state.reason,
          });
        }

        // Attributed when the caller says who is looking. Without it the
        // response is still recorded against the workspace, just with no
        // author — which is worth having, but worth less.
        const originUserId = url.searchParams.get("origin_user_id");
        let feedbackUrl = feedbackBase();
        if (originUserId && originUserId.length <= 200) {
          const created = await createHandoff({
            cloneId: key.clone_id,
            tenantId: tenant.tenantId,
            originUserId,
            originUsername: url.searchParams.get("origin_username")?.slice(0, 200) ?? null,
            originSource: url.searchParams.get("origin_source")?.slice(0, 100) || "feedback_prompt",
            intent: "feedback",
          });
          // A failed mint degrades to the bare link rather than to no prompt:
          // an unattributed response beats a missing one.
          if (created.ok) {
            feedbackUrl = `${feedbackBase()}?h=${encodeURIComponent(created.id)}`;
          }
        }

        return jsonResponse({
          ok: true,
          due: true,
          forced: force && !state?.due,
          campaign_key: state?.campaignKey ?? null,
          reason: state?.reason ?? "quarterly",
          reward_available: state?.rewardAvailable ?? true,
          reward_tokens: state?.rewardTokens ?? 100,
          feedback_url: feedbackUrl,
        });
      },
    },
  },
});
