/**
 * Run `worker` over `items` with a bounded number of in-flight promises,
 * preserving input order in the result.
 *
 * Pure and dependency-free so both a `.server.ts` module and a client-reachable
 * `.functions.ts` one can import it without dragging server-only code into a
 * browser bundle. It existed as two byte-identical private copies before this,
 * in `codex-scheduling.server.ts` and `github-secrets.functions.ts`, which is
 * two places for a concurrency bug to be fixed in one of.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
