// @ts-nocheck
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

/**
 * Backend provisioning server functions.
 *
 * A clone backend is a faithful structural replica of the PRIME repo's
 * Supabase architecture (schemas, tables, RLS, edge functions, secret
 * names as empty shells) — never its data. The prime repo is whatever
 * prime_config points at (e.g. npc-property-dashbord).
 */

/**
 * Shared provisioning runner used by both first-time provisioning and retry.
 * Snapshots the prime repo's supabase/ directory, provisions the project,
 * and persists the full replication report on clone_backends.
 */
async function runBackendProvisioning(
  supabase,
  userId: string,
  input: {
    cloneId: string;
    cloneName: string;
    region?: string;
    adminEmail: string;
    adminPassword: string;
    moduleIds?: string[];
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const updateStatus = async (status: string, detail: string) => {
    await supabase
      .from("clone_backends")
      .update({
        status: status as "provisioning" | "migrating" | "seeding_admin",
        status_detail: detail,
      })
      .eq("clone_id", input.cloneId);
  };

  try {
    const { resolvePrimeSource, fetchPrimeBackendSnapshot } =
      await import(/* @vite-ignore */ "@/server/prime-backend.server");
    const { getAppOctokit } = await import(/* @vite-ignore */ "@/server/github-app.server");
    const { provisionCloneBackend } = await import(/* @vite-ignore */ "@/server/backend-provisioning.server");
    const { encryptSecret } = await import(/* @vite-ignore */ "@/server/crypto.server");
    // ── Snapshot the prime's backend architecture from GitHub ──
    const source = await resolvePrimeSource(supabase);
    if (!source) {
      throw new Error("Prime not configured — set the prime repo in Settings first");
    }
    await updateStatus(
      "provisioning",
      `Snapshotting backend architecture from ${source.owner}/${source.repo}@${source.branch}...`,
    );
    const octokit = getAppOctokit();
    const snapshot = await fetchPrimeBackendSnapshot(octokit, source);
    if (snapshot.migrations.length === 0) {
      throw new Error(
        `No migrations found under supabase/migrations in ${source.owner}/${source.repo}@${source.branch} — nothing to replicate`,
      );
    }

    // Resume onto a project left behind by a failed run rather than orphaning it
    const { data: existingRow } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref")
      .eq("clone_id", input.cloneId)
      .maybeSingle();

    // G8: Collect the clone's own frontend origins so applyAuthConfig can
    // whitelist them on the new backend instead of copying prime's URLs.
    const { data: cloneRow } = await supabase
      .from("clones")
      .select("slug, deploy_url, lovable_project_url")
      .eq("id", input.cloneId)
      .maybeSingle();
    const { data: cfRow } = await supabase
      .from("cloudflare_clone_config")
      .select("zone_name")
      .eq("clone_id", input.cloneId)
      .maybeSingle();
    const cloneOrigins = {
      siteUrl: cloneRow?.deploy_url ?? cloneRow?.lovable_project_url ?? null,
      additionalRedirectUrls: [
        cloneRow?.deploy_url ?? null,
        cloneRow?.lovable_project_url ?? null,
        cfRow?.zone_name ? `https://${cfRow.zone_name}` : null,
        cloneRow?.slug ? `https://${cloneRow.slug}.aurixasystems.com.au` : null,
      ],
    };

    // Resolve which secret names are safe to forward from the prime env into
    // this clone (empty shells cause 500s at first function invocation).
    const { data: forwardRows } = await supabase
      .from("prime_secret_forwards")
      .select("name, inherit")
      .eq("inherit", true);
    const inheritedSecrets: Record<string, string> = {};
    for (const row of forwardRows ?? []) {
      const val = process.env[row.name];
      if (typeof val === "string" && val.length > 0) inheritedSecrets[row.name] = val;
    }

    const result = await provisionCloneBackend(
      {
        cloneName: input.cloneName,
        region: input.region,
        adminEmail: input.adminEmail,
        adminPassword: input.adminPassword,
        snapshot,
        existingProjectRef: existingRow?.supabase_project_ref ?? null,
        inheritedSecrets,
        cloneOrigins,
      },
      updateStatus,
    );

    const failedFunctions = result.edgeFunctions.filter((f) => !f.success);
    const failedSecrets = result.secretShells.filter((s) => !s.success);
    const missingSecrets = result.secretShells.filter((s) => s.status === "missing");
    const partialFailures = failedFunctions.length + failedSecrets.length;

    // Store credentials + replication report, mark ready
    await supabase
      .from("clone_backends")
      .update({
        supabase_project_ref: result.projectRef,
        supabase_url: result.projectUrl,
        anon_key: result.anonKey,
        service_role_key: encryptSecret(result.serviceRoleKey),
        // On resume the original db password is kept — don't null it out
        ...(result.dbPass ? { db_pass: encryptSecret(result.dbPass) } : {}),
        status: "ready" as const,
        status_detail:
          partialFailures > 0
            ? `Backend ready with warnings: ${failedFunctions.length} function deploy(s) and ${failedSecrets.length} secret sync(s) failed; ${missingSecrets.length} secret(s) awaiting operator input`
            : missingSecrets.length > 0
              ? `Backend ready — ${missingSecrets.length} secret(s) awaiting operator input at /clones/${input.cloneId}/secrets`
              : "Backend is ready — prime architecture replicated",
        migration_version: result.latestMigration,
        source_repo: snapshot.sourceRepo,
        source_ref: snapshot.sourceRef,
        source_sha: snapshot.sourceSha,
        migrations_applied: result.migrationsApplied,
        edge_functions: result.edgeFunctions,
        secret_shells: result.secretShells,
        error_message: null,
      })
      .eq("clone_id", input.cloneId);

    // Persist per-name secret status so operators can drive the fill-in UI.
    if (result.secretShells.length > 0) {
      await supabase.from("clone_backend_secrets").upsert(
        result.secretShells.map((s) => ({
          clone_id: input.cloneId,
          name: s.name,
          status: s.status,
          last_set_at: s.status === "inherited" ? new Date().toISOString() : null,
          last_error: s.error ?? null,
        })),
        { onConflict: "clone_id,name" },
      );
    }

    // ── Per-module migrations for selected modules ──
    // Applied in dependency order; each module's SQL is wrapped in a
    // transaction so partial failures don't leave a half-applied schema.
    const moduleIds = input.moduleIds ?? [];
    let moduleApplyResults: Array<{
      id: string;
      name: string;
      ok: boolean;
      skipped?: boolean;
      error?: string;
    }> = [];
    if (moduleIds.length > 0) {
      const { applyModuleMigrations } = await import(/* @vite-ignore */ "@/server/backend-provisioning.server");
      const { data: mods } = await supabase
        .from("modules")
        .select("id, name, clone_migration_sql, apply_on_install, dependencies")
        .in("id", moduleIds);
      const inputs = (mods ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        sql: m.clone_migration_sql ?? "",
        dependencies: (m.dependencies ?? []) as string[],
        applyOnInstall: m.apply_on_install !== false,
      }));
      moduleApplyResults = await applyModuleMigrations(result.projectRef, inputs, updateStatus);
    }

    const failedModules = moduleApplyResults.filter((r) => !r.ok);

    // Audit log
    await supabase.from("audit_log").insert({
      action: "clone_backend.provisioned",
      entity_type: "clone",
      entity_id: input.cloneId,
      actor_user_id: userId,
      metadata: {
        project_ref: result.projectRef,
        region: input.region || "us-east-1",
        admin_email: input.adminEmail,
        source_repo: snapshot.sourceRepo,
        source_sha: snapshot.sourceSha,
        migrations_applied: result.migrationsApplied.length,
        edge_functions: result.edgeFunctions,
        secret_shells: result.secretShells.map((s) => ({ name: s.name, ok: s.success })),
        storage_buckets: result.storageBuckets,
        module_migrations: moduleApplyResults,
      },
    });

    // Notification
    const failedBuckets = result.storageBuckets.filter((b) => b.status === "failed");
    const warnings = partialFailures + failedModules.length + failedBuckets.length;
    await supabase.from("notifications").insert({
      kind: "clone_created" as const,
      severity: warnings > 0 ? ("warning" as const) : ("success" as const),
      title: `Backend provisioned: ${input.cloneName}`,
      body:
        warnings > 0
          ? `Replica of ${snapshot.sourceRepo} ready (${result.projectRef}) with ${warnings} warning(s) — review the clone page.`
          : `Replicated ${snapshot.sourceRepo}@${snapshot.sourceSha.slice(0, 7)}: ${result.migrationsApplied.length} migrations, ${result.edgeFunctions.length} edge functions, ${result.storageBuckets.length} buckets, ${result.secretShells.length} secret shells (${result.projectRef})`,
      clone_id: input.cloneId,
      url: `/clones/${input.cloneId}`,
      metadata: {
        project_ref: result.projectRef,
        source_repo: snapshot.sourceRepo,
        source_sha: snapshot.sourceSha,
        edge_functions: result.edgeFunctions,
        storage_buckets: result.storageBuckets,
        module_migrations: moduleApplyResults,
      },
    });

    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Backend provisioning failed";

    await supabase
      .from("clone_backends")
      .update({
        status: "failed" as const,
        error_message: msg,
        status_detail: "Provisioning failed",
      })
      .eq("clone_id", input.cloneId);

    return { ok: false, error: msg };
  }
}

/**
 * Worker entry point — called by the pg_cron drain hook after it atomically
 * claims a pending clone_backends row. Runs full provisioning against the
 * admin (service-role) Supabase client, since there is no user request in
 * flight when this executes.
 */
export async function runQueuedBackendProvisioning(input: {
  cloneId: string;
  cloneName: string;
  region?: string;
  adminEmail: string;
  adminPassword: string;
  moduleIds?: string[];
  actorUserId: string | null;
}): Promise<{ ok: true; error?: undefined } | { ok: false; error: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return runBackendProvisioning(supabaseAdmin as any, input.actorUserId ?? "system", {
    cloneId: input.cloneId,
    cloneName: input.cloneName,
    region: input.region,
    adminEmail: input.adminEmail,
    adminPassword: input.adminPassword,
    moduleIds: input.moduleIds,
  });
}

/**
 * Enqueue a dedicated Supabase backend for a clone. Returns as soon as the
 * job row is persisted; the actual provisioning (which takes minutes and
 * exceeds Worker request limits) runs in `hooks/backend-provisioning-drain`
 * on the pg_cron schedule. The admin password is encrypted at rest while
 * queued and cleared once the worker seeds the admin user.
 */
export const provisionBackend = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (input: {
      cloneId: string;
      cloneName: string;
      region?: string;
      adminEmail: string;
      adminPassword: string;
      moduleIds?: string[];
    }) => {
      if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
      if (!input?.cloneName?.trim()) throw new Error("cloneName is required");
      if (!input?.adminEmail?.trim()) throw new Error("adminEmail is required");
      if (!input?.adminPassword || input.adminPassword.length < 8) {
        throw new Error("adminPassword must be at least 8 characters");
      }
      return input;
    },
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; queued: true } | { ok: false; error: string }> => {
      const { supabase, userId } = context;
      const { encryptSecret } = await import(/* @vite-ignore */ "@/server/crypto.server");

      const { data: clone } = await supabase
        .from("clones")
        .select("id, name")
        .eq("id", data.cloneId)
        .single();

      if (!clone) return { ok: false, error: "Clone not found" };

      const { data: existing } = await supabase
        .from("clone_backends")
        .select("id, status")
        .eq("clone_id", data.cloneId)
        .maybeSingle();

      if (existing && existing.status === "ready") {
        return { ok: false, error: "This clone already has a provisioned backend" };
      }

      // ─── Issue #12: single source of truth for moduleIds ──────────────
      // The wizard used to pass `moduleIds` to both provisionClone AND
      // provisionBackend independently. If the picker state drifted between
      // the two calls (network retry, edited selection, race), the freshly-
      // created backend seeded a different module set than what was actually
      // installed on the clone. `clone_modules` is written by provisionClone
      // and is the authoritative record; always resolve from there and treat
      // `data.moduleIds` as a fallback for the (rare) case where the clone
      // has no installed modules yet.
      const { data: installed } = await supabase
        .from("clone_modules")
        .select("module_id")
        .eq("clone_id", data.cloneId);
      const dbModuleIds = (installed ?? []).map((r) => r.module_id).filter(Boolean);
      const resolvedModuleIds = dbModuleIds.length > 0 ? dbModuleIds : (data.moduleIds ?? []);
      if (data.moduleIds && data.moduleIds.length > 0 && dbModuleIds.length > 0) {
        const a = new Set(data.moduleIds);
        const b = new Set(dbModuleIds);
        const drift = a.size !== b.size || [...a].some((x) => !b.has(x));
        if (drift) {
          console.warn(
            "[provisionBackend] moduleIds drift between client input and clone_modules; using clone_modules",
            { cloneId: data.cloneId, input: [...a], installed: [...b] },
          );
        }
      }

      const { error: upsertErr } = await supabase.from("clone_backends").upsert(
        {
          clone_id: data.cloneId,
          status: "pending" as const,
          region: data.region || "us-east-1",
          admin_email: data.adminEmail,
          queued_admin_password_enc: encryptSecret(data.adminPassword),
          queued_module_ids: resolvedModuleIds,
          queued_at: new Date().toISOString(),
          worker_started_at: null,
          worker_finished_at: null,
          attempts: 0,
          enqueued_by: userId,
          error_message: null,
          status_detail: "Queued — background worker will start within ~60 seconds",
        },
        { onConflict: "clone_id" },
      );

      if (upsertErr) return { ok: false, error: upsertErr.message };

      return { ok: true, queued: true };
    },
  );

/**
 * Get the backend status for a clone.
 */
export const getCloneBackendStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { cloneId: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: backend } = await supabase
      .from("clone_backends")
      .select("*")
      .eq("clone_id", data.cloneId)
      .maybeSingle();

    return { backend };
  });

/**
 * Retry a failed backend provisioning. Re-snapshots the prime repo and
 * re-runs the full pipeline; already-applied migrations are skipped via
 * the clone's aurixa.schema_migrations ledger when the project survived.
 */
export const retryBackendProvisioning = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; adminEmail: string; adminPassword: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    if (!input?.adminEmail?.trim()) throw new Error("adminEmail is required");
    if (!input?.adminPassword || input.adminPassword.length < 8) {
      throw new Error("adminPassword must be at least 8 characters");
    }
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; queued: true } | { ok: false; error: string }> => {
      const { supabase, userId } = context;
      const { encryptSecret } = await import(/* @vite-ignore */ "@/server/crypto.server");

      const { data: backend } = await supabase
        .from("clone_backends")
        .select("status, region")
        .eq("clone_id", data.cloneId)
        .maybeSingle();

      if (!backend || backend.status !== "failed") {
        return { ok: false, error: "Can only retry failed provisioning" };
      }

      const { error: upsertErr } = await supabase
        .from("clone_backends")
        .update({
          status: "pending" as const,
          error_message: null,
          queued_admin_password_enc: encryptSecret(data.adminPassword),
          admin_email: data.adminEmail,
          queued_at: new Date().toISOString(),
          worker_started_at: null,
          worker_finished_at: null,
          attempts: 0,
          enqueued_by: userId,
          status_detail: "Requeued — background worker will retry within ~60 seconds",
        })
        .eq("clone_id", data.cloneId);

      if (upsertErr) return { ok: false, error: upsertErr.message };

      return { ok: true, queued: true };
    },
  );

// ─── Clone secret management ────────────────────────────────────────

/** List the per-name secret status for a clone's backend. Admin-only. */
export const listCloneBackendSecrets = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("clone_backend_secrets")
      .select("name, status, last_set_at, last_error, updated_at")
      .eq("clone_id", data.cloneId)
      .order("status", { ascending: true })
      .order("name", { ascending: true });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, secrets: rows ?? [] };
  });

/**
 * Push a real value for a named secret onto the clone's Supabase project
 * and update the tracking row. Admin-only.
 */
export const setCloneBackendSecret = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; name: string; value: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    if (!input?.name?.trim()) throw new Error("name is required");
    if (typeof input?.value !== "string" || input.value.length === 0) {
      throw new Error("value is required");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name)) {
      throw new Error("invalid secret name");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: backend } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, status")
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    if (!backend?.supabase_project_ref) {
      return { ok: false as const, error: "Clone backend not provisioned yet" };
    }
    const { setCloneSecretValue } = await import(/* @vite-ignore */ "@/server/backend-provisioning.server");
    const res = await setCloneSecretValue(backend.supabase_project_ref, data.name, data.value);
    const now = new Date().toISOString();
    await supabase.from("clone_backend_secrets").upsert(
      {
        clone_id: data.cloneId,
        name: data.name,
        status: res.ok ? "set" : "failed",
        last_set_at: res.ok ? now : null,
        last_error: res.ok ? null : res.error,
        set_by: userId,
      },
      { onConflict: "clone_id,name" },
    );
    await supabase.from("audit_log").insert({
      action: "clone_backend.secret_set",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: userId,
      metadata: { name: data.name, ok: res.ok, error: res.ok ? null : res.error },
    });
    return res.ok ? { ok: true as const } : { ok: false as const, error: res.error };
  });

/** List the operator-managed prime→clone secret forwarding whitelist. Admin-only. */
export const listPrimeSecretForwards = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("prime_secret_forwards")
      .select("name, inherit, description, updated_at")
      .order("name", { ascending: true });
    if (error) return { ok: false as const, error: error.message };
    // Attach whether the prime environment actually has a value for each name.
    const rows = (data ?? []).map((r) => ({
      ...r,
      present_in_prime_env:
        typeof process.env[r.name] === "string" && (process.env[r.name] as string).length > 0,
    }));
    return { ok: true as const, forwards: rows };
  });

/** Upsert a prime→clone secret forwarding rule. Admin-only. */
export const upsertPrimeSecretForward = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { name: string; inherit: boolean; description?: string | null }) => {
    if (!input?.name?.trim()) throw new Error("name is required");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name)) {
      throw new Error("invalid secret name");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("prime_secret_forwards").upsert(
      {
        name: data.name,
        inherit: data.inherit,
        description: data.description ?? null,
        created_by: userId,
      },
      { onConflict: "name" },
    );
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

// ─── G6: Incremental module-add against a live isolated backend ─────
//
// Applies newly-enabled modules' SQL to an already-provisioned clone project
// without re-running the full provisioning pipeline. Idempotent via
// `aurixa.module_installations`, transactional per module, and dependency-
// aware — already-installed modules on the same clone are folded into the
// input set so dependency chains resolve correctly even when only a subset
// is being added this call.
export const addModulesToBackend = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; moduleIds: string[] }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    if (!Array.isArray(input?.moduleIds) || input.moduleIds.length === 0) {
      throw new Error("moduleIds must be a non-empty array");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: backend } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, status")
      .eq("clone_id", data.cloneId)
      .maybeSingle();

    if (!backend?.supabase_project_ref) {
      return { ok: false as const, error: "Clone backend not provisioned yet" };
    }
    if (backend.status !== "ready") {
      return {
        ok: false as const,
        error: `Backend is not ready (status: ${backend.status}); wait for provisioning to finish before adding modules`,
      };
    }

    // Fold already-installed modules into the input so dependency ordering
    // resolves against the true installed set. The ledger inside
    // applyModuleMigrations short-circuits them as "skipped".
    const { data: installedRows } = await supabase
      .from("clone_modules")
      .select("module_id")
      .eq("clone_id", data.cloneId);
    const installedIds = new Set(
      (installedRows ?? []).map((r) => r.module_id).filter(Boolean) as string[],
    );
    const requested = new Set(data.moduleIds);
    const combined = Array.from(new Set([...installedIds, ...requested]));

    const { data: mods, error: modsErr } = await supabase
      .from("modules")
      .select("id, name, clone_migration_sql, apply_on_install, dependencies")
      .in("id", combined);
    if (modsErr) return { ok: false as const, error: modsErr.message };

    const inputs = (mods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      sql: m.clone_migration_sql ?? "",
      dependencies: (m.dependencies ?? []) as string[],
      applyOnInstall: m.apply_on_install !== false,
    }));

    const { applyModuleMigrations } = await import(/* @vite-ignore */ "@/server/backend-provisioning.server");
    // Reflect progress on the clone_backends row while migrations run.
    await supabase
      .from("clone_backends")
      .update({ status: "migrating" as const, status_detail: "Adding modules..." })
      .eq("clone_id", data.cloneId);

    const results = await applyModuleMigrations(
      backend.supabase_project_ref,
      inputs,
      async (_status, detail) => {
        await supabase
          .from("clone_backends")
          .update({ status_detail: detail })
          .eq("clone_id", data.cloneId);
      },
    );

    // Restore ready status regardless of individual module outcomes — the
    // backend itself is still healthy; failures are reported per-module.
    const failed = results.filter((r) => !r.ok);
    const succeededRequested = results.filter((r) => r.ok && requested.has(r.id) && !r.skipped);
    await supabase
      .from("clone_backends")
      .update({
        status: "ready" as const,
        status_detail:
          failed.length > 0
            ? `Module add finished with ${failed.length} failure(s)`
            : "Backend is ready — modules added",
      })
      .eq("clone_id", data.cloneId);

    // Record clone_modules rows for newly-installed modules so future adds
    // and the provisioning drain see them as installed.
    if (succeededRequested.length > 0) {
      await supabase.from("clone_modules").upsert(
        succeededRequested.map((r) => ({
          clone_id: data.cloneId,
          module_id: r.id,
          enabled_by: userId,
        })),
        { onConflict: "clone_id,module_id" },
      );
    }

    await supabase.from("audit_log").insert({
      action: "clone_backend.modules_added",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: userId,
      metadata: {
        project_ref: backend.supabase_project_ref,
        requested_module_ids: [...requested],
        results,
      },
    });

    await supabase.from("notifications").insert({
      kind: "clone_created" as const,
      severity: failed.length > 0 ? ("warning" as const) : ("success" as const),
      title: `Modules added to backend`,
      body:
        failed.length > 0
          ? `Added ${succeededRequested.length} module(s) with ${failed.length} failure(s) — review the clone page.`
          : `Added ${succeededRequested.length} module(s) to the clone backend.`,
      clone_id: data.cloneId,
      url: `/clones/${data.cloneId}`,
      metadata: { module_migrations: results },
    });

    return {
      ok: true as const,
      results,
      installed: succeededRequested.map((r) => r.id),
      failed: failed.map((r) => ({ id: r.id, name: r.name, error: r.error })),
    };
  });
