import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  notifications: [] as Array<{ kind: string; title: string; body: string }>,
  /** Rows already in migration_assertion_checks, oldest first. */
  stored: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<Record<string, unknown>>,
  deleted: [] as Array<{ migration: string; assertion: string }>,
  cron: [] as Array<{ jobname: string; active: boolean }>,
  cronError: null as { message: string } | null,
}));

vi.mock("./audit.server", () => ({
  notifyOperators: async (n: { kind: string; title: string; body: string }) => {
    state.notifications.push({ kind: n.kind, title: n.title, body: n.body });
  },
  writeAuditLog: async () => {},
}));

import { runMigrationDrift } from "./migration-drift.server";
import type { MigrationClaims } from "./migrationAssertions.generated";

const URL_BASE = "https://fgpvagejkaeqedcwvbte.supabase.co";
const KEY = "service-role-key-for-tests";

/** Minimal supabase-js double covering exactly the chains the worker uses. */
function fakeSupabase() {
  const from = (table: string): Record<string, unknown> => {
    if (table !== "migration_assertion_checks") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        order: async () => ({ data: state.stored, error: null }),
      }),
      upsert: async (rows: Array<Record<string, unknown>>) => {
        state.upserted.push(...rows);
        return { error: null };
      },
      delete: () => {
        const pending: Record<string, string> = {};
        const chain: Record<string, unknown> = {
          eq: (col: string, val: string) => {
            pending[col] = val;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            state.deleted.push({
              migration: pending.migration ?? "",
              assertion: pending.assertion ?? "",
            });
            return resolve({ error: null });
          },
        };
        return chain;
      },
    };
  };
  return {
    from,
    rpc: async (fn: string) => {
      if (fn !== "cron_delivery_health") throw new Error(`unexpected rpc ${fn}`);
      return state.cronError
        ? { data: null, error: state.cronError }
        : { data: state.cron, error: null };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

type Route = { status: number; body?: unknown; contentRange?: string };

/** A fetch double that records every request and answers from a path map. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const match = Object.keys(routes).find((k) => url.includes(k));
    const r = match ? routes[match] : { status: 500, body: { message: "unrouted" } };
    const headers = new Headers();
    if (r.contentRange) headers.set("content-range", r.contentRange);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers,
      json: async () => r.body ?? {},
    } as unknown as Response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { impl: impl as typeof fetch, calls };
}

const claims = (...cs: MigrationClaims[]): readonly MigrationClaims[] => cs;

const run = (
  cs: readonly MigrationClaims[],
  routes: Record<string, Route>,
  extra: Parameters<typeof runMigrationDrift>[1] = {},
) => {
  const f = fakeFetch(routes);
  return runMigrationDrift(fakeSupabase(), {
    claims: cs,
    fetchImpl: f.impl,
    supabaseUrl: URL_BASE,
    serviceRoleKey: KEY,
    ...extra,
  }).then((result) => ({ result, calls: f.calls }));
};

beforeEach(() => {
  state.notifications = [];
  state.stored = [];
  state.upserted = [];
  state.deleted = [];
  state.cron = [];
  state.cronError = null;
});

const TABLE_CLAIM: MigrationClaims = {
  migration: "20260828020000_x.sql",
  version: "20260828020000",
  assertions: [{ kind: "table", table: "migration_assertion_checks" }],
};

describe("runMigrationDrift", () => {
  it("records a claim the schema confirms", async () => {
    const { result } = await run(claims(TABLE_CLAIM), {
      "/rest/v1/migration_assertion_checks?select=*": { status: 200 },
    });
    expect(result.summary).toMatchObject({ checked: 1, satisfied: 1, unsatisfied: 0 });
    expect(state.upserted[0]).toMatchObject({
      migration: "20260828020000_x.sql",
      assertion: "table:migration_assertion_checks",
      status: "satisfied",
    });
    expect(state.upserted[0].last_satisfied_at).toEqual(state.upserted[0].checked_at);
    expect(state.notifications).toHaveLength(0);
  });

  it("raises the alarm for a claim the schema contradicts", async () => {
    const { result } = await run(claims(TABLE_CLAIM), {
      "/rest/v1/migration_assertion_checks?select=*": {
        status: 404,
        body: { code: "PGRST205" },
      },
    });
    expect(result.summary.unsatisfied).toBe(1);
    expect(result.newlyDrifted).toHaveLength(1);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].kind).toBe("migration_drift");
    expect(state.notifications[0].body).toContain("migration_assertion_checks");
  });

  it("does not re-raise a drift that is already standing", async () => {
    // An alarm that re-fires hourly on a finding somebody has already seen is
    // how the next one gets missed.
    state.stored = [
      {
        migration: "20260828020000_x.sql",
        assertion: "table:migration_assertion_checks",
        status: "unsatisfied",
        last_satisfied_at: null,
        checked_at: "2026-08-28T00:00:00.000Z",
      },
    ];
    const { result } = await run(claims(TABLE_CLAIM), {
      "/rest/v1/migration_assertion_checks?select=*": {
        status: 404,
        body: { code: "PGRST205" },
      },
    });
    expect(result.summary.unsatisfied).toBe(1);
    expect(result.newlyDrifted).toEqual([]);
    expect(state.notifications).toHaveLength(0);
  });

  /**
   * The rule the whole design turns on. A 503 is the probe failing, not the
   * table being absent — and the remedies are opposite ends of the building.
   */
  it("never reports an unreachable database as drift", async () => {
    const { result } = await run(claims(TABLE_CLAIM), {
      "/rest/v1/migration_assertion_checks?select=*": { status: 503, body: {} },
    });
    expect(result.summary.unsatisfied).toBe(0);
    expect(result.summary.errors).toBe(1);
    expect(state.notifications).toHaveLength(0);
    expect(state.upserted[0].status).toBe("error");
  });

  it("keeps last_satisfied_at across a later failure", async () => {
    state.stored = [
      {
        migration: "20260828020000_x.sql",
        assertion: "table:migration_assertion_checks",
        status: "satisfied",
        last_satisfied_at: "2026-08-27T12:00:00.000Z",
        checked_at: "2026-08-28T00:00:00.000Z",
      },
    ];
    await run(claims(TABLE_CLAIM), {
      "/rest/v1/migration_assertion_checks?select=*": { status: 503, body: {} },
    });
    expect(state.upserted[0].last_satisfied_at).toBe("2026-08-27T12:00:00.000Z");
  });

  it("answers a column claim from the column selector", async () => {
    const { result, calls } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [{ kind: "column", table: "clone_backends", column: "worker_started_at" }],
      }),
      { "/rest/v1/clone_backends?select=worker_started_at": { status: 200 } },
    );
    expect(result.summary.satisfied).toBe(1);
    expect(calls[0]).toContain("select=worker_started_at");
  });

  it("reads a row count off content-range and probes one table once", async () => {
    // `rows:t>=17` and `rows:t>=3` are one COUNT. Two thresholds must not cost
    // two round trips.
    const { result, calls } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [
          { kind: "rows", table: "mirror_exclusions", atLeast: 17 },
          { kind: "rows", table: "mirror_exclusions", atLeast: 900 },
        ],
      }),
      { "/rest/v1/mirror_exclusions": { status: 200, contentRange: "*/42" } },
    );
    expect(result.probed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(result.summary).toMatchObject({ satisfied: 1, unsatisfied: 1 });
  });

  it("refuses to guess a count when the table does not answer", async () => {
    // Reporting 0 would fail a `rows:` claim with "holds 0 rows" and send
    // somebody looking for a seed script for a table that was never created.
    const { result } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [{ kind: "rows", table: "nope", atLeast: 1 }],
      }),
      { "/rest/v1/nope": { status: 404, body: { code: "PGRST205" } } },
    );
    expect(result.summary.errors).toBe(1);
    expect(result.summary.unsatisfied).toBe(0);
  });

  /**
   * Probing a function by invoking it is how a checker fires a webhook, drains
   * a queue, or charges a card to find out whether something exists.
   */
  it("answers an rpc claim from the schema description, never by calling it", async () => {
    const { result, calls } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [
          { kind: "rpc", fn: "cron_delivery_health" },
          { kind: "rpc", fn: "definitely_not_here" },
        ],
      }),
      {
        "/rest/v1/": {
          status: 200,
          body: { paths: { "/": {}, "/clones": {}, "/rpc/cron_delivery_health": {} } },
        },
      },
    );
    expect(result.summary).toMatchObject({ satisfied: 1, unsatisfied: 1 });
    expect(calls.filter((c) => c.includes("/rpc/"))).toEqual([]);
  });

  it("reports an unreadable schema description as an error, not as missing functions", async () => {
    const { result } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [{ kind: "rpc", fn: "cron_delivery_health" }],
      }),
      { "/rest/v1/": { status: 401, body: { message: "Invalid API key" } } },
    );
    expect(result.summary.errors).toBe(1);
    expect(result.summary.unsatisfied).toBe(0);
  });

  it("answers a cron claim from cron_delivery_health, and calls it once", async () => {
    state.cron = [
      { jobname: "migration-drift-hourly", active: true },
      { jobname: "legacy-job", active: false },
    ];
    const { result } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [
          { kind: "cron", jobname: "migration-drift-hourly" },
          { kind: "cron", jobname: "legacy-job" },
          { kind: "cron", jobname: "never-scheduled" },
        ],
      }),
      {},
    );
    expect(result.summary).toMatchObject({ satisfied: 1, unsatisfied: 2 });
  });

  it("reports an enum claim as unassertable and never as satisfied", async () => {
    const { result, calls } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [{ kind: "enum", type: "notification_kind" }],
      }),
      {},
    );
    expect(result.summary).toMatchObject({ unassertable: 1, checked: 0, satisfied: 0 });
    expect(calls).toEqual([]);
    expect(state.upserted[0].status).toBe("unassertable");
  });

  /**
   * A deferred claim is not a verdict. Writing "unassertable" over yesterday's
   * "unsatisfied" would clear an open alarm by running out of budget.
   */
  it("defers rather than overwriting a stored verdict when the budget runs out", async () => {
    const { result } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [
          { kind: "table", table: "one" },
          { kind: "table", table: "two" },
          { kind: "table", table: "three" },
        ],
      }),
      { "/rest/v1/": { status: 200 } },
      { maxTargets: 1 },
    );
    expect(result.probed).toBe(1);
    expect(result.deferred).toBe(2);
    expect(state.upserted).toHaveLength(1);
  });

  it("stops probing when the wall-clock budget is spent", async () => {
    let t = 0;
    const { result } = await run(
      claims({
        migration: "a.sql",
        version: "1",
        assertions: [
          { kind: "table", table: "one" },
          { kind: "table", table: "two" },
        ],
      }),
      { "/rest/v1/": { status: 200 } },
      // First call sets the start, the next tick is already past the budget.
      { now: () => (t += 5_000), budgetMs: 1 },
    );
    expect(result.probed).toBe(1);
    expect(result.deferred).toBe(1);
  });

  it("prunes a stored row whose claim no longer exists", async () => {
    // A claim that has been edited leaves a row behind, and an alarm nobody can
    // clear is one people learn to ignore.
    state.stored = [
      {
        migration: "deleted.sql",
        assertion: "table:gone",
        status: "unsatisfied",
        last_satisfied_at: null,
        checked_at: "2026-08-01T00:00:00.000Z",
      },
    ];
    const { result } = await run(claims(TABLE_CLAIM), {
      "/rest/v1/migration_assertion_checks?select=*": { status: 200 },
    });
    expect(result.pruned).toBe(1);
    expect(state.deleted).toEqual([{ migration: "deleted.sql", assertion: "table:gone" }]);
  });

  it("checks never-seen claims before ones it checked an hour ago", async () => {
    state.stored = [
      {
        migration: "old.sql",
        assertion: "table:old",
        status: "satisfied",
        last_satisfied_at: "2026-08-01T00:00:00.000Z",
        checked_at: "2026-08-01T00:00:00.000Z",
      },
    ];
    const { calls } = await run(
      claims(
        {
          migration: "old.sql",
          version: "1",
          assertions: [{ kind: "table", table: "old" }],
        },
        { migration: "new.sql", version: "2", assertions: [{ kind: "table", table: "fresh" }] },
      ),
      { "/rest/v1/": { status: 200 } },
      { maxTargets: 1 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/fresh?");
  });

  it("refuses to run without the credential it reads with", async () => {
    await expect(
      runMigrationDrift(fakeSupabase(), {
        claims: claims(TABLE_CLAIM),
        supabaseUrl: URL_BASE,
        serviceRoleKey: "",
      }),
    ).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
