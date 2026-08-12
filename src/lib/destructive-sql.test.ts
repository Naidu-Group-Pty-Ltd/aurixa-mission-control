import { describe, expect, it } from "vitest";
import { assessSqlDestructiveness, stripSqlLiterals } from "./destructive-sql";

describe("stripSqlLiterals", () => {
  it("removes line comments, block comments, strings and dollar-quoted bodies", () => {
    const sql = [
      "-- DROP TABLE in a comment",
      "SELECT 'DROP TABLE users', /* TRUNCATE x */ 1;",
      "DO $fn$ TRUNCATE hidden $fn$;",
    ].join("\n");
    const stripped = stripSqlLiterals(sql);
    expect(stripped).not.toMatch(/DROP TABLE/);
    expect(stripped).not.toMatch(/TRUNCATE/);
    expect(stripped).toMatch(/SELECT/);
  });

  it("survives an escaped quote inside a string", () => {
    const stripped = stripSqlLiterals(
      "SELECT 'it''s a DROP TABLE trap'; DELETE FROM t WHERE id = 1;",
    );
    expect(stripped).not.toMatch(/DROP TABLE/);
    expect(stripped).toMatch(/DELETE FROM t/);
  });
});

describe("assessSqlDestructiveness", () => {
  it("passes the shape of an ordinary additive migration", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS public.widgets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.widgets ADD COLUMN IF NOT EXISTS color TEXT;
      CREATE INDEX IF NOT EXISTS widgets_name_idx ON public.widgets(name);
      GRANT SELECT, INSERT ON public.widgets TO authenticated;
      ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
      UPDATE public.widgets SET color = 'blue' WHERE color IS NULL;
    `;
    const result = assessSqlDestructiveness(sql);
    expect(result.destructive).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.statementCount).toBeGreaterThan(3);
  });

  it("accepts the house drop-and-recreate trigger idiom", () => {
    const sql = `
      DROP TRIGGER IF EXISTS trg_widgets_updated ON public.widgets;
      CREATE TRIGGER trg_widgets_updated BEFORE UPDATE ON public.widgets
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    `;
    expect(assessSqlDestructiveness(sql).destructive).toBe(false);
  });

  it.each([
    ["DROP TABLE public.users;", "drops a table"],
    ["DROP SCHEMA analytics CASCADE;", "drops a schema"],
    ["TRUNCATE public.audit_log;", "truncates a table"],
    ["ALTER TABLE public.users DROP COLUMN email;", "drops a column"],
    ["DELETE FROM public.users;", "DELETE without WHERE"],
    ["UPDATE public.users SET plan = NULL;", "UPDATE without WHERE"],
    ["ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;", "disables row-level security"],
    ['DROP POLICY "users read own" ON public.users;', "drops a row-level-security policy"],
    ["GRANT ALL ON public.users TO anon;", "grants privileges to anon/public"],
    ["DROP FUNCTION public.compute_totals(uuid);", "drops a function without recreating it"],
  ])("flags %s", (sql, reason) => {
    const result = assessSqlDestructiveness(sql);
    expect(result.destructive).toBe(true);
    expect(result.findings.map((f) => f.reason)).toContain(reason);
  });

  it("does not flag destructive keywords hidden in literals or comments", () => {
    const sql = `
      -- This migration replaces the old DROP TABLE approach
      INSERT INTO public.notes (body) VALUES ('remember: never TRUNCATE prod');
    `;
    expect(assessSqlDestructiveness(sql).destructive).toBe(false);
  });

  it("flags every offending statement, not just the first", () => {
    const sql = `
      DROP TABLE a;
      DROP TABLE b;
      DELETE FROM c;
    `;
    const result = assessSqlDestructiveness(sql);
    expect(result.findings.length).toBe(3);
  });

  it("treats a DELETE with a WHERE clause as safe", () => {
    expect(
      assessSqlDestructiveness("DELETE FROM public.sessions WHERE expires_at < now();").destructive,
    ).toBe(false);
  });
});
