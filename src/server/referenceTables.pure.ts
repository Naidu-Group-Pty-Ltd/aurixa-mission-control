/**
 * Which prime tables are REFERENCE DATA, and may therefore be copied into a
 * tenant's database.
 *
 * ## The rule this file exists to hold
 *
 * `provisionCloneBackend` carries an explicit promise: *"Structure only — no
 * data ever leaves the prime."* That promise is why a clone has 641 tables and
 * nothing in them, and it is the right default. It is also why a clone cannot
 * render a report: the 500-master template catalogue is data, and the product
 * cannot draw a document without it.
 *
 * This module narrows that promise rather than repealing it. Exactly the tables
 * named below may travel, for the reason recorded beside each one. Everything
 * else is tenant data by default — and default is the important word. The prime
 * holds 5,350 real client emails, 1,857 generated reports, 9,089 listing
 * photographs and 11,335 CRM conversation messages, in tables that sit
 * alphabetically beside the ones here. A deny-list would have to name all of
 * them and would be wrong the moment somebody adds a table.
 *
 * ## Three rules, and each one is a refusal
 *
 * **1. Allow-list, never deny-list.** `isReferenceTable` answers false for
 * anything not named here, including tables that did not exist when this was
 * written. A new prime table is not copied until a person adds it and says why.
 *
 * **2. An identity column must be classified, and the LIVE schema decides
 * which columns those are.** The allow-list is configuration and configuration
 * goes stale; the prime's `information_schema` is the effect. So the copy reads
 * the real column list at run time, applies {@link IDENTITY_COLUMN_PATTERN},
 * and REFUSES the table if it finds a match this file has not classified. If
 * somebody adds `owner_user_id` to `template_library_entries` tomorrow, the
 * sync stops instead of copying a prime user's id into a tenant's database.
 *
 * **3. A row filter is part of the allow-list, not an afterthought.** A table
 * can be reference data in most rows and tenant data in the rest —
 * `report_templates` is 111 rows of which 5 carry an `owner_user_id` — so an
 * entry may carry a `where`, and the whole table is never assumed safe because
 * its name sounds generic.
 *
 * ## What is deliberately NOT here
 *
 * `report_templates` and `report_template_versions` are the prime tenant's own
 * working templates and their version history: 258 MB between them, and 5 rows
 * with a populated `owner_user_id`. They are not the seeded catalogue — that is
 * `template_library_entries`, whose `source_template_id` and `agency_id` are
 * both entirely unpopulated, which is what lets the catalogue travel alone.
 *
 * `stamp_duty_rates_cache` is a cache, with `fetched_at` and `expires_at` and
 * its own refresh path. A copied cache arrives carrying somebody else's fetch
 * time, and a stale rate that looks fresh is worse than an empty table the
 * sweep fills — the asymmetry `docs/reports/STAMP_DUTY.md` already records.
 */

export type IdentityPolicy =
  /** Written as NULL on the clone. The row travels; the reference does not. */
  | "null_on_copy"
  /** Kept verbatim — the name matched the pattern but the column is not a reference to anyone. */
  | "keep";

export type ColumnClassification = {
  policy: IdentityPolicy;
  /** Why. Read by a person reviewing a change to this file, and by nobody else. */
  reason: string;
};

export type ReferenceTable = {
  /** Table name in `public`. */
  table: string;
  /**
   * Unique, orderable column used to page and to resume. Paging on anything
   * non-unique silently skips or repeats rows at a page boundary.
   */
  pageKey: string;
  /** Conflict target making the copy idempotent — re-running must be a no-op. */
  conflictKey: string[];
  /**
   * Rows per page. Sized from the measured average row width so one page's
   * JSON stays about a megabyte; the copier halves it on an oversized
   * statement, so this is a starting point rather than a promise.
   */
  rowsPerPage: number;
  /** Every column whose NAME matches the identity pattern, explicitly judged. */
  columns: Record<string, ColumnClassification>;
  /** Optional SQL predicate selecting only the reference rows. */
  where?: string;
  /** Why this table is reference data. */
  reason: string;
};

/**
 * Names that must be classified before a table can be copied.
 *
 * Deliberately broad and deliberately name-based. It is a prompt to look, not
 * a decision: `document_requirement_templates.default_owner` matches and holds
 * `client` / `legal` / `finance_partner`, which is a role and not a person. A
 * narrow pattern would have let that column through unexamined and would also
 * have missed the next one that matters. Over-matching costs a line in this
 * file; under-matching costs a tenant.
 */
export const IDENTITY_COLUMN_PATTERN =
  /(^|_)(user|users|owner|creator|author|client|customer|tenant|org|organisation|organization|account|member|profile|agency|partner|broker|assignee|email)(_|$)|^(created_by|updated_by|deleted_by|locked_by|assigned_to)$/i;

export function isIdentityCandidate(column: string): boolean {
  return IDENTITY_COLUMN_PATTERN.test(column);
}

/**
 * The allow-list, in dependency order.
 *
 * Order is load-bearing: `checklist_template_sections.template_id` references
 * `checklist_templates`, and items reference sections. The copier walks this
 * array as written and does not sort it.
 */
export const REFERENCE_TABLES: readonly ReferenceTable[] = [
  {
    table: "suburb_directory",
    pageKey: "id",
    conflictKey: ["id"],
    // 18,519 rows / 1.3 MB ≈ 71 B per row.
    rowsPerPage: 2000,
    columns: {},
    reason:
      "Australian suburb/state/postcode reference. Geography, not anybody's data — " +
      "id, suburb, state, postcode, created_at and nothing else.",
  },
  {
    table: "depreciation_comps",
    pageKey: "id",
    conflictKey: ["id"],
    // 22,000 rows / 5.0 MB ≈ 237 B per row.
    rowsPerPage: 1000,
    columns: {
      created_by: {
        policy: "null_on_copy",
        reason:
          "uuid referencing public.custom_users. Unpopulated on the prime today (0 of 22,000), " +
          "which is exactly why it must be nulled rather than trusted — the day one row gets a " +
          "value is the day a prime user id lands in a tenant's table.",
      },
    },
    reason: "Depreciation comparables — a published reference set the calculators read.",
  },
  {
    table: "template_library_entries",
    pageKey: "id",
    conflictKey: ["id"],
    // 543 rows / 12 MB ≈ 22 KB per row.
    rowsPerPage: 20,
    columns: {
      created_by_user_id: {
        policy: "null_on_copy",
        reason: "uuid identifying a prime user. Unpopulated today; nulled regardless.",
      },
      agency_id: {
        policy: "null_on_copy",
        reason: "uuid scoping an entry to one agency. A clone's catalogue is scoped to nobody.",
      },
      source_template_id: {
        policy: "null_on_copy",
        reason:
          "FK to report_templates, which is deliberately NOT copied. A value here would " +
          "dangle against a table the clone has no rows in, so the reference is dropped " +
          "rather than the row.",
      },
    },
    reason:
      "The seeded PDF catalogue: 500 Investment Compass family masters plus 43 voice " +
      "templates. This is the data a clone cannot render a report without.",
  },
  {
    table: "document_requirement_templates",
    pageKey: "id",
    conflictKey: ["id"],
    rowsPerPage: 500,
    columns: {
      default_owner: {
        policy: "keep",
        reason:
          "An enum of ROLES — client / legal / finance_partner — not a reference to a person. " +
          "Nulling it would strip the requirement of the only thing that says who owes it.",
      },
    },
    reason: "Per-role document requirements driving the purchase-file checklists.",
  },
  {
    table: "checklist_templates",
    pageKey: "id",
    conflictKey: ["id"],
    rowsPerPage: 500,
    columns: {
      created_by: {
        policy: "null_on_copy",
        reason: "text naming whoever authored the template on the prime. Unpopulated today.",
      },
    },
    reason: "Checklist definitions. Parent of sections, which parent items — copied first.",
  },
  {
    table: "checklist_template_sections",
    pageKey: "id",
    conflictKey: ["id"],
    rowsPerPage: 500,
    columns: {},
    reason: "Sections of the above. `template_id` references checklist_templates, copied before.",
  },
  {
    table: "checklist_template_items",
    pageKey: "id",
    conflictKey: ["id"],
    rowsPerPage: 500,
    columns: {},
    reason: "Items of the above. `section_id` references sections, copied before.",
  },
  {
    table: "report_structure_templates",
    pageKey: "id",
    conflictKey: ["id"],
    // 14 rows / 640 KB ≈ 45 KB per row.
    rowsPerPage: 10,
    columns: {
      created_by: {
        policy: "null_on_copy",
        reason: "uuid referencing public.custom_users. Unpopulated today; nulled regardless.",
      },
    },
    reason: "Report section structures the generators read when composing a document.",
  },
];

const BY_NAME = new Map(REFERENCE_TABLES.map((t) => [t.table, t]));

export function isReferenceTable(table: string): boolean {
  return BY_NAME.has(table);
}

export function referenceTable(table: string): ReferenceTable | null {
  return BY_NAME.get(table) ?? null;
}

export type ColumnPlan =
  | {
      ok: true;
      /** Columns read from the prime and written to the clone verbatim. */
      copy: string[];
      /** Columns written as NULL. Named so the result can say what was dropped. */
      nulled: string[];
    }
  | { ok: false; refusal: string };

/**
 * Decide what to do with a table's LIVE columns.
 *
 * `actualColumns` comes from the prime's `information_schema` at run time, not
 * from this file. That direction is the whole guard: a table's classification
 * here is a claim about a schema, and the schema is free to change without
 * anybody remembering this module exists.
 *
 * Two refusals, both loud:
 *
 * - A live column matches {@link IDENTITY_COLUMN_PATTERN} and is not classified
 *   → refuse the table. This is the case that protects a tenant.
 * - A classified column is no longer in the schema → refuse too. It means the
 *   table was reshaped, and a classification that no longer binds to anything
 *   is evidence the rest of the entry is stale as well. Silently ignoring it
 *   would let a rename turn `owner_user_id` into an unclassified column while
 *   the obsolete entry still made the table look reviewed.
 */
export function planColumns(entry: ReferenceTable, actualColumns: readonly string[]): ColumnPlan {
  const live = new Set(actualColumns);

  const stale = Object.keys(entry.columns).filter((c) => !live.has(c));
  if (stale.length > 0) {
    return {
      ok: false,
      refusal:
        `${entry.table}: the allow-list classifies ${stale.map((c) => `\`${c}\``).join(", ")}, ` +
        "which the prime's schema no longer has. Refusing to copy: a classification that binds " +
        "to nothing means this entry was written against a different table, and the columns it " +
        "does still name cannot be trusted either. Re-review the entry in referenceTables.pure.ts.",
    };
  }

  const unclassified = actualColumns.filter((c) => isIdentityCandidate(c) && !(c in entry.columns));
  if (unclassified.length > 0) {
    return {
      ok: false,
      refusal:
        `${entry.table}: ${unclassified.map((c) => `\`${c}\``).join(", ")} look like a reference ` +
        "to a person or an organisation and are not classified in referenceTables.pure.ts. " +
        "Refusing to copy — every row of this table would carry them into a tenant's database. " +
        "Add each column with policy `null_on_copy`, or `keep` with the reason it is not an " +
        "identity (an enum of roles, for instance).",
    };
  }

  const nulled: string[] = [];
  const copy: string[] = [];
  for (const c of actualColumns) {
    if (entry.columns[c]?.policy === "null_on_copy") nulled.push(c);
    else copy.push(c);
  }
  return { ok: true, copy, nulled };
}
