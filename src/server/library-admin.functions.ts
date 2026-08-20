import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

// ─── Library approval workflow (admin-only) ────────────────────────

async function isAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data === true) return true;
  const { data: sa } = await supabase.rpc("has_role", { _user_id: userId, _role: "super_admin" });
  return sa === true;
}

export const setLibraryApprovalStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { entryId: string; status: "approved" | "rejected" | "pending"; reason?: string }) => {
      if (!data?.entryId) throw new Error("entryId required");
      if (!["approved", "rejected", "pending"].includes(data.status))
        throw new Error("status must be approved, rejected, or pending");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await isAdmin(context.supabase, context.userId);
    if (!admin)
      return { ok: false as const, error: "Admin role required to approve library entries" };

    const update = {
      approval_status: data.status,
      approved_by: data.status === "approved" ? context.userId : null,
      approved_at: data.status === "approved" ? new Date().toISOString() : null,
      rejection_reason: data.status === "rejected" ? (data.reason ?? null) : null,
    } satisfies Database["public"]["Tables"]["module_library"]["Update"];

    const { data: updated, error } = await context.supabase
      .from("module_library")
      .update(update)
      .eq("id", data.entryId)
      .select("id, name, slug, version")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: `library.${data.status}`,
      entity_type: "module_library",
      entity_id: data.entryId,
      actor_user_id: context.userId,
      metadata: { status: data.status, reason: data.reason },
    });

    // Fan-out notification so the fleet sees approval decisions in the bell.
    if (data.status === "approved" || data.status === "rejected") {
      const label = updated ? `${updated.name} v${updated.version}` : "Library entry";
      await context.supabase.from("notifications").insert({
        kind: data.status === "approved" ? "library_entry_approved" : "library_entry_rejected",
        severity: data.status === "approved" ? "success" : "warning",
        title:
          data.status === "approved"
            ? `Library approved · ${label}`
            : `Library rejected · ${label}`,
        body:
          data.status === "rejected" && data.reason
            ? data.reason
            : data.status === "approved"
              ? "Now available for pinning to clones."
              : "Entry was not approved for fleet use.",
        url: "/modules",
        metadata: {
          library_entry_id: data.entryId,
          slug: updated?.slug,
          version: updated?.version,
        },
      });
    }

    return { ok: true as const };
  });

// ─── Per-clone version pinning ─────────────────────────────────────

export const getCloneLibraryPins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: pins, error } = await context.supabase
      .from("clone_library_pins")
      .select("*")
      .eq("clone_id", data.cloneId)
      .order("slug", { ascending: true });
    if (error) return { ok: false as const, error: error.message, pins: [] };
    return { ok: true as const, pins: pins ?? [] };
  });

export const setCloneLibraryPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; libraryEntryId: string; notes?: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!data?.libraryEntryId) throw new Error("libraryEntryId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    // Resolve the library entry → must be approved
    const { data: entry, error: entryErr } = await context.supabase
      .from("module_library")
      .select("id, slug, version, approval_status, name")
      .eq("id", data.libraryEntryId)
      .maybeSingle();
    if (entryErr || !entry)
      return { ok: false as const, error: entryErr?.message ?? "Library entry not found" };
    if ((entry as { approval_status?: string }).approval_status !== "approved") {
      return { ok: false as const, error: "Only approved library entries can be pinned" };
    }

    // Upsert per (clone_id, slug)
    const { error: upErr } = await context.supabase.from("clone_library_pins").upsert(
      {
        clone_id: data.cloneId,
        library_entry_id: entry.id,
        slug: entry.slug,
        version: entry.version,
        pinned_by: context.userId,
        pinned_at: new Date().toISOString(),
        notes: data.notes ?? null,
      },
      { onConflict: "clone_id,slug" },
    );
    if (upErr) return { ok: false as const, error: upErr.message };

    await context.supabase.from("audit_log").insert({
      action: "library.pin",
      entity_type: "clone_library_pin",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        clone_id: data.cloneId,
        slug: entry.slug,
        version: entry.version,
        library_entry_id: entry.id,
      },
    });

    return { ok: true as const };
  });

// Bulk apply: take a set of (slug, libraryEntryId) and upsert them across many clones.
// Skips entries that aren't approved and reports per-clone results.
export const bulkApplyClonePins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      cloneIds: string[];
      pins: Array<{ slug: string; libraryEntryId: string }>;
      notes?: string;
    }) => {
      if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
        throw new Error("cloneIds required");
      if (!Array.isArray(data?.pins) || data.pins.length === 0)
        throw new Error("at least one pin required");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    // Resolve all entries up front
    const entryIds = Array.from(new Set(data.pins.map((p) => p.libraryEntryId)));
    const { data: entries, error: entryErr } = await context.supabase
      .from("module_library")
      .select("id, slug, version, approval_status, name, file_paths")
      .in("id", entryIds);
    if (entryErr) return { ok: false as const, error: entryErr.message, results: [] };

    const entryMap = new Map<
      string,
      {
        id: string;
        slug: string;
        version: number;
        approval_status: string;
        name: string;
        file_paths: string[] | null;
      }
    >();
    for (const e of (entries ?? []) as Array<{
      id: string;
      slug: string;
      version: number;
      approval_status: string;
      name: string;
      file_paths: string[] | null;
    }>) {
      entryMap.set(e.id, e);
    }

    type PerClone = {
      cloneId: string;
      applied: number;
      skipped: Array<{ slug: string; reason: string }>;
      error?: string;
    };
    const results: PerClone[] = [];

    for (const cloneId of data.cloneIds) {
      const perClone: PerClone = { cloneId, applied: 0, skipped: [] };
      const rows: Array<{
        clone_id: string;
        library_entry_id: string;
        slug: string;
        version: number;
        pinned_by: string;
        pinned_at: string;
        notes: string | null;
      }> = [];

      for (const p of data.pins) {
        const e = entryMap.get(p.libraryEntryId);
        if (!e) {
          perClone.skipped.push({ slug: p.slug, reason: "entry not found" });
          continue;
        }
        if (e.slug !== p.slug) {
          perClone.skipped.push({ slug: p.slug, reason: `slug mismatch (entry is ${e.slug})` });
          continue;
        }
        if (e.approval_status !== "approved") {
          perClone.skipped.push({ slug: p.slug, reason: "not approved" });
          continue;
        }
        rows.push({
          clone_id: cloneId,
          library_entry_id: e.id,
          slug: e.slug,
          version: e.version,
          pinned_by: context.userId,
          pinned_at: new Date().toISOString(),
          notes: data.notes ?? null,
        });
      }

      if (rows.length > 0) {
        const { error: upErr } = await context.supabase
          .from("clone_library_pins")
          .upsert(rows, { onConflict: "clone_id,slug" });
        if (upErr) perClone.error = upErr.message;
        else perClone.applied = rows.length;
      }
      results.push(perClone);
    }

    await context.supabase.from("audit_log").insert({
      action: "library.bulk_pin",
      entity_type: "clone_library_pin",
      entity_id: null,
      actor_user_id: context.userId,
      metadata: {
        clone_ids: data.cloneIds,
        pins: data.pins,
        applied_total: results.reduce((s, r) => s + r.applied, 0),
      },
    });

    return { ok: true as const, results };
  });

// Validate that pinned library entries still exist, are approved, and have file_paths.
// Used by the cascade engine to gate execution and by the UI to surface stale pins.
export const validateClonePins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneIds: string[] }) => {
    if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
      throw new Error("cloneIds required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: pins, error } = await context.supabase
      .from("clone_library_pins")
      .select("id, clone_id, slug, version, library_entry_id")
      .in("clone_id", data.cloneIds);
    if (error) return { ok: false as const, error: error.message, issues: [] };

    const pinRows = (pins ?? []) as Array<{
      id: string;
      clone_id: string;
      slug: string;
      version: number;
      library_entry_id: string;
    }>;
    if (pinRows.length === 0) {
      return { ok: true as const, issues: [], checked: 0 };
    }

    const entryIds = Array.from(new Set(pinRows.map((p) => p.library_entry_id)));
    const { data: entries } = await context.supabase
      .from("module_library")
      .select("id, slug, version, approval_status, file_paths")
      .in("id", entryIds);

    const entryMap = new Map<
      string,
      {
        id: string;
        slug: string;
        version: number;
        approval_status: string;
        file_paths: string[] | null;
      }
    >();
    for (const e of (entries ?? []) as Array<{
      id: string;
      slug: string;
      version: number;
      approval_status: string;
      file_paths: string[] | null;
    }>) {
      entryMap.set(e.id, e);
    }

    type Issue = {
      cloneId: string;
      slug: string;
      version: number;
      severity: "error" | "warning";
      reason: string;
    };
    const issues: Issue[] = [];

    for (const p of pinRows) {
      const e = entryMap.get(p.library_entry_id);
      if (!e) {
        issues.push({
          cloneId: p.clone_id,
          slug: p.slug,
          version: p.version,
          severity: "error",
          reason: "Library entry was deleted",
        });
        continue;
      }
      if (e.approval_status !== "approved") {
        issues.push({
          cloneId: p.clone_id,
          slug: p.slug,
          version: p.version,
          severity: "error",
          reason: `Entry is now ${e.approval_status}`,
        });
      }
      const files = e.file_paths ?? [];
      if (files.length === 0) {
        issues.push({
          cloneId: p.clone_id,
          slug: p.slug,
          version: p.version,
          severity: "error",
          reason: "Pinned entry has no file paths",
        });
      }
    }

    return { ok: true as const, issues, checked: pinRows.length };
  });

export const removeCloneLibraryPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; slug: string }) => {
    if (!data?.cloneId || !data?.slug) throw new Error("cloneId and slug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("clone_library_pins")
      .delete()
      .eq("clone_id", data.cloneId)
      .eq("slug", data.slug);
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "library.unpin",
      entity_type: "clone_library_pin",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { clone_id: data.cloneId, slug: data.slug },
    });

    return { ok: true as const };
  });

// ─── Dependency graph viewer ───────────────────────────────────────
// Returns the import-edge subgraph for a single module, by intersecting
// the latest detection run's edges with the module's resolved files.

export const getModuleDependencyGraph = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { moduleId: string }) => {
    if (!data?.moduleId) throw new Error("moduleId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    // 1. Load the module
    const { data: mod, error: modErr } = await context.supabase
      .from("modules")
      .select("*")
      .eq("id", data.moduleId)
      .maybeSingle();
    if (modErr || !mod) return { ok: false as const, error: modErr?.message ?? "Module not found" };

    const ownFiles = new Set<string>(
      ((mod.resolved_files as string[]) ?? mod.file_globs ?? []) as string[],
    );
    if (ownFiles.size === 0) {
      return {
        ok: true as const,
        module: { id: mod.id, name: mod.name, slug: mod.slug },
        ownFiles: [],
        edges: [],
        externalTargets: [],
        moduleDependencies: [],
      };
    }

    // 2. Pick most recent detection run that has edges for any of these files
    const runId = mod.detection_run_id as string | null;
    let edgesQuery = context.supabase
      .from("module_import_edges")
      .select("source_file, target_file, import_type")
      .in("source_file", Array.from(ownFiles))
      .limit(2000);
    if (runId) edgesQuery = edgesQuery.eq("detection_run_id", runId);

    const { data: edges, error: edgesErr } = await edgesQuery;
    if (edgesErr) return { ok: false as const, error: edgesErr.message };

    const edgeList = (edges ?? []) as Array<{
      source_file: string;
      target_file: string;
      import_type: string;
    }>;

    // 3. Identify external targets (files the module imports that are NOT in its own file set)
    const externalTargets = Array.from(
      new Set(edgeList.filter((e) => !ownFiles.has(e.target_file)).map((e) => e.target_file)),
    );

    // 4. Map external targets to owning modules (which other modules contain those files)
    const moduleDependencies: Array<{
      module_id: string;
      module_name: string;
      module_slug: string;
      shared_files: string[];
    }> = [];

    if (externalTargets.length > 0) {
      const { data: otherModules } = await context.supabase
        .from("modules")
        .select("id, name, slug, resolved_files")
        .neq("id", data.moduleId);

      for (const other of (otherModules ?? []) as Array<{
        id: string;
        name: string;
        slug: string;
        resolved_files: string[];
      }>) {
        const otherFiles = new Set(other.resolved_files ?? []);
        const shared = externalTargets.filter((t) => otherFiles.has(t));
        if (shared.length > 0) {
          moduleDependencies.push({
            module_id: other.id,
            module_name: other.name,
            module_slug: other.slug,
            shared_files: shared,
          });
        }
      }
    }

    return {
      ok: true as const,
      module: { id: mod.id, name: mod.name, slug: mod.slug },
      ownFiles: Array.from(ownFiles),
      edges: edgeList,
      externalTargets,
      moduleDependencies,
    };
  });
