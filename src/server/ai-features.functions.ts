import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { callAi } from "./ai-gateway.server";

export const aiCascadeSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      scope: string;
      mode: string;
      cloneCount: number;
      affectedModules: string[];
      recentCommits?: string[];
    }) =>
      z
        .object({
          scope: z.string(),
          mode: z.string(),
          cloneCount: z.number().int(),
          affectedModules: z.array(z.string()),
          recentCommits: z.array(z.string()).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const prompt = `You are reviewing a fleet cascade about to fire.
Scope: ${data.scope}
Mode: ${data.mode}
Affected clones: ${data.cloneCount}
Modules touched: ${data.affectedModules.join(", ") || "(none specified)"}
Recent commits:\n${(data.recentCommits ?? []).slice(0, 8).join("\n") || "(unknown)"}

Produce a concise pre-flight briefing in markdown:
1. **Impact** — one paragraph
2. **Risk level** — Green/Yellow/Red with one-line reason
3. **What to verify after** — 3 bullets`;
    const { content } = await callAi({
      feature: "cascade_summary",
      prompt,
      userId: context.userId,
      supabase: context.supabase,
    });
    return { summary: content };
  });

export const aiBrandValidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { brandConfig: Record<string, unknown> }) =>
    z.object({ brandConfig: z.record(z.unknown()) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const prompt = `Audit this brand configuration for accessibility and consistency.
Config:
${JSON.stringify(data.brandConfig, null, 2)}

Return strict JSON of shape:
{
  "contrast_issues": [{ "pair": "primary on background", "ratio": 4.1, "min": 4.5, "fix": "darken primary to #..." }],
  "tone_notes": ["..."],
  "color_harmony": "good|fair|clashing",
  "recommendations": ["..."]
}`;
    const { content } = await callAi({
      feature: "brand_validate",
      prompt,
      json: true,
      userId: context.userId,
      supabase: context.supabase,
    });
    try {
      return { result: JSON.parse(content) };
    } catch {
      return { result: { raw: content } };
    }
  });

export const aiModuleDoc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { name: string; slug: string; files: string[] }) =>
    z.object({ name: z.string(), slug: z.string(), files: z.array(z.string()).max(40) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const prompt = `You are documenting a code module for a fleet-management catalog.
Name: ${data.name}
Slug: ${data.slug}
Files (sample):
${data.files.slice(0, 30).join("\n")}

Return strict JSON: { "description": "1-2 sentence summary", "tags": ["tag1","tag2"], "route_hint": "/likely/path or null" }`;
    const { content } = await callAi({
      feature: "module_doc",
      prompt,
      json: true,
      userId: context.userId,
      supabase: context.supabase,
    });
    try {
      return { suggestion: JSON.parse(content) };
    } catch {
      return { suggestion: { description: content, tags: [], route_hint: null } };
    }
  });

export const aiGenerateFleetDigest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const [clonesRes, cascadesRes, driftRes] = await Promise.all([
      supabase.from("clones").select("id, name, sync_status, commits_behind"),
      supabase
        .from("cascade_events")
        .select("id, status, mode, trigger, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("module_drift_alerts")
        .select("id, severity, alert_type, created_at")
        .gte("created_at", since)
        .limit(50),
    ]);
    const metrics = {
      total_clones: clonesRes.data?.length ?? 0,
      drifted: clonesRes.data?.filter((c: any) => c.commits_behind > 0).length ?? 0,
      cascades_7d: cascadesRes.data?.length ?? 0,
      cascades_failed_7d: cascadesRes.data?.filter((c: any) => c.status === "failed").length ?? 0,
      drift_alerts_7d: driftRes.data?.length ?? 0,
    };
    const prompt = `Write a weekly fleet operations digest in markdown for the platform operator.
Metrics: ${JSON.stringify(metrics)}
Recent cascade modes: ${JSON.stringify(cascadesRes.data?.map((c: any) => c.mode))}
Sections: Headline · What changed · Risks · Recommended next actions (3 bullets).`;
    const { content } = await callAi({
      feature: "fleet_digest",
      model: "google/gemini-2.5-pro",
      prompt,
      userId,
      supabase,
    });
    const periodEnd = new Date().toISOString();
    const { data: digest } = await supabase
      .from("fleet_digests")
      .insert({
        period_start: since,
        period_end: periodEnd,
        summary_markdown: content,
        metrics,
        generated_by_model: "google/gemini-2.5-pro",
      })
      .select("id")
      .single();
    return { id: digest?.id, summary: content, metrics };
  });

export const listFleetDigests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("fleet_digests")
      .select(
        "id, period_start, period_end, summary_markdown, metrics, generated_by_model, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(20);
    return { digests: data ?? [] };
  });
