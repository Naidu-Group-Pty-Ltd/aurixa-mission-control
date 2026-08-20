/**
 * Turning a clone's slug into the name it is served at.
 *
 * `provisionClone` never wrote `clones.subdomain`, and the deployment drain fell
 * back to `clone.slug` when attaching the domain. That works right up until it
 * doesn't, and the three ways it doesn't are all silent:
 *
 *   1. **The reserved list is bypassed.** `reserved_slugs` protects `www`,
 *      `api`, `auth`, `mission-control` and twenty others. A clone slugged
 *      `admin` would have taken `admin.aurixasystems.com.au` — a name the
 *      platform expects to own — and nothing in the pipeline would have said so.
 *
 *   2. **Collisions reach the database as a constraint violation.**
 *      `clones_subdomain_uidx` is a unique partial index. Two clones whose slugs
 *      normalise to the same name make the second UPDATE fail, and every caller
 *      on this path discards the error, so the second clone quietly keeps a null
 *      subdomain and later attaches the first one's domain on Vercel — which
 *      answers 409 and strands the deployment at `attaching_domain`.
 *
 *   3. **A slug that is legal for a repo is not legal for a hostname.** GitHub
 *      accepts `My_Clone.v2`; DNS does not. Underscores and dots produce a
 *      record Cloudflare rejects, at the far end of a queue, hours later.
 *
 * So allocation is decided HERE, once, before anything is written — and it is
 * pure, because the interesting part is a rule set and not an I/O sequence.
 *
 * The caller supplies the taken set and the reserved list; this module never
 * reads the database. That is what makes the collision rule testable rather than
 * a race the schema catches.
 */

/** RFC 1123 label: lowercase alphanumeric and hyphens, no leading/trailing hyphen. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAX_LABEL_LENGTH = 63;

export type AllocationOutcome =
  | { ok: true; subdomain: string; base: string; suffixed: boolean }
  | { ok: false; reason: "empty_after_normalisation" | "exhausted" };

/**
 * Coerce arbitrary text into a DNS label.
 *
 * Deliberately lossy and deliberately not clever: strip the accents, lowercase,
 * turn every run of anything-else into a single hyphen, trim the hyphens off the
 * ends, and cut to 63 characters. A slug that survives this unchanged is one the
 * operator will recognise, which matters more than preserving every character of
 * one they won't.
 */
export function normaliseLabel(raw: string | null | undefined): string {
  const base = (raw ?? "")
    .normalize("NFKD")
    // Combining marks, so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= MAX_LABEL_LENGTH) return base;
  // Trim to the limit, then re-strip any hyphen the cut exposed — `foo-` is not
  // a legal label and a truncation is exactly how one appears.
  return base.slice(0, MAX_LABEL_LENGTH).replace(/-+$/, "");
}

export function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

/**
 * Fit `base` plus `suffix` inside the label limit.
 *
 * Truncating the base rather than the suffix is the only correct order: the
 * suffix is what makes the name unique, so shortening it re-collides. A name
 * that loses its last characters is still recognisable; one that loses its
 * disambiguator is wrong.
 */
function withSuffix(base: string, suffix: string): string {
  const room = MAX_LABEL_LENGTH - suffix.length - 1;
  const head = base.length > room ? base.slice(0, room).replace(/-+$/, "") : base;
  return `${head}-${suffix}`;
}

/**
 * Pick the subdomain for a clone.
 *
 * `taken` is every subdomain already claimed by another clone, and `reserved` is
 * the platform's own list. Both are compared case-insensitively because the
 * column is `citext` and the unique index follows it — comparing case-sensitively
 * here would let `Foo` past a check that the database then rejects for colliding
 * with `foo`, which is the worst of both.
 */
export function allocateSubdomain(input: {
  slug: string | null | undefined;
  /** Preferred name, if an operator typed one. Falls back to the slug. */
  preferred?: string | null;
  taken: Iterable<string>;
  reserved?: Iterable<string>;
  /** How many numeric suffixes to try before giving up. */
  maxAttempts?: number;
}): AllocationOutcome {
  const takenSet = new Set(
    Array.from(input.taken, (t) => (t ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const reservedSet = new Set(
    Array.from(input.reserved ?? [], (r) => (r ?? "").trim().toLowerCase()).filter(Boolean),
  );

  const base = normaliseLabel(input.preferred?.trim() || input.slug);
  if (!base || !isValidLabel(base)) {
    // A slug of only punctuation normalises to nothing. Returning a reason
    // rather than inventing a name matters: a generated name nobody chose is one
    // nobody can find again, and the operator can supply one in a second.
    return { ok: false, reason: "empty_after_normalisation" };
  }

  const unavailable = (candidate: string) => takenSet.has(candidate) || reservedSet.has(candidate);

  if (!unavailable(base)) {
    return { ok: true, subdomain: base, base, suffixed: false };
  }

  const limit = Math.max(1, input.maxAttempts ?? 50);
  for (let n = 2; n <= limit + 1; n++) {
    const candidate = withSuffix(base, String(n));
    if (isValidLabel(candidate) && !unavailable(candidate)) {
      return { ok: true, subdomain: candidate, base, suffixed: true };
    }
  }

  return { ok: false, reason: "exhausted" };
}
