import { describe, expect, it } from "vitest";
import {
  MAX_LABEL_LENGTH,
  allocateSubdomain,
  isValidLabel,
  normaliseLabel,
} from "./subdomainAllocation.pure";

const RESERVED = ["www", "api", "admin", "auth", "mission-control"];

describe("normaliseLabel", () => {
  it("coerces a repo-legal slug into a DNS-legal label", () => {
    // GitHub accepts these; DNS does not, and the rejection would otherwise
    // arrive from Cloudflare at the far end of a queue.
    expect(normaliseLabel("My_Clone.v2")).toBe("my-clone-v2");
    expect(normaliseLabel("Ray White — Broadbeach")).toBe("ray-white-broadbeach");
  });

  it("folds accents to their base letters rather than dropping them", () => {
    // Dropping the combining mark without folding gives "caf", which is a
    // different word and a name the operator will not recognise.
    expect(normaliseLabel("Café Ltd.")).toBe("cafe-ltd");
  });

  it("never leaves a leading or trailing hyphen", () => {
    expect(normaliseLabel("--edge--")).toBe("edge");
    expect(normaliseLabel("...x...")).toBe("x");
  });

  it("truncates to the label limit without leaving a trailing hyphen", () => {
    // A cut lands mid-word as often as not, and `foo-` is not a legal label.
    const long = `${"a".repeat(62)}-bbbb`;
    const out = normaliseLabel(long);
    expect(out.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(out.endsWith("-")).toBe(false);
    expect(isValidLabel(out)).toBe(true);
  });

  it("returns empty for input with nothing label-able in it", () => {
    expect(normaliseLabel("!!!")).toBe("");
    expect(normaliseLabel(null)).toBe("");
  });
});

describe("allocateSubdomain", () => {
  it("uses the slug when it is free", () => {
    const r = allocateSubdomain({ slug: "harcourts-pilot", taken: [], reserved: RESERVED });
    expect(r).toEqual({
      ok: true,
      subdomain: "harcourts-pilot",
      base: "harcourts-pilot",
      suffixed: false,
    });
  });

  it("refuses a reserved name and suffixes past it", () => {
    // `admin.aurixasystems.com.au` is a name the platform expects to own. Before
    // this module a clone slugged `admin` would simply have taken it.
    const r = allocateSubdomain({ slug: "admin", taken: [], reserved: RESERVED });
    expect(r.ok && r.subdomain).toBe("admin-2");
    expect(r.ok && r.suffixed).toBe(true);
  });

  it("suffixes past a name another clone already holds", () => {
    // `clones_subdomain_uidx` is a unique index: without this the second UPDATE
    // fails, the error is discarded, and the clone silently keeps a null
    // subdomain while its deployment tries to attach the first one's domain.
    const r = allocateSubdomain({ slug: "npc", taken: ["npc"], reserved: RESERVED });
    expect(r.ok && r.subdomain).toBe("npc-2");
  });

  it("keeps counting past consecutive collisions", () => {
    const r = allocateSubdomain({
      slug: "npc",
      taken: ["npc", "npc-2", "npc-3"],
      reserved: RESERVED,
    });
    expect(r.ok && r.subdomain).toBe("npc-4");
  });

  it("compares case-insensitively, because the column is citext", () => {
    // Letting `Foo` past a case-sensitive check hands the database a value it
    // then rejects for colliding with `foo` — a check that passes and a write
    // that fails is worse than no check.
    const r = allocateSubdomain({ slug: "Foo", taken: ["FOO"], reserved: [] });
    expect(r.ok && r.subdomain).toBe("foo-2");
  });

  it("truncates the BASE to fit the suffix, never the suffix", () => {
    // Shortening the disambiguator re-collides, which is the one outcome the
    // suffix exists to prevent.
    const base = "a".repeat(63);
    const r = allocateSubdomain({ slug: base, taken: [base], reserved: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subdomain.endsWith("-2")).toBe(true);
      expect(r.subdomain.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
      expect(isValidLabel(r.subdomain)).toBe(true);
    }
  });

  it("prefers an operator's typed name over the slug", () => {
    const r = allocateSubdomain({
      slug: "rw-broadbeach",
      preferred: "raywhite",
      taken: [],
      reserved: RESERVED,
    });
    expect(r.ok && r.subdomain).toBe("raywhite");
  });

  it("falls back to the slug when the preferred name is blank", () => {
    const r = allocateSubdomain({ slug: "rw", preferred: "   ", taken: [], reserved: [] });
    expect(r.ok && r.subdomain).toBe("rw");
  });

  it("reports rather than inventing a name it cannot derive", () => {
    // A generated name nobody chose is a name nobody can find again.
    const r = allocateSubdomain({ slug: "!!!", taken: [], reserved: [] });
    expect(r).toEqual({ ok: false, reason: "empty_after_normalisation" });
  });

  it("gives up rather than looping forever", () => {
    const taken = ["x", ...Array.from({ length: 60 }, (_, i) => `x-${i + 2}`)];
    const r = allocateSubdomain({ slug: "x", taken, reserved: [], maxAttempts: 5 });
    expect(r).toEqual({ ok: false, reason: "exhausted" });
  });

  it("always returns a label DNS will accept", () => {
    for (const slug of ["My_Clone.v2", "Café Ltd.", "-leading", "trailing-", "a".repeat(80)]) {
      const r = allocateSubdomain({ slug, taken: [], reserved: RESERVED });
      if (r.ok) expect(isValidLabel(r.subdomain)).toBe(true);
    }
  });
});
