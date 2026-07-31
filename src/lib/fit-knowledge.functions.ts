// @ts-nocheck
// The Client Fit analyst's knowledge base — server functions.
//
// The engine reads the pricing catalog live, so it always knows what Aurixa
// sells. What it could not know is anything Aurixa has *learned*: who the ideal
// customer actually is, which deals went badly and why, how we position against
// the alternatives, and who we decline on sight. That is what these entries
// carry into every analysis.
//
// The text in `content` is the only part the analyst ever sees. An uploaded
// file is kept for provenance — so a claim can be traced back to the document
// it came from — but the engine never guesses at a binary format, and a row
// with no extracted text is inert by design rather than by accident.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator, requireAdmin } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export const KNOWLEDGE_BUCKET = "fit-knowledge";

export const KNOWLEDGE_KINDS = [
  "icp",
  "case_study",
  "positioning",
  "disqualification",
  "pricing",
  "objection",
  "process",
  "other",
] as const;

export const KNOWLEDGE_KIND_LABELS: Record<string, string> = {
  icp: "Ideal customer profile",
  case_study: "Case study / precedent",
  positioning: "Positioning & differentiation",
  disqualification: "Disqualification policy",
  pricing: "Pricing guidance",
  objection: "Objection handling",
  process: "Process & delivery",
  other: "Other",
};

/** What each kind is for, shown next to the picker so entries land in the right place. */
export const KNOWLEDGE_KIND_HINTS: Record<string, string> = {
  icp: "Who we are built for — segment, size, operating shape. Worth pinning.",
  case_study: "A real engagement and how it went. Precedent the analyst can reason from.",
  positioning: "How we differ from the alternatives a prospect is weighing.",
  disqualification: "Who we turn away and why. Worth pinning — it can decline a prospect.",
  pricing: "Commercial guidance beyond the catalog: discounting, floors, deal shapes.",
  objection: "Objections we hear and the honest answers to them.",
  process: "How delivery actually works — onboarding, migration, support.",
  other: "Anything else the analyst should have read.",
};

/** Formats whose text the browser can extract without guessing. */
export const TEXT_EXTRACTABLE_MIME = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
];

export const MAX_KNOWLEDGE_CONTENT = 200_000;

/* --------------------------------- reading -------------------------------- */

export const listFitKnowledge = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        kind: z.enum(["all", ...KNOWLEDGE_KINDS]).default("all"),
        search: z.string().max(200).default(""),
        includeInactive: z.boolean().default(true),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("crm_fit_knowledge")
      .select(
        "id, title, kind, summary, tags, file_path, file_name, mime_type, size_bytes, active, pinned, uploaded_by, created_at, updated_at, content",
      )
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(200);
    if (data.kind !== "all") q = q.eq("kind", data.kind);
    if (!data.includeInactive) q = q.eq("active", true);
    if (data.search.trim()) {
      const term = data.search.trim().replace(/[%_,()]/g, " ");
      q = q.or(`title.ilike.%${term}%,summary.ilike.%${term}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw error;

    // The list view wants to know how substantial an entry is, not to ship
    // every character of it to the browser.
    return (rows ?? []).map(({ content, ...row }) => ({
      ...row,
      content_chars: (content ?? "").length,
      has_content: (content ?? "").trim().length > 0,
    }));
  });

export const getFitKnowledge = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_fit_knowledge")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("knowledge_not_found");
    return row;
  });

/** A short-lived link to the stored source document, for operators reviewing a claim. */
export const getFitKnowledgeFileUrl = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ id: uuid, expiresIn: z.number().int().min(30).max(3600).default(300) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("crm_fit_knowledge")
      .select("file_path")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row?.file_path) return { url: null };
    const { data: signed, error: signError } = await context.supabase.storage
      .from(KNOWLEDGE_BUCKET)
      .createSignedUrl(row.file_path, data.expiresIn);
    if (signError) throw signError;
    return { url: signed?.signedUrl ?? null };
  });

/* --------------------------------- writing -------------------------------- */

const upsertSchema = z.object({
  id: uuid.optional(),
  title: z.string().min(2).max(200),
  kind: z.enum(KNOWLEDGE_KINDS).default("other"),
  content: z.string().max(MAX_KNOWLEDGE_CONTENT).default(""),
  summary: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  active: z.boolean().optional(),
  pinned: z.boolean().optional(),
  file_path: z.string().max(500).nullable().optional(),
  file_name: z.string().max(300).nullable().optional(),
  mime_type: z.string().max(150).nullable().optional(),
  size_bytes: z.number().int().min(0).nullable().optional(),
});

export const upsertFitKnowledge = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => upsertSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    // Tags are matched against prospect text, so casing and stray spaces would
    // only ever produce near-duplicates.
    const tags = [...new Set(fields.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

    if (id) {
      const { data: row, error } = await context.supabase
        .from("crm_fit_knowledge")
        .update({ ...fields, tags })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return row;
    }

    const { data: row, error } = await context.supabase
      .from("crm_fit_knowledge")
      .insert({ ...fields, tags, uploaded_by: context.userId })
      .select()
      .single();
    if (error) throw error;

    await context.supabase.from("audit_log").insert({
      action: "crm.fit.knowledge.created",
      entity_type: "crm_fit_knowledge",
      entity_id: row.id,
      metadata: { title: row.title, kind: row.kind, has_file: Boolean(row.file_path) },
    });
    return row;
  });

export const setFitKnowledgeActive = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({ id: uuid, active: z.boolean().optional(), pinned: z.boolean().optional() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { id, ...fields } = data;
    if (fields.active === undefined && fields.pinned === undefined) return { ok: true };
    const { error } = await context.supabase.from("crm_fit_knowledge").update(fields).eq("id", id);
    if (error) throw error;
    return { ok: true };
  });

export const deleteFitKnowledge = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("crm_fit_knowledge")
      .select("file_path, title")
      .eq("id", data.id)
      .maybeSingle();

    const { error } = await context.supabase.from("crm_fit_knowledge").delete().eq("id", data.id);
    if (error) throw error;

    // The row is gone either way; an orphaned object costs storage, not
    // correctness, so a failure here must not fail the delete.
    if (row?.file_path) {
      const { error: storageError } = await context.supabase.storage
        .from(KNOWLEDGE_BUCKET)
        .remove([row.file_path]);
      if (storageError) console.error("fit knowledge file remove failed", storageError);
    }

    await context.supabase.from("audit_log").insert({
      action: "crm.fit.knowledge.deleted",
      entity_type: "crm_fit_knowledge",
      entity_id: data.id,
      metadata: { title: row?.title ?? null },
    });
    return { ok: true };
  });

/* -------------------------------- coverage -------------------------------- */

/**
 * What the analyst currently knows, and what it is missing.
 *
 * A knowledge base is only as good as its gaps are visible: an empty ICP means
 * every segment judgement is the model's prior rather than Aurixa's policy, and
 * nothing in the report would say so.
 */
export const getFitKnowledgeCoverage = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("crm_fit_knowledge")
      .select("kind, active, pinned, content");
    if (error) throw error;

    const rows = data ?? [];
    const live = rows.filter((r) => r.active && (r.content ?? "").trim().length > 0);
    const byKind: Record<string, number> = {};
    for (const kind of KNOWLEDGE_KINDS) byKind[kind] = 0;
    for (const row of live) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;

    return {
      total: rows.length,
      live: live.length,
      pinned: live.filter((r) => r.pinned).length,
      // A file with no extracted text reaches the bucket but not the analyst.
      inert: rows.filter((r) => (r.content ?? "").trim().length === 0).length,
      by_kind: byKind,
      // The two the engine leans on hardest for a defensible verdict.
      missing_critical: (["icp", "disqualification"] as const).filter((k) => !byKind[k]),
      total_chars: live.reduce((sum, r) => sum + (r.content ?? "").length, 0),
    };
  });
