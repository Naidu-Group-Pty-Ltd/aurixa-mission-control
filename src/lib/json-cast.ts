import type { Json } from "@/integrations/supabase/types";

/**
 * Named cast for values written into a `jsonb` column.
 *
 * Postgres accepts any JSON-serialisable value, but TypeScript cannot prove
 * that an arbitrary `Record<string, unknown>` fits the recursive `Json` type.
 * Using this helper (rather than `as any`) keeps every such write greppable
 * and confines the assertion to the write boundary.
 */
export function asJson(value: unknown): Json {
  return value as Json;
}

/**
 * Named cast for a loosely-typed patch/insert object handed to PostgREST.
 *
 * The generic is inferred from the call site's expected row type, so the
 * assertion stays local to the single write it applies to.
 */
export function asRow<T>(value: Record<string, unknown>): T {
  return value as T;
}
