// Operator reads over product feedback.
//
// Three questions an operator actually has: what are people saying, which
// workspaces have been paid for saying it, and did any of it fail to reach
// Airtable. Read-only — nothing here writes, because submissions come from
// customers and grants are made by the database.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";

export type FeedbackRow = {
  id: string;
  created_at: string;
  campaign_key: string;
  tenant_id: string;
  workspace: string | null;
  origin_username: string | null;
  origin_user_id: string | null;
  plan_name: string | null;
  overall_rating: number | null;
  recommend_score: number | null;
  module_ratings: Record<string, number>;
  most_valuable: string | null;
  biggest_frustration: string | null;
  feature_request: string | null;
  additional_comments: string | null;
  forwarded_at: string | null;
  forward_error: string | null;
};

export const listFeedback = createServerFn({ method: "GET" })
  .inputValidator((i) =>
    z
      .object({
        campaign: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(i ?? {}),
  )
  .middleware([requireOperator])
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const adminAny = supabaseAdmin;

      let q = adminAny
        .from("feedback_submissions")
        .select(
          "id, created_at, campaign_key, tenant_id, origin_username, origin_user_id, plan_name, overall_rating, recommend_score, module_ratings, most_valuable, biggest_frustration, feature_request, additional_comments, forwarded_at, forward_error, tenants:tenant_id(display_name, external_ref)",
        )
        .order("created_at", { ascending: false })
        .limit(data.limit);
      if (data.campaign) q = q.eq("campaign_key", data.campaign);

      const { data: rows, error } = await q;
      if (error) return { ok: false as const, error: error.message };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const submissions: FeedbackRow[] = (rows ?? []).map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        campaign_key: r.campaign_key,
        tenant_id: r.tenant_id,
        workspace: r.tenants?.display_name ?? r.tenants?.external_ref ?? null,
        origin_username: r.origin_username,
        origin_user_id: r.origin_user_id,
        plan_name: r.plan_name,
        overall_rating: r.overall_rating,
        recommend_score: r.recommend_score,
        module_ratings: r.module_ratings ?? {},
        most_valuable: r.most_valuable,
        biggest_frustration: r.biggest_frustration,
        feature_request: r.feature_request,
        additional_comments: r.additional_comments,
        forwarded_at: r.forwarded_at,
        forward_error: r.forward_error,
      }));

      const { data: grants } = await adminAny
        .from("feedback_token_grants")
        .select(
          "tenant_id, campaign_key, tokens, created_at, tenants:tenant_id(display_name, external_ref)",
        )
        .order("created_at", { ascending: false })
        .limit(200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const awarded = (grants ?? []).map((g: any) => ({
        tenantId: g.tenant_id,
        workspace: g.tenants?.display_name ?? g.tenants?.external_ref ?? null,
        campaignKey: g.campaign_key,
        tokens: g.tokens,
        createdAt: g.created_at,
      }));

      // Counted here rather than in the component: how many people answered
      // versus how many workspaces were paid is the whole point of the rule,
      // and it should be visible without doing arithmetic on a table.
      const workspaces = new Set(submissions.map((s) => s.tenant_id)).size;
      const rated = submissions.filter((s) => s.overall_rating !== null);
      const averageOverall = rated.length
        ? rated.reduce((sum, s) => sum + (s.overall_rating ?? 0), 0) / rated.length
        : null;

      return {
        ok: true as const,
        submissions,
        awarded,
        stats: {
          submissions: submissions.length,
          workspaces,
          creditsAwarded: awarded.reduce((sum: number, g: { tokens: number }) => sum + g.tokens, 0),
          averageOverall,
          undelivered: submissions.filter((s) => !s.forwarded_at).length,
        },
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
