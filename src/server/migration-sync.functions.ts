// @ts-nocheck
// Tracked in scripts/ts-nocheck-budget.txt; the budget only goes down.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { getAppOctokit } from "./github-app.server";
import {
  fetchPrimeMigrationList,
  fetchPrimeMigrations,
  resolvePrimeSource,
} from "./prime-backend.server";
import { applyPrimeMigrations } from "./backend-provisioning.server";

/**
 * Migration sync — prime-repo driven.
 *
 * The source of truth for clone schemas is the prime repo's
 * supabase/migrations directory on GitHub (not a hand-maintained registry).
 * Each clone backend keeps its own aurixa.schema_migrations ledger, so
 * replays are idempotent: anything already applied is skipped.
 */

/** Legacy version markers written by the pre-replication pipeline. */
function normalizeVersion(version: string | null): string | null {
  if (!version || !/^\d+$/.test(version)) return null;
  return version;
}

/**
 * Get migration registry info — the prime repo's migration list.
 * Every prime migration is clone-applicable by construction: a clone
 * backend is a structural replica of the prime.
 */
export const getMigrationRegistry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const empty = {
      totalMigrations: 0,
      cloneApplicable: 0,
      latestCloneVersion: "none",
      migrations: [] as { id: string; description: string; cloneApplicable: boolean }[],
    };
    const source = await resolvePrimeSource(context.supabase);
    if (!source) return { ...empty, error: "Prime not configured" };

    try {
      const { migrations, sourceSha } = await fetchPrimeMigrationList(getAppOctokit(), source);
      return {
        totalMigrations: migrations.length,
        cloneApplicable: migrations.length,
        latestCloneVersion: migrations[migrations.length - 1]?.id ?? "none",
        migrations: migrations.map((m) => ({
          id: m.id,
          description: m.name,
          cloneApplicable: true,
        })),
        sourceRepo: `${source.owner}/${source.repo}`,
        sourceSha,
      };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : "Failed to read prime repo" };
    }
  });

/**
 * Get migration status for a specific clone backend, measured against the
 * prime repo's current migration list.
 */
export const getCloneMigrationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { cloneId: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: backend } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, migration_version, status")
      .eq("clone_id", data.cloneId)
      .maybeSingle();

    if (!backend) {
      return { hasBackend: false as const };
    }

    const currentVersion = normalizeVersion(backend.migration_version);

    let pending: { id: string; description: string }[] = [];
    let latestVersion = "none";
    try {
      const source = await resolvePrimeSource(supabase);
      if (source) {
        const { migrations } = await fetchPrimeMigrationList(getAppOctokit(), source);
        latestVersion = migrations[migrations.length - 1]?.id ?? "none";
        pending = migrations
          .filter((m) => !currentVersion || m.id > currentVersion)
          .map((m) => ({ id: m.id, description: m.name }));
      }
    } catch {
      // Prime repo unreadable (GitHub App down/unconfigured) — show no pending
      // rather than failing the whole clone page.
    }

    return {
      hasBackend: true as const,
      backendStatus: backend.status,
      currentVersion: backend.migration_version,
      latestVersion,
      pendingCount: pending.length,
      pendingMigrations: pending,
      isUpToDate: pending.length === 0,
    };
  });

/**
 * Apply the prime repo's pending migrations to a specific clone backend.
 */
export const syncCloneMigrations = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<
      | { ok: true; applied: number; newVersion: string; failures: string[] }
      | { ok: false; error: string }
    > => {
      const { supabase, userId } = context;

      const { data: backend } = await supabase
        .from("clone_backends")
        .select("supabase_project_ref, migration_version, status")
        .eq("clone_id", data.cloneId)
        .maybeSingle();

      if (!backend) {
        return { ok: false, error: "No backend provisioned for this clone" };
      }
      if (backend.status !== "ready") {
        return { ok: false, error: `Backend is not ready (status: ${backend.status})` };
      }
      if (!backend.supabase_project_ref) {
        return { ok: false, error: "Backend has no project reference" };
      }

      const source = await resolvePrimeSource(supabase);
      if (!source) {
        return { ok: false, error: "Prime not configured — set the prime repo in Settings first" };
      }

      // Update status to migrating
      await supabase
        .from("clone_backends")
        .update({
          status: "migrating" as const,
          status_detail: `Syncing migrations from ${source.owner}/${source.repo}...`,
        })
        .eq("clone_id", data.cloneId);

      try {
        const { migrations, sourceSha } = await fetchPrimeMigrations(getAppOctokit(), source);
        const { results, latestApplied } = await applyPrimeMigrations(
          backend.supabase_project_ref,
          migrations,
        );

        const successes = results.filter((r) => r.success && !r.skipped);
        const failures = results.filter((r) => !r.success);
        const newVersion = latestApplied ?? backend.migration_version ?? "none";

        // Update backend record
        await supabase
          .from("clone_backends")
          .update({
            migration_version: latestApplied,
            source_repo: `${source.owner}/${source.repo}`,
            source_ref: source.branch,
            source_sha: sourceSha,
            migrations_applied: results,
            status: failures.length > 0 ? ("failed" as const) : ("ready" as const),
            status_detail:
              failures.length > 0
                ? `Migration failed at ${failures[0].name}: ${failures[0].error}`
                : `Migrations up to date (${newVersion})`,
            error_message: failures.length > 0 ? failures[0].error : null,
          })
          .eq("clone_id", data.cloneId);

        // Audit log
        await supabase.from("audit_log").insert({
          action: "clone_backend.migrations_synced",
          entity_type: "clone",
          entity_id: data.cloneId,
          actor_user_id: userId,
          metadata: {
            applied: successes.length,
            failed: failures.length,
            new_version: newVersion,
            source_repo: `${source.owner}/${source.repo}`,
            source_sha: sourceSha,
            failures: failures.map((f) => ({ id: f.id, error: f.error })),
          },
        });

        return {
          ok: true,
          applied: successes.length,
          newVersion,
          failures: failures.map((f) => `${f.name}: ${f.error}`),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Migration sync failed";
        await supabase
          .from("clone_backends")
          .update({
            status: "ready" as const,
            status_detail: `Migration error: ${msg}`,
            error_message: msg,
          })
          .eq("clone_id", data.cloneId);
        return { ok: false, error: msg };
      }
    },
  );

/**
 * Fleet-wide migration sync: apply the prime's pending migrations to all
 * ready clone backends. The prime repo is snapshotted once and replayed
 * against every backend; each backend's ledger decides what it still needs.
 */
export const fleetMigrationSync = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(
    async ({
      context,
    }): Promise<
      | {
          ok: true;
          results: { cloneId: string; cloneName: string; applied: number; failures: string[] }[];
        }
      | { ok: false; error: string }
    > => {
      const { supabase, userId } = context;

      const source = await resolvePrimeSource(supabase);
      if (!source) {
        return { ok: false, error: "Prime not configured — set the prime repo in Settings first" };
      }

      // Get all ready backends
      const { data: backends } = await supabase
        .from("clone_backends")
        .select("clone_id, supabase_project_ref, migration_version, status")
        .eq("status", "ready")
        .not("supabase_project_ref", "is", null);

      if (!backends || backends.length === 0) {
        return { ok: true, results: [] };
      }

      let migrations;
      let sourceSha;
      try {
        ({ migrations, sourceSha } = await fetchPrimeMigrations(getAppOctokit(), source));
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Failed to read prime repo migrations",
        };
      }

      // Get clone names
      const cloneIds = backends.map((b) => b.clone_id);
      const { data: clones } = await supabase.from("clones").select("id, name").in("id", cloneIds);
      const cloneNameMap = new Map(clones?.map((c) => [c.id, c.name]) ?? []);

      const results: { cloneId: string; cloneName: string; applied: number; failures: string[] }[] =
        [];

      for (const backend of backends) {
        try {
          const { results: migResults, latestApplied } = await applyPrimeMigrations(
            backend.supabase_project_ref!,
            migrations,
          );

          const successes = migResults.filter((r) => r.success && !r.skipped);
          const failures = migResults.filter((r) => !r.success);

          if (successes.length === 0 && failures.length === 0) continue; // already up to date

          await supabase
            .from("clone_backends")
            .update({
              migration_version: latestApplied,
              source_repo: `${source.owner}/${source.repo}`,
              source_ref: source.branch,
              source_sha: sourceSha,
              migrations_applied: migResults,
              status: failures.length > 0 ? ("failed" as const) : ("ready" as const),
              status_detail:
                failures.length > 0
                  ? `Migration failed at ${failures[0].name}`
                  : `Synced to ${latestApplied}`,
              error_message: failures.length > 0 ? failures[0].error : null,
            })
            .eq("clone_id", backend.clone_id);

          results.push({
            cloneId: backend.clone_id,
            cloneName: cloneNameMap.get(backend.clone_id) ?? "Unknown",
            applied: successes.length,
            failures: failures.map((f) => `${f.name}: ${f.error}`),
          });
        } catch (e) {
          results.push({
            cloneId: backend.clone_id,
            cloneName: cloneNameMap.get(backend.clone_id) ?? "Unknown",
            applied: 0,
            failures: [e instanceof Error ? e.message : "Unknown error"],
          });
        }
      }

      // Audit log
      await supabase.from("audit_log").insert({
        action: "fleet.migrations_synced",
        entity_type: "fleet",
        entity_id: null,
        actor_user_id: userId,
        metadata: {
          source_repo: `${source.owner}/${source.repo}`,
          source_sha: sourceSha,
          clones_processed: results.length,
          total_applied: results.reduce((s, r) => s + r.applied, 0),
          total_failures: results.reduce((s, r) => s + r.failures.length, 0),
        },
      });

      return { ok: true, results };
    },
  );
