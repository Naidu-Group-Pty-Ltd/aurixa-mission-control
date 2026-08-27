import { describe, it, expect, beforeEach } from "vitest";
import { enqueueMigrations, readMigrationStatus } from "./migration-enqueue.server";
import type { MigrationSubmission, QueueRow } from "./migrationQueue.pure";

type Row = QueueRow & { sql?: string; sha256?: string; enqueued_by?: string };

const state = {
  rows: [] as Row[],
  insertError: null as { message: string } | null,
  readError: null as { message: string } | null,
  inserted: [] as Record<string, unknown>[],
};

/** Minimal supabase-js double covering exactly the chains this module uses. */
function fakeSupabase() {
  const from = (table: string) => {
    if (table !== "schema_migration_queue") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        in: async (_col: string, values: string[]) =>
          state.readError
            ? { data: null, error: state.readError }
            : { data: state.rows.filter((r) => values.includes(r.version)), error: null },
      }),
      upsert: (rows: Record<string, unknown>[]) => ({
        select: async () => {
          if (state.insertError) return { data: null, error: state.insertError };
          const fresh = rows.filter(
            (r) => !state.rows.some((e) => e.version === (r.version as string)),
          );
          for (const r of fresh) {
            state.inserted.push(r);
            state.rows.push({
              version: r.version as string,
              name: r.name as string,
              status: "queued",
              attempts: 0,
              error: null,
            });
          }
          return { data: fresh.map((r) => ({ version: r.version })), error: null };
        },
      }),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any;
}

const sub = (over: Partial<MigrationSubmission> = {}): MigrationSubmission => ({
  version: "20260828030000",
  name: "20260828030000_a.sql",
  sql: "create table public.a ();",
  ...over,
});

beforeEach(() => {
  state.rows = [];
  state.insertError = null;
  state.readError = null;
  state.inserted = [];
});

describe("enqueueMigrations", () => {
  it("writes a fresh migration and reports it pending", async () => {
    const r = await enqueueMigrations(fakeSupabase(), [sub()]);
    expect(r.enqueued).toEqual(["20260828030000"]);
    expect(r.verdict.pending).toEqual(["20260828030000"]);
    expect(r.verdict.settled).toBe(false);
  });

  it("records a digest of the sql, so what ran can be compared to the repo", async () => {
    await enqueueMigrations(fakeSupabase(), [sub()]);
    expect(state.inserted[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries who submitted it", async () => {
    await enqueueMigrations(fakeSupabase(), [sub()], { enqueuedBy: "run/42" });
    expect(state.inserted[0].enqueued_by).toBe("run/42");
  });

  /**
   * `cron.schedule` calls and seed INSERTs in this corpus are not idempotent,
   * so a re-run of the same push must enqueue nothing rather than apply twice.
   */
  it("is a no-op on a version already queued", async () => {
    state.rows = [
      {
        version: "20260828030000",
        name: "20260828030000_a.sql",
        status: "queued",
        attempts: 0,
        error: null,
      },
    ];
    const r = await enqueueMigrations(fakeSupabase(), [sub()]);
    expect(r.enqueued).toEqual([]);
    expect(r.alreadyQueued).toEqual(["20260828030000"]);
    expect(state.inserted).toEqual([]);
  });

  it("never re-submits a version this queue already applied", async () => {
    state.rows = [
      {
        version: "20260828030000",
        name: "20260828030000_a.sql",
        status: "applied",
        attempts: 1,
        error: null,
      },
    ];
    const r = await enqueueMigrations(fakeSupabase(), [sub()]);
    expect(r.alreadyApplied).toEqual(["20260828030000"]);
    expect(r.alreadyQueued).toEqual([]);
    expect(r.verdict.settled).toBe(true);
  });

  it("never rewrites the sql of a version already on the queue", async () => {
    // Editing an applied migration is the mistake; running the new text over
    // the old one is the damage.
    state.rows = [
      {
        version: "20260828030000",
        name: "20260828030000_a.sql",
        status: "queued",
        attempts: 0,
        error: null,
      },
    ];
    await enqueueMigrations(fakeSupabase(), [sub({ sql: "drop table public.a;" })]);
    expect(state.inserted).toEqual([]);
  });

  it("reports rejections without enqueuing the batch's good files twice", async () => {
    const r = await enqueueMigrations(fakeSupabase(), [
      sub(),
      sub({ version: "20260828030001", name: "bad-name.sql" }),
    ]);
    expect(r.enqueued).toEqual(["20260828030000"]);
    expect(r.rejected).toHaveLength(1);
  });

  /** A read that FAILED is not a queue that is EMPTY, and the remedies differ. */
  it("throws rather than reporting an unreadable queue as empty", async () => {
    state.readError = { message: "57P01 server closed the connection" };
    await expect(enqueueMigrations(fakeSupabase(), [sub()])).rejects.toThrow(/57P01/);
  });

  it("throws when the write fails, rather than reporting success", async () => {
    state.insertError = { message: "42501 permission denied" };
    await expect(enqueueMigrations(fakeSupabase(), [sub()])).rejects.toThrow(/42501/);
  });
});

describe("readMigrationStatus", () => {
  it("settles once every version is applied", async () => {
    state.rows = [
      { version: "20260828030000", name: "a.sql", status: "applied", attempts: 1, error: null },
    ];
    const r = await readMigrationStatus(fakeSupabase(), ["20260828030000"]);
    expect(r.verdict.settled).toBe(true);
    expect(r.verdict.applied).toEqual(["20260828030000"]);
  });

  it("carries the failure detail so CI can print it against the file", async () => {
    state.rows = [
      {
        version: "20260828030000",
        name: "20260828030000_a.sql",
        status: "failed",
        attempts: 3,
        error: '42P07 relation "a" already exists',
      },
    ];
    const r = await readMigrationStatus(fakeSupabase(), ["20260828030000"]);
    expect(r.verdict.settled).toBe(true);
    expect(r.verdict.failed[0].error).toContain("42P07");
  });

  it("separates a version the queue never received from one still waiting", async () => {
    state.rows = [
      { version: "20260828030000", name: "a.sql", status: "queued", attempts: 0, error: null },
    ];
    const r = await readMigrationStatus(fakeSupabase(), ["20260828030000", "20260828039999"]);
    expect(r.verdict.pending).toEqual(["20260828030000"]);
    expect(r.verdict.missing).toEqual(["20260828039999"]);
  });
});
