// G16 — Auth users replication.
//
// Copies `auth.users` from the clone's currently-owned Supabase project
// (source) into the client-owned twin project (target) during the
// `twin_ready` / `data_syncing` phase of a handoff. Preserves user id,
// email/phone, confirmation timestamps, bcrypt password hash, and the
// user/app metadata blobs so end users can continue signing in with
// their existing credentials against the twin — no forced reset.
//
// Notes:
//   - The Management API SQL endpoint bypasses RLS on `auth.users`, so we
//     read hashes directly. The write side uses the target's service_role
//     key against the Auth Admin API (`/auth/v1/admin/users`).
//   - Idempotent: users that already exist on the target are treated as
//     `skipped`. We match by id; API errors surfacing "already registered"
//     or 409/422 statuses count as skips.
//   - Batched: users are streamed in pages so a large tenant does not
//     blow the request budget. Failures on individual rows do not abort
//     the run — they are collected into `errors[]` and returned.
//
// The row-level password hash format Supabase issues (`$2a$…` bcrypt) is
// accepted verbatim by `password_hash` on the admin create endpoint.

import { runSqlOnProject, getProjectApiKeys, selectProjectKeys } from "./backend-provisioning.server";

const PAGE_SIZE = 200;
const HARD_LIMIT = 10_000;

export type AuthReplicationInput = {
  sourceRef: string;
  targetRef: string;
  targetPat: string; // decrypted client PAT (Mgmt API scope on their org)
};

export type AuthReplicationOutcome = {
  ok: boolean;
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  errors: Array<{ user_id: string; email: string | null; error: string }>;
};

type AuthUserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  encrypted_password: string | null;
  email_confirmed_at: string | null;
  phone_confirmed_at: string | null;
  banned_until: string | null;
  raw_user_meta_data: Record<string, unknown> | null;
  raw_app_meta_data: Record<string, unknown> | null;
  created_at: string;
};

function rows<T = unknown>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as any).result))
    return (res as any).result as T[];
  return [];
}

async function resolveTargetServiceRole(targetRef: string, targetPat: string): Promise<string> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${targetRef}/api-keys?reveal=true`,
    { headers: { Authorization: `Bearer ${targetPat}` } },
  );
  if (!res.ok) {
    throw new Error(`target_api_keys_${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const keys = await res.json();
  const { serviceRoleKey } = selectProjectKeys(keys as any);
  if (!serviceRoleKey) throw new Error("target_service_role_not_found");
  return serviceRoleKey;
}

async function fetchAuthUsersPage(
  sourceRef: string,
  after: string,
): Promise<AuthUserRow[]> {
  // ISO timestamp cursor. `created_at, id` is a stable strict order on
  // `auth.users` (id is the tiebreaker for identical created_at).
  const sql = `
    select
      id::text as id,
      email,
      phone,
      encrypted_password,
      email_confirmed_at,
      phone_confirmed_at,
      banned_until,
      raw_user_meta_data,
      raw_app_meta_data,
      created_at
    from auth.users
    where created_at > '${after.replace(/'/g, "''")}'::timestamptz
       or (created_at = '${after.replace(/'/g, "''")}'::timestamptz)
    order by created_at asc, id asc
    limit ${PAGE_SIZE};
  `;
  const res = await runSqlOnProject(sourceRef, sql);
  return rows<AuthUserRow>(res);
}

async function importOne(
  targetRef: string,
  serviceRoleKey: string,
  u: AuthUserRow,
): Promise<"imported" | "skipped" | "failed" | string> {
  const body: Record<string, unknown> = {
    id: u.id,
    email: u.email ?? undefined,
    phone: u.phone ?? undefined,
    email_confirm: !!u.email_confirmed_at,
    phone_confirm: !!u.phone_confirmed_at,
    password_hash: u.encrypted_password ?? undefined,
    user_metadata: u.raw_user_meta_data ?? {},
    app_metadata: u.raw_app_meta_data ?? {},
    banned_until: u.banned_until ?? undefined,
  };
  // Drop undefined values so Auth doesn't reject the payload.
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

  const res = await fetch(`https://${targetRef}.supabase.co/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return "imported";
  const text = await res.text().catch(() => "");
  // Idempotency: existing user id / email counts as skipped.
  if (
    res.status === 409 ||
    res.status === 422 ||
    /already (been )?registered|duplicate key|user_already_exists/i.test(text)
  ) {
    return "skipped";
  }
  return `err_${res.status}:${text.slice(0, 240)}`;
}

export async function replicateAuthUsers(
  input: AuthReplicationInput,
): Promise<AuthReplicationOutcome> {
  const { sourceRef, targetRef, targetPat } = input;
  const serviceRole = await resolveTargetServiceRole(targetRef, targetPat);

  let cursor = "1970-01-01T00:00:00Z";
  let scanned = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let truncated = false;
  const errors: AuthReplicationOutcome["errors"] = [];
  const seen = new Set<string>();

  while (scanned < HARD_LIMIT) {
    const page = await fetchAuthUsersPage(sourceRef, cursor);
    if (page.length === 0) break;

    let anyNew = false;
    for (const u of page) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      anyNew = true;
      scanned += 1;
      cursor = u.created_at;

      try {
        const outcome = await importOne(targetRef, serviceRole, u);
        if (outcome === "imported") imported += 1;
        else if (outcome === "skipped") skipped += 1;
        else {
          failed += 1;
          errors.push({ user_id: u.id, email: u.email, error: outcome });
        }
      } catch (e: any) {
        failed += 1;
        errors.push({ user_id: u.id, email: u.email, error: String(e?.message ?? e) });
      }

      if (scanned >= HARD_LIMIT) {
        truncated = true;
        break;
      }
    }
    if (!anyNew) break; // safety valve against cursor stall
    if (page.length < PAGE_SIZE) break;
  }

  return {
    ok: failed === 0,
    scanned,
    imported,
    skipped,
    failed,
    truncated,
    errors: errors.slice(0, 50), // cap payload size
  };
}
