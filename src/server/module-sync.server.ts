// Server-only core for fleet-wide module sync. Handles bulk install/remove of
// a single module across many clones, and optionally spawns a cascade event
// scoped to ONLY that module's file_globs so the engine pushes just those files.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { executeCascade } from "./cascade-engine.server";
import { assessBlastRadius } from "./cascade-approvals.server";

type SupabaseLike = SupabaseClient<Database>;
type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

export type ModuleSyncAction = "install" | "remove";

export type ModuleSyncResult = {
  ok: boolean;
  module_id: string;
  action: ModuleSyncAction;
  affected_clone_ids: string[];
  cascade_event_id: string | null;
  error?: string;
};

export async function bulkSyncModule(args: {
  supabase: SupabaseLike;
  moduleId: string;
  cloneIds: string[];
  action: ModuleSyncAction;
  cascade: boolean;
  cascadeMode: CascadeMode;
  initiatedBy: string | null;
}): Promise<ModuleSyncResult> {
  const { supabase, moduleId, cloneIds, action, cascade, cascadeMode, initiatedBy } = args;

  if (!moduleId) {
    return base(moduleId, action, [], { ok: false, error: "moduleId required" });
  }
  if (!cloneIds || cloneIds.length === 0) {
    return base(moduleId, action, [], { ok: false, error: "Pick at least one clone" });
  }

  const { data: mod, error: modErr } = await supabase
    .from("modules")
    .select("id, name, file_globs")
    .eq("id", moduleId)
    .maybeSingle();
  if (modErr || !mod) {
    return base(moduleId, action, [], { ok: false, error: modErr?.message ?? "Module not found" });
  }

  // Scope to clones that actually exist (RLS will already filter unauthorized).
  const { data: existingClones } = await supabase.from("clones").select("id").in("id", cloneIds);
  const validIds = (existingClones ?? []).map((c) => c.id);
  if (validIds.length === 0) {
    return base(moduleId, action, [], { ok: false, error: "No accessible clones in selection" });
  }

  if (action === "install") {
    // Find which clones already have the module installed to avoid the unique constraint.
    const { data: already } = await supabase
      .from("clone_modules")
      .select("clone_id")
      .eq("module_id", moduleId)
      .in("clone_id", validIds);
    const alreadySet = new Set((already ?? []).map((r) => r.clone_id));
    const toInsert = validIds
      .filter((id) => !alreadySet.has(id))
      .map((cloneId) => ({
        clone_id: cloneId,
        module_id: moduleId,
        installed_by: initiatedBy,
      }));
    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from("clone_modules").insert(toInsert);
      if (insErr) {
        return base(moduleId, action, [], { ok: false, error: insErr.message });
      }
    }
  } else {
    const { error: delErr } = await supabase
      .from("clone_modules")
      .delete()
      .eq("module_id", moduleId)
      .in("clone_id", validIds);
    if (delErr) {
      return base(moduleId, action, [], { ok: false, error: delErr.message });
    }
  }

  await supabase.from("audit_log").insert({
    action: action === "install" ? "module.bulk_installed" : "module.bulk_removed",
    entity_type: "module",
    entity_id: moduleId,
    metadata: { module_name: mod.name, clone_ids: validIds, count: validIds.length },
  });

  // Notify per clone so users see it in the bell.
  type NotifInsert = Database["public"]["Tables"]["notifications"]["Insert"];
  const kind = action === "install" ? "module_installed" : "module_removed";
  const cloneNotifs: NotifInsert[] = validIds.map((cloneId) => ({
    kind,
    severity: "info",
    title: `${mod.name} ${action === "install" ? "installed" : "removed"}`,
    body: `Bulk module sync · ${mod.name}`,
    clone_id: cloneId,
    metadata: { module_id: moduleId },
  }));
  if (cloneNotifs.length > 0) {
    await supabase.from("notifications").insert(cloneNotifs);
  }

  // For removals, we never cascade (nothing to push). For installs, optionally
  // run a scoped cascade so the new module's files land on the clones now.
  if (!cascade || action === "remove") {
    return base(moduleId, action, validIds, { ok: true, cascade_event_id: null });
  }

  const moduleGlobs = mod.file_globs ?? [];
  if (moduleGlobs.length === 0) {
    return base(moduleId, action, validIds, {
      ok: true,
      cascade_event_id: null,
      error: "Module has no file_globs — skipped cascade",
    });
  }

  const blast = assessBlastRadius(cascadeMode, validIds.length);

  const { data: ev, error: evErr } = await supabase
    .from("cascade_events")
    .insert({
      trigger: "manual",
      mode: cascadeMode,
      status: "pending",
      requires_approval: blast.requiresApproval,
      scope_filter: {
        scope: "module_sync",
        clone_ids: validIds,
        module_id: moduleId,
        module_name: mod.name,
        module_globs: moduleGlobs,
      },
      summary: `Module sync · ${mod.name} → ${validIds.length} clone(s)`,
      initiated_by: initiatedBy,
    })
    .select()
    .single();
  if (evErr || !ev) {
    return base(moduleId, action, validIds, {
      ok: false,
      error: evErr?.message ?? "Failed to create cascade event",
    });
  }

  const rows = validIds.map((cloneId) => ({
    cascade_event_id: ev.id,
    clone_id: cloneId,
    status: "queued" as const,
  }));
  const { error: rErr } = await supabase.from("cascade_results").insert(rows);
  if (rErr) {
    return base(moduleId, action, validIds, { ok: false, error: rErr.message });
  }

  if (blast.requiresApproval) {
    await supabase.from("notifications").insert({
      kind: "cascade_awaiting_approval",
      severity: "warning",
      title: `Approval needed · module sync (${mod.name})`,
      body: `${blast.reason ?? ""} Module-sync cascade across ${validIds.length} clone(s).`,
      cascade_event_id: ev.id,
      url: `/cascades/${ev.id}`,
      metadata: {
        mode: cascadeMode,
        clone_count: validIds.length,
        module_id: moduleId,
        scope: "module_sync",
      },
    });
    await supabase.from("audit_log").insert({
      action: "cascade.awaiting_approval",
      entity_type: "cascade_event",
      entity_id: ev.id,
      actor_user_id: initiatedBy,
      metadata: {
        mode: cascadeMode,
        scope: "module_sync",
        module_id: moduleId,
        clone_count: validIds.length,
        reason: blast.reason,
      },
    });
    return base(moduleId, action, validIds, {
      ok: true,
      cascade_event_id: ev.id,
      error: blast.reason ?? "Awaiting second-operator approval",
    });
  }

  const runRes = await executeCascade(supabase, ev.id);
  if (!runRes.ok) {
    return base(moduleId, action, validIds, {
      ok: false,
      cascade_event_id: ev.id,
      error: runRes.error,
    });
  }

  return base(moduleId, action, validIds, { ok: true, cascade_event_id: ev.id });
}

function base(
  moduleId: string,
  action: ModuleSyncAction,
  affected: string[],
  patch: Partial<ModuleSyncResult>,
): ModuleSyncResult {
  return {
    module_id: moduleId,
    action,
    affected_clone_ids: affected,
    cascade_event_id: null,
    ok: false,
    ...patch,
  };
}
