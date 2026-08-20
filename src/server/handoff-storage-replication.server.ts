// G17 — Storage objects replication.
//
// Bulk-copies every object in every storage bucket from the clone's
// currently-owned Supabase project (source) into the client-owned twin
// (target) during the `data_syncing` phase of a handoff.
//
// Distinct from `replicateStorageBuckets` (G2), which caps at 500 objects
// / 512 MB per bucket for seed-asset replication at twin-provisioning
// time. G17 has no per-bucket cap — it just paces itself with a per-
// invocation object + byte budget and is idempotent (upserts by path;
// skips objects that already exist on the target). Operators re-invoke
// until the ledger reports every bucket `complete`.
//
// Reads on the source use our `SB_MGMT_API_TOKEN` (the clone's dedicated
// backend still lives in our Supabase organisation). Writes on the twin
// use the client's PAT to fetch that project's service_role key.

import { selectProjectKeys, getProjectApiKeys, getProjectUrl } from "./backend-provisioning.server";

// ─── Config ─────────────────────────────────────────────────────────────

/**
 * Per-invocation safety caps. Operators re-invoke to finish larger buckets.
 * These bound Worker CPU + memory + upstream bandwidth per request.
 */
const PER_INVOCATION = {
  maxObjects: 400,          // total objects copied+skipped across all buckets
  maxBytes: 400 * 1024 * 1024, // 400 MB uploaded across all buckets
  maxWallMs: 45_000,        // stop early to leave room for state flush
  maxBytesPerObject: 100 * 1024 * 1024, // 100 MB per object hard cap
};

const LIST_PAGE_SIZE = 100;

// ─── Types ──────────────────────────────────────────────────────────────

export type StorageReplicationInput = {
  sourceRef: string;
  targetRef: string;
  targetPat: string;
  /**
   * Per-bucket resume state from `handoff_storage_replications`. If a
   * bucket already has `status = complete`, it is skipped without listing.
   */
  bucketStates: Array<{
    bucket_id: string;
    status: string;
    cursor_prefix: string | null;
  }>;
};

export type BucketRunOutcome = {
  bucket_id: string;
  status: "complete" | "in_progress" | "failed";
  objects_scanned: number;
  objects_copied: number;
  objects_skipped: number;
  objects_failed: number;
  bytes_copied: number;
  cursor_prefix: string | null;
  last_error?: string;
};

export type StorageReplicationOutcome = {
  ok: boolean;
  incomplete: boolean;
  budget_exhausted: "objects" | "bytes" | "time" | null;
  buckets: BucketRunOutcome[];
};

type StorageObjectEntry = {
  name: string;
  id: string | null;
  metadata: { size?: number; mimetype?: string } | null;
};

// ─── Key resolution ─────────────────────────────────────────────────────

async function resolveSourceServiceRole(sourceRef: string): Promise<string> {
  const { serviceRoleKey } = selectProjectKeys(await getProjectApiKeys(sourceRef));
  if (!serviceRoleKey) throw new Error("source_service_role_not_found");
  return serviceRoleKey;
}

async function resolveTargetServiceRole(targetRef: string, targetPat: string): Promise<string> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${targetRef}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${targetPat}` } },
  );
  if (!res.ok) {
    throw new Error(`target_api_keys_${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const { serviceRoleKey } = selectProjectKeys((await res.json()) as any);
  if (!serviceRoleKey) throw new Error("target_service_role_not_found");
  return serviceRoleKey;
}

// ─── Storage helpers ────────────────────────────────────────────────────

function encodeStoragePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function listBuckets(projectUrl: string, serviceKey: string): Promise<Array<{ id: string }>> {
  const res = await fetch(`${projectUrl}/storage/v1/bucket`, {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (!res.ok) {
    throw new Error(`list_buckets_${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
  return (await res.json()) as Array<{ id: string }>;
}

async function listBucketFolder(
  projectUrl: string,
  serviceKey: string,
  bucketId: string,
  prefix: string,
): Promise<StorageObjectEntry[]> {
  const out: StorageObjectEntry[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await fetch(`${projectUrl}/storage/v1/object/list/${bucketId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix,
        limit: LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    });
    if (!res.ok) {
      throw new Error(`list_${bucketId}_${res.status}: ${(await res.text()).slice(0, 240)}`);
    }
    const rows = (await res.json()) as StorageObjectEntry[];
    out.push(...rows);
    if (rows.length < LIST_PAGE_SIZE) break;
    offset += LIST_PAGE_SIZE;
  }
  return out;
}

async function targetObjectExists(
  targetUrl: string,
  targetKey: string,
  bucketId: string,
  path: string,
): Promise<boolean> {
  const res = await fetch(
    `${targetUrl}/storage/v1/object/info/${bucketId}/${encodeStoragePath(path)}`,
    { headers: { Authorization: `Bearer ${targetKey}`, apikey: targetKey } },
  );
  return res.ok;
}

async function copyObject(
  sourceUrl: string,
  sourceKey: string,
  targetUrl: string,
  targetKey: string,
  bucketId: string,
  path: string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string; skipped?: boolean }> {
  const dl = await fetch(
    `${sourceUrl}/storage/v1/object/${bucketId}/${encodeStoragePath(path)}`,
    { headers: { Authorization: `Bearer ${sourceKey}`, apikey: sourceKey } },
  );
  if (!dl.ok) return { ok: false, error: `download_${dl.status}` };
  const contentType = dl.headers.get("content-type") ?? "application/octet-stream";
  const buf = await dl.arrayBuffer();
  if (buf.byteLength > PER_INVOCATION.maxBytesPerObject) {
    return { ok: false, error: "object_exceeds_per_object_cap", skipped: true };
  }
  const up = await fetch(
    `${targetUrl}/storage/v1/object/${bucketId}/${encodeStoragePath(path)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${targetKey}`,
        apikey: targetKey,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: buf,
    },
  );
  if (!up.ok) return { ok: false, error: `upload_${up.status}:${(await up.text()).slice(0, 200)}` };
  return { ok: true, bytes: buf.byteLength };
}

// ─── Engine ─────────────────────────────────────────────────────────────

export async function replicateStorageObjects(
  input: StorageReplicationInput,
): Promise<StorageReplicationOutcome> {
  const started = Date.now();
  const sourceUrl = getProjectUrl(input.sourceRef);
  const targetUrl = getProjectUrl(input.targetRef);
  const sourceKey = await resolveSourceServiceRole(input.sourceRef);
  const targetKey = await resolveTargetServiceRole(input.targetRef, input.targetPat);

  // Discover buckets from BOTH sides so a bucket that already exists on
  // target (created by G2 replicateStorageBuckets) is still considered.
  const [sourceBuckets, targetBuckets] = await Promise.all([
    listBuckets(sourceUrl, sourceKey),
    listBuckets(targetUrl, targetKey).catch(() => [] as Array<{ id: string }>),
  ]);
  const targetSet = new Set(targetBuckets.map((b) => b.id));

  // Prefer source-side bucket ids as the canonical list.
  const bucketIds = sourceBuckets.map((b) => b.id);
  const stateByBucket = new Map(input.bucketStates.map((s) => [s.bucket_id, s]));

  const outcomes: BucketRunOutcome[] = [];
  let totalObjects = 0;
  let totalBytes = 0;
  let exhausted: StorageReplicationOutcome["budget_exhausted"] = null;
  let incomplete = false;

  outer: for (const bucketId of bucketIds) {
    const prior = stateByBucket.get(bucketId);
    if (prior?.status === "complete") {
      // Fully done — leave last-known counts alone.
      outcomes.push({
        bucket_id: bucketId,
        status: "complete",
        objects_scanned: 0,
        objects_copied: 0,
        objects_skipped: 0,
        objects_failed: 0,
        bytes_copied: 0,
        cursor_prefix: prior.cursor_prefix,
      });
      continue;
    }
    if (!targetSet.has(bucketId)) {
      // No target bucket yet — record as failed with hint. Provisioning /
      // G2 should have created it during twin_provisioning.
      outcomes.push({
        bucket_id: bucketId,
        status: "failed",
        objects_scanned: 0,
        objects_copied: 0,
        objects_skipped: 0,
        objects_failed: 0,
        bytes_copied: 0,
        cursor_prefix: prior?.cursor_prefix ?? null,
        last_error: "target_bucket_missing",
      });
      incomplete = true;
      continue;
    }

    const cursor = prior?.cursor_prefix ?? "";
    let scanned = 0;
    let copied = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;
    let lastCopiedPath: string | null = cursor || null;
    let lastError: string | undefined;
    let bucketComplete = true;

    // BFS through source bucket. Skip any path <= cursor lexicographically.
    const queue: string[] = [""];
    try {
      while (queue.length > 0) {
        const prefix = queue.shift()!;
        const rows = await listBucketFolder(sourceUrl, sourceKey, bucketId, prefix);
        for (const row of rows) {
          const path = prefix ? `${prefix}/${row.name}` : row.name;
          if (row.id === null) {
            // subfolder
            queue.push(path);
            continue;
          }
          scanned += 1;
          // Resume: skip anything already past the cursor watermark.
          if (cursor && path <= cursor) {
            skipped += 1;
            continue;
          }
          // Budget checks BEFORE spending download bandwidth.
          if (totalObjects >= PER_INVOCATION.maxObjects) {
            exhausted = "objects"; bucketComplete = false; break;
          }
          if (totalBytes >= PER_INVOCATION.maxBytes) {
            exhausted = "bytes"; bucketComplete = false; break;
          }
          if (Date.now() - started >= PER_INVOCATION.maxWallMs) {
            exhausted = "time"; bucketComplete = false; break;
          }
          // Idempotency: skip if already present on target.
          if (await targetObjectExists(targetUrl, targetKey, bucketId, path)) {
            skipped += 1;
            lastCopiedPath = path;
            totalObjects += 1;
            continue;
          }
          const r = await copyObject(sourceUrl, sourceKey, targetUrl, targetKey, bucketId, path);
          if (r.ok) {
            copied += 1;
            bytes += r.bytes;
            totalBytes += r.bytes;
            lastCopiedPath = path;
          } else if ("skipped" in r && r.skipped) {
            skipped += 1;
            lastCopiedPath = path;
            lastError = r.error;
          } else {
            failed += 1;
            lastError = r.error;
            // don't advance cursor — next run will retry the same object
          }
          totalObjects += 1;
        }
        if (!bucketComplete) break;
      }
    } catch (e: any) {
      failed += 1;
      lastError = String(e?.message ?? e);
      bucketComplete = false;
    }

    outcomes.push({
      bucket_id: bucketId,
      status: bucketComplete && failed === 0 ? "complete" : failed > 0 && !exhausted ? "failed" : "in_progress",
      objects_scanned: scanned,
      objects_copied: copied,
      objects_skipped: skipped,
      objects_failed: failed,
      bytes_copied: bytes,
      cursor_prefix: lastCopiedPath,
      last_error: lastError,
    });

    if (!bucketComplete) incomplete = true;
    if (exhausted) break outer;
  }

  return {
    ok: outcomes.every((o) => o.status !== "failed"),
    incomplete,
    budget_exhausted: exhausted,
    buckets: outcomes,
  };
}
