// The contract with Make.com and, through it, with Airtable.
//
// makePayload is the only pure, testable thing on the delivery path, and it is
// also the thing a scenario in another product is mapped field-by-field
// against. A rename here does not fail a build — it silently produces empty
// Airtable columns nobody notices for a quarter. So the field names are
// asserted as the interface they are.
import { describe, expect, it } from "vitest";
import { makePayload } from "./feedback.server";

const base = {
  submissionId: "sub-1",
  campaignKey: "2026-Q3",
  tenantId: "ten-1",
  tenantRef: "prime:abc",
  workspaceName: "Prime",
  cloneId: null,
  originUserId: "user-1",
  originUsername: "Dana",
  originSource: "handoff",
  planSlug: "scale",
  planName: "Scale",
  overallRating: 5,
  recommendScore: 9,
  moduleRatings: {} as Record<string, number>,
  labels: {} as Record<string, string>,
  mostValuable: null as string | null,
  biggestFrustration: null as string | null,
  featureRequest: null as string | null,
  additionalComments: null as string | null,
  creditsGranted: 100,
  submittedAt: "2026-07-29T04:15:22.113Z",
};

describe("makePayload — the Airtable-facing field names", () => {
  it("emits every field the documented scenario maps", () => {
    const p = makePayload(base);
    // Exactly the list in docs/feedback-make-airtable.md. If this fails,
    // update the doc and the Make scenario in the same change — not just this
    // assertion, which would leave the two silently disagreeing.
    expect(Object.keys(p).sort()).toEqual(
      [
        "additional_comments",
        "attempt",
        "biggest_frustration",
        "campaign",
        "clone_id",
        "credits_granted",
        "feature_request",
        "free_text_chars",
        "has_free_text",
        "module_ratings",
        "module_ratings_average",
        "module_ratings_labelled",
        "module_ratings_summary",
        "modules_rated",
        "most_valuable",
        "overall_rating",
        "plan_name",
        "plan_slug",
        "recommend_score",
        "schema_version",
        "source",
        "submission_id",
        "submitted_at",
        "user_id",
        "user_name",
        "workspace_id",
        "workspace_name",
        "workspace_ref",
      ].sort(),
    );
  });

  it("pins the schema version so the scenario can branch on it", () => {
    expect(makePayload(base).schema_version).toBe(2);
  });
});

describe("has_free_text — the flag that decides whether we pay a model", () => {
  it("is false when only ratings were given", () => {
    // Roughly half of submissions. Calling an LLM to summarise four nulls
    // returns four nulls and costs money every time.
    expect(makePayload(base).has_free_text).toBe(false);
    expect(makePayload(base).free_text_chars).toBe(0);
  });

  it("is true when any one of the four text answers is filled", () => {
    for (const field of [
      "mostValuable",
      "biggestFrustration",
      "featureRequest",
      "additionalComments",
    ] as const) {
      expect(makePayload({ ...base, [field]: "something" }).has_free_text).toBe(true);
    }
  });

  it("treats whitespace as nothing said", () => {
    // A textarea someone tabbed through. Without this it buys an LLM call to
    // classify three spaces.
    expect(makePayload({ ...base, mostValuable: "   \n  " }).has_free_text).toBe(false);
  });
});

describe("module ratings", () => {
  const rated = {
    ...base,
    moduleRatings: { "deal-pipeline": 4, "core.reports": 5 },
    labels: { "deal-pipeline": "Deal Pipeline", "core.reports": "Generated reports" },
  };

  it("labels the ratings so the model is not handed our slugs", () => {
    // Given {"deal-pipeline": 2} a model has to guess what that product is,
    // and it guesses confidently and wrongly.
    expect(makePayload(rated).module_ratings_labelled).toEqual({
      "Deal Pipeline": 4,
      "Generated reports": 5,
    });
  });

  it("keeps the raw slug-keyed object as well, for analysis", () => {
    expect(makePayload(rated).module_ratings).toEqual({
      "deal-pipeline": 4,
      "core.reports": 5,
    });
  });

  it("falls back to the slug when a label is missing rather than dropping the score", () => {
    // A module retired from the catalog still has historical ratings. Losing
    // the score would be worse than showing a slug.
    const p = makePayload({ ...base, moduleRatings: { "gone-module": 3 }, labels: {} });
    expect(p.module_ratings_labelled).toEqual({ "gone-module": 3 });
  });

  it("averages to one decimal place", () => {
    // 4.666… in an Airtable cell is noise, not precision.
    const p = makePayload({
      ...base,
      moduleRatings: { a: 5, b: 5, c: 4 },
      labels: {},
    });
    expect(p.module_ratings_average).toBe(4.7);
    expect(p.modules_rated).toBe(3);
  });

  it("reports no average rather than zero when nothing was rated", () => {
    // Zero is a rating. "They did not rate anything" is not, and averaging it
    // into a chart as 0/5 would libel the product.
    expect(makePayload(base).module_ratings_average).toBeNull();
    expect(makePayload(base).modules_rated).toBe(0);
  });
});

describe("attempt", () => {
  it("defaults to the first try", () => {
    expect(makePayload(base).attempt).toBe(1);
  });

  it("carries the replay count so Airtable can tell a retry from a new answer", () => {
    expect(makePayload({ ...base, attempt: 3 }).attempt).toBe(3);
  });
});

describe("credits_granted", () => {
  it("passes zero through unchanged", () => {
    // Zero is the normal, correct value for the second colleague to answer —
    // the reward is once per workspace per campaign. It must not be coerced to
    // 100 or treated as missing.
    expect(makePayload({ ...base, creditsGranted: 0 }).credits_granted).toBe(0);
  });
});
