// Pure destructiveness analysis for SQL that the self-healing pipeline wants
// to run against a tenant project. A migration the pipeline applies on its
// own must not be able to destroy data or quietly widen access — anything
// this module flags routes to a human instead of executing.
//
// This is a guardrail, not a SQL parser: it works on comment- and
// string-stripped statements, and it deliberately errs toward flagging.
// A false positive costs one human approval; a false negative costs a
// tenant's table.

export type SqlRiskFinding = {
  /** First 200 chars of the offending statement, for the approval UI. */
  statement: string;
  reason: string;
};

export type SqlRiskAssessment = {
  destructive: boolean;
  findings: SqlRiskFinding[];
  statementCount: number;
};

/**
 * Remove comments, string literals and dollar-quoted bodies so keyword
 * checks can't be fooled by (or false-positive on) text inside them.
 * Literal content is replaced with a space; statement structure survives.
 */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    // Line comment
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      out += " ";
      continue;
    }
    // Block comment (no nesting — postgres nests, but flagging early is fine)
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    // Dollar-quoted string: $tag$ ... $tag$
    if (sql[i] === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " ";
        continue;
      }
    }
    // Single-quoted string with '' escape
    if (sql[i] === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

type Rule = { pattern: RegExp; reason: string };

// Order matters only for readability; every rule runs on every statement.
const DESTRUCTIVE_RULES: Rule[] = [
  { pattern: /\bDROP\s+DATABASE\b/i, reason: "drops a database" },
  { pattern: /\bDROP\s+SCHEMA\b/i, reason: "drops a schema" },
  { pattern: /\bDROP\s+TABLE\b/i, reason: "drops a table" },
  { pattern: /\bDROP\s+(OWNED|ROLE|USER)\b/i, reason: "drops a role or role-owned objects" },
  { pattern: /\bDROP\s+POLICY\b/i, reason: "drops a row-level-security policy" },
  { pattern: /\bTRUNCATE\b/i, reason: "truncates a table" },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i,
    reason: "drops a column",
  },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    reason: "disables row-level security",
  },
  {
    pattern: /\bGRANT\b[\s\S]*\bTO\s+(anon|public)\b/i,
    reason: "grants privileges to anon/public",
  },
  { pattern: /\bALTER\s+ROLE\b/i, reason: "alters a role" },
  {
    pattern: /\bALTER\s+(TABLE|COLUMN)\b[\s\S]*\bTYPE\b/i,
    reason: "rewrites a column type (potentially lossy cast)",
  },
];

/** DELETE/UPDATE with no WHERE clause hit every row in the table. */
function checkUnboundedWrite(statement: string): string | null {
  const isDelete = /^\s*DELETE\s+FROM\b/i.test(statement);
  const isUpdate = /^\s*UPDATE\b/i.test(statement);
  if (!isDelete && !isUpdate) return null;
  if (/\bWHERE\b/i.test(statement)) return null;
  return isDelete ? "DELETE without WHERE" : "UPDATE without WHERE";
}

/**
 * DROP FUNCTION / DROP TRIGGER / DROP VIEW are routine in idempotent
 * migrations when the same script recreates the object. Only flag them
 * when the script does not.
 */
function checkDropWithoutRecreate(statement: string, wholeScript: string): string | null {
  if (/\bDROP\s+(FUNCTION|TRIGGER|VIEW)\b/i.test(statement)) {
    const kind = /\bDROP\s+(FUNCTION|TRIGGER|VIEW)\b/i.exec(statement)![1].toUpperCase();
    const recreates = new RegExp(
      `\\bCREATE\\s+(OR\\s+REPLACE\\s+)?(CONSTRAINT\\s+)?${kind}\\b`,
      "i",
    );
    if (!recreates.test(wholeScript)) {
      return `drops a ${kind.toLowerCase()} without recreating it`;
    }
  }
  return null;
}

export function assessSqlDestructiveness(sql: string): SqlRiskAssessment {
  const stripped = stripSqlLiterals(sql);
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const findings: SqlRiskFinding[] = [];
  for (const statement of statements) {
    const excerpt = statement.replace(/\s+/g, " ").slice(0, 200);
    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.pattern.test(statement)) {
        findings.push({ statement: excerpt, reason: rule.reason });
      }
    }
    const unbounded = checkUnboundedWrite(statement);
    if (unbounded) findings.push({ statement: excerpt, reason: unbounded });
    const dropped = checkDropWithoutRecreate(statement, stripped);
    if (dropped) findings.push({ statement: excerpt, reason: dropped });
  }

  return {
    destructive: findings.length > 0,
    findings,
    statementCount: statements.length,
  };
}
