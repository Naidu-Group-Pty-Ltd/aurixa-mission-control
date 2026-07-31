import { describe, expect, it } from "vitest";
import {
  agreementFrom,
  bandFor,
  computeConfidence,
  corpusSlugs,
  FALLBACK_BANDS,
  median,
  parseAiJson,
  pickRepresentative,
  reconcileSamples,
  scoreAnalysis,
  selectKnowledge,
  validateAgainstCorpus,
  type RubricRow,
} from "./fit-analysis.server";

const rubric: RubricRow[] = [
  { dimension: "problem_solution", label: "Problem–solution fit", weight: 30, sort_order: 1 },
  { dimension: "segment", label: "Segment fit", weight: 15, sort_order: 2 },
  { dimension: "scale", label: "Scale fit", weight: 15, sort_order: 3 },
  { dimension: "technical", label: "Technical fit", weight: 15, sort_order: 4 },
  { dimension: "commercial", label: "Commercial fit", weight: 15, sort_order: 5 },
  {
    dimension: "risk",
    label: "Risk & red flags",
    weight: 10,
    sort_order: 6,
    is_veto: true,
    veto_below: 25,
  },
];

const cited = (quote: string) => [{ source: "website", quote }];

/** Every dimension answered, evidenced, at the given score. */
const evenSample = (score: number) =>
  rubric.map((r) => ({
    dimension: r.dimension,
    raw_score: score,
    rationale: `${r.dimension} rationale`,
    verified: true,
    evidence: cited(`evidence for ${r.dimension}`),
  }));

describe("scoreAnalysis — unanswered dimensions", () => {
  it("scores over the weight actually assessed, not the whole rubric", () => {
    // Only problem_solution answered, at 80. The old scorer counted the other
    // 70 weight as zeros and returned 24; the prospect was punished for the
    // model's omission.
    const result = scoreAnalysis(rubric, [
      {
        dimension: "problem_solution",
        raw_score: 80,
        verified: true,
        evidence: cited("they run three disconnected systems"),
      },
    ]);
    expect(result.score).toBe(80);
    expect(result.coverage).toBe(30);
    expect(result.integrity.dimensions_skipped).toEqual([
      "segment",
      "scale",
      "technical",
      "commercial",
      "risk",
    ]);
  });

  it("marks unanswered dimensions rather than silently zeroing them", () => {
    const result = scoreAnalysis(rubric, [
      { dimension: "segment", raw_score: 60, evidence: cited("buyer's agency") },
    ]);
    const skipped = result.rows.find((r) => r.dimension === "scale");
    expect(skipped).toMatchObject({ answered: false, raw_score: 0, weighted_score: 0 });
    expect(skipped?.rationale).toMatch(/no assessment/i);
  });

  it("reports full coverage when every dimension comes back", () => {
    const result = scoreAnalysis(rubric, evenSample(70));
    expect(result.coverage).toBe(100);
    expect(result.score).toBe(70);
    expect(result.integrity.dimensions_skipped).toEqual([]);
  });

  it("weights dimensions against each other correctly", () => {
    const dims = evenSample(0).map((d) =>
      d.dimension === "problem_solution" ? { ...d, raw_score: 100 } : d,
    );
    // 100 on the 30-weight dimension, 0 on the other 70 → 30.
    expect(scoreAnalysis(rubric, dims).score).toBe(30);
  });
});

describe("scoreAnalysis — the evidence gate", () => {
  it("caps a score the model could not cite anything for", () => {
    const dims = evenSample(95).map((d) =>
      d.dimension === "technical" ? { ...d, evidence: [] } : d,
    );
    const result = scoreAnalysis(rubric, dims);
    const technical = result.rows.find((r) => r.dimension === "technical");
    expect(technical).toMatchObject({ raw_score: 55, capped: true, verified: false });
    expect(result.integrity.dimensions_capped).toEqual(["technical"]);
  });

  it("leaves an unevidenced score alone when it is already below the ceiling", () => {
    const dims = evenSample(30).map((d) =>
      d.dimension === "technical" ? { ...d, evidence: [] } : d,
    );
    const technical = scoreAnalysis(rubric, dims).rows.find((r) => r.dimension === "technical");
    expect(technical).toMatchObject({ raw_score: 30, capped: false });
  });

  it("honours a per-dimension ceiling and an opt-out", () => {
    const custom: RubricRow[] = [
      { dimension: "a", label: "A", weight: 50, unevidenced_ceiling: 20 },
      { dimension: "b", label: "B", weight: 50, evidence_required: false },
    ];
    const result = scoreAnalysis(custom, [
      { dimension: "a", raw_score: 90, evidence: [] },
      { dimension: "b", raw_score: 90, evidence: [] },
    ]);
    expect(result.rows.find((r) => r.dimension === "a")?.raw_score).toBe(20);
    expect(result.rows.find((r) => r.dimension === "b")?.raw_score).toBe(90);
  });

  it("refuses to call a dimension verified when nothing was cited", () => {
    const dims = evenSample(40).map((d) =>
      d.dimension === "segment" ? { ...d, verified: true, evidence: [] } : d,
    );
    expect(scoreAnalysis(rubric, dims).rows.find((r) => r.dimension === "segment")?.verified).toBe(
      false,
    );
  });

  it("ignores evidence items that say nothing", () => {
    const dims = evenSample(95).map((d) =>
      d.dimension === "technical" ? { ...d, evidence: [{ source: "", quote: "", note: "" }] } : d,
    );
    expect(scoreAnalysis(rubric, dims).rows.find((r) => r.dimension === "technical")?.capped).toBe(
      true,
    );
  });
});

describe("scoreAnalysis — the veto", () => {
  it("declines on a veto dimension however good the weighted score", () => {
    const dims = evenSample(95).map((d) => (d.dimension === "risk" ? { ...d, raw_score: 10 } : d));
    const result = scoreAnalysis(rubric, dims);
    expect(result.score).toBeGreaterThan(85);
    expect(result.grade).toBe("A");
    expect(result.verdict).toBe("decline");
    expect(result.veto.triggered).toEqual(["risk"]);
  });

  it("does not fire on the threshold's safe side", () => {
    const dims = evenSample(95).map((d) => (d.dimension === "risk" ? { ...d, raw_score: 26 } : d));
    expect(scoreAnalysis(rubric, dims).verdict).toBe("strong_fit");
  });

  it("is found by its flag, not by being named 'risk'", () => {
    // Renaming the dimension used to remove the gate entirely, because the
    // scorer looked for the literal string "risk".
    const renamed: RubricRow[] = rubric.map((r) =>
      r.dimension === "risk" ? { ...r, dimension: "red_flags", label: "Red flags" } : r,
    );
    const dims = evenSample(95)
      .filter((d) => d.dimension !== "risk")
      .concat([
        {
          dimension: "red_flags",
          raw_score: 5,
          rationale: "unregistered entity",
          verified: true,
          evidence: cited("no ABN found"),
        },
      ]);
    const result = scoreAnalysis(renamed, dims);
    expect(result.verdict).toBe("decline");
    expect(result.veto.triggered).toEqual(["red_flags"]);
  });

  it("reports when no veto dimension is configured at all", () => {
    const noVeto = rubric.map(({ is_veto: _v, veto_below: _b, ...r }) => r);
    const result = scoreAnalysis(noVeto, evenSample(95));
    expect(result.veto.configured).toBe(false);
    expect(result.verdict).toBe("strong_fit");
  });

  it("cannot be vetoed by a dimension the model never assessed", () => {
    const dims = evenSample(95).filter((d) => d.dimension !== "risk");
    const result = scoreAnalysis(rubric, dims);
    expect(result.veto.triggered).toEqual([]);
    expect(result.verdict).toBe("strong_fit");
  });
});

describe("bandFor", () => {
  it("maps scores onto the seeded bands", () => {
    expect(bandFor(90).grade).toBe("A");
    expect(bandFor(85).grade).toBe("A");
    expect(bandFor(84.9).grade).toBe("B");
    expect(bandFor(0).grade).toBe("F");
  });

  it("uses whatever bands the table supplies", () => {
    const strict = [
      { grade: "A", verdict: "strong_fit", min_score: 95 },
      { grade: "F", verdict: "decline", min_score: 0 },
    ];
    expect(bandFor(90, strict).grade).toBe("F");
    expect(bandFor(96, strict).grade).toBe("A");
  });

  it("falls back rather than throwing on an empty band table", () => {
    expect(bandFor(90, []).grade).toBe("A");
    expect(FALLBACK_BANDS).toHaveLength(5);
  });
});

describe("reconcileSamples", () => {
  it("takes the median score across independent samples", () => {
    const readings = reconcileSamples([
      [{ dimension: "segment", raw_score: 40, evidence: cited("a") }],
      [{ dimension: "segment", raw_score: 90, evidence: cited("b") }],
      [{ dimension: "segment", raw_score: 70, evidence: cited("c") }],
    ]);
    expect(readings.get("segment")?.raw_score).toBe(70);
    expect(readings.get("segment")?.spread).toBe(50);
  });

  it("unions evidence and counts a repeated citation once", () => {
    const same = cited("they list four offices");
    const readings = reconcileSamples([
      [{ dimension: "scale", raw_score: 60, evidence: same }],
      [
        {
          dimension: "scale",
          raw_score: 60,
          evidence: [...same, { source: "submission", quote: "150 settlements" }],
        },
      ],
    ]);
    expect(readings.get("scale")?.evidence).toHaveLength(2);
  });

  it("requires a majority before calling a dimension verified", () => {
    const readings = reconcileSamples([
      [{ dimension: "segment", raw_score: 50, verified: true, evidence: cited("a") }],
      [{ dimension: "segment", raw_score: 50, verified: false, evidence: cited("b") }],
      [{ dimension: "segment", raw_score: 50, verified: false, evidence: cited("c") }],
    ]);
    expect(readings.get("segment")?.verified).toBe(false);
  });

  it("takes the rationale from the sample nearest the median, not a merge", () => {
    const readings = reconcileSamples([
      [{ dimension: "segment", raw_score: 20, rationale: "outlier low" }],
      [{ dimension: "segment", raw_score: 70, rationale: "the middle view" }],
      [{ dimension: "segment", raw_score: 95, rationale: "outlier high" }],
    ]);
    expect(readings.get("segment")?.rationale).toBe("the middle view");
  });

  it("ignores a dimension no sample scored numerically", () => {
    const readings = reconcileSamples([[{ dimension: "segment", raw_score: "not a number" }]]);
    expect(readings.has("segment")).toBe(false);
  });

  it("survives a sample that dropped a dimension the others answered", () => {
    const readings = reconcileSamples([
      [
        { dimension: "segment", raw_score: 60, evidence: cited("a") },
        { dimension: "scale", raw_score: 80, evidence: cited("b") },
      ],
      [{ dimension: "segment", raw_score: 70, evidence: cited("c") }],
    ]);
    expect(readings.get("segment")?.raw_score).toBe(65);
    expect(readings.get("scale")).toMatchObject({ raw_score: 80, answers: 1 });
  });
});

describe("agreementFrom", () => {
  it("calls identical samples full agreement", () => {
    expect(agreementFrom([0, 0, 0])).toBe(100);
    expect(agreementFrom([])).toBe(100);
  });

  it("falls to zero once samples disagree by 40 points or more", () => {
    expect(agreementFrom([40])).toBe(0);
    expect(agreementFrom([90])).toBe(0);
    expect(agreementFrom([20])).toBe(50);
  });
});

describe("computeConfidence", () => {
  const strong = {
    modelConfidence: 90,
    coverage: 100,
    verifiedRatio: 100,
    agreement: 100,
    siteReachable: true,
    evidenceCount: 12,
    dimensionCount: 6,
  };

  it("lets a well-evidenced analysis keep the model's number", () => {
    expect(computeConfidence(strong).confidence).toBe(90);
  });

  it("will not let the model claim more than the signals support", () => {
    // The model says 99; half the rubric went unassessed and nothing was
    // externally verified.
    const { confidence, basis } = computeConfidence({
      ...strong,
      modelConfidence: 99,
      coverage: 50,
      verifiedRatio: 0,
      evidenceCount: 2,
    });
    expect(confidence).toBeLessThan(60);
    expect(basis.signal_ceiling).toBe(confidence);
  });

  it("caps hard when the prospect's website could not be read", () => {
    expect(computeConfidence({ ...strong, siteReachable: false }).confidence).toBe(45);
  });

  it("lets the model lower its own confidence below the ceiling", () => {
    expect(computeConfidence({ ...strong, modelConfidence: 20 }).confidence).toBe(20);
  });

  it("punishes samples that disagreed with each other", () => {
    const agreeing = computeConfidence(strong).confidence;
    const disagreeing = computeConfidence({ ...strong, agreement: 0 }).confidence;
    expect(disagreeing).toBeLessThan(agreeing);
  });

  it("records the basis so a number can be argued with", () => {
    expect(computeConfidence(strong).basis).toMatchObject({
      coverage: 100,
      verified_ratio: 100,
      sample_agreement: 100,
      site_reachable: true,
    });
  });
});

describe("validateAgainstCorpus", () => {
  const slugs = corpusSlugs({
    modules: [{ slug: "client-crm" }, { slug: "report-engine" }],
    plans: [{ slug: "growth" }],
    setup_packages: [{ slug: "standard-onboarding" }],
  });

  it("strips a plan, module and package Aurixa does not sell", () => {
    const { plan, hallucinated } = validateAgainstCorpus(
      {
        recommended_plan: {
          plan_slug: "enterprise-platinum",
          setup_package_slug: "white-glove",
          addon_module_slugs: ["client-crm", "ai-copilot"],
        },
      },
      slugs,
    );
    expect(plan.plan_slug).toBeNull();
    expect(plan.setup_package_slug).toBeNull();
    expect(plan.addon_module_slugs).toEqual(["client-crm"]);
    expect(hallucinated.sort()).toEqual([
      "module:ai-copilot",
      "plan:enterprise-platinum",
      "setup_package:white-glove",
    ]);
  });

  it("keeps everything that does exist", () => {
    const { plan, hallucinated } = validateAgainstCorpus(
      {
        recommended_plan: {
          plan_slug: "growth",
          setup_package_slug: "standard-onboarding",
          addon_module_slugs: ["client-crm", "report-engine"],
        },
      },
      slugs,
    );
    expect(plan).toMatchObject({ plan_slug: "growth", setup_package_slug: "standard-onboarding" });
    expect(hallucinated).toEqual([]);
  });

  it("keeps a pain point whose module was invented, flagged as unmapped", () => {
    // The pain is real even when the mapping is not; it belongs in discovery.
    const { correlation } = validateAgainstCorpus(
      {
        correlation_map: [
          { pain_point: "duplicate data entry", module_slug: "client-crm" },
          { pain_point: "no AML workflow", module_slug: "aml-suite" },
        ],
      },
      slugs,
    );
    expect(correlation[0]).toMatchObject({ module_slug: "client-crm" });
    expect(correlation[1]).toMatchObject({ module_slug: null, unmapped: true });
  });

  it("does not report the same invention twice", () => {
    const { hallucinated } = validateAgainstCorpus(
      {
        recommended_plan: { addon_module_slugs: ["ghost", "ghost"] },
        correlation_map: [{ module_slug: "ghost" }],
      },
      slugs,
    );
    expect(hallucinated).toEqual(["module:ghost"]);
  });

  it("treats a missing recommendation as empty rather than throwing", () => {
    const { plan, correlation, hallucinated } = validateAgainstCorpus({}, slugs);
    expect(plan.addon_module_slugs).toEqual([]);
    expect(correlation).toEqual([]);
    expect(hallucinated).toEqual([]);
  });
});

describe("selectKnowledge", () => {
  const entry = (over: Partial<Parameters<typeof selectKnowledge>[0][number]>) => ({
    id: over.id ?? "k1",
    title: over.title ?? "Entry",
    kind: over.kind ?? "other",
    content: over.content ?? "some content",
    tags: over.tags ?? [],
    pinned: over.pinned ?? false,
    ...over,
  });

  it("always includes pinned entries ahead of relevance", () => {
    const { selected } = selectKnowledge(
      [
        entry({ id: "a", title: "Mortgage broking case study", content: "mortgage broking wins" }),
        entry({ id: "b", title: "Decline policy", content: "never sell to x", pinned: true }),
      ],
      "mortgage broking prospect",
    );
    expect(selected[0].id).toBe("b");
  });

  it("prefers the entry that overlaps this prospect", () => {
    const { selected } = selectKnowledge(
      [
        entry({
          id: "a",
          title: "Construction ICP",
          content: "construction builders sites scaffolding",
        }),
        entry({
          id: "b",
          title: "Conveyancing ICP",
          content: "conveyancing settlements contracts titles",
        }),
      ],
      "a conveyancing practice handling settlements and titles",
    );
    expect(selected[0].id).toBe("b");
  });

  it("skips entries that do not fit the budget and says how many", () => {
    const { selected, skipped } = selectKnowledge(
      [
        entry({ id: "a", content: "x".repeat(400), pinned: true }),
        entry({ id: "b", content: "y".repeat(400) }),
      ],
      "prospect",
      500,
    );
    expect(selected.map((s) => s.id)).toEqual(["a"]);
    expect(skipped).toBe(1);
  });

  it("ignores rows with no extracted text — a stored file is not knowledge", () => {
    const { selected } = selectKnowledge(
      [entry({ id: "a", content: "" }), entry({ id: "b", content: "   " })],
      "prospect",
    );
    expect(selected).toEqual([]);
  });

  it("breaks a relevance tie on how directly the kind bears on fit", () => {
    const { selected } = selectKnowledge(
      [
        entry({ id: "a", kind: "process", content: "shared wording" }),
        entry({ id: "b", kind: "disqualification", content: "shared wording" }),
      ],
      "unrelated prospect text",
    );
    expect(selected[0].id).toBe("b");
  });
});

describe("pickRepresentative", () => {
  it("chooses the sample closest to the reconciled medians", () => {
    const readings = reconcileSamples([
      [{ dimension: "segment", raw_score: 20 }],
      [{ dimension: "segment", raw_score: 70 }],
      [{ dimension: "segment", raw_score: 95 }],
    ]);
    const samples = [
      { headline: "low", dimensions: [{ dimension: "segment", raw_score: 20 }] },
      { headline: "middle", dimensions: [{ dimension: "segment", raw_score: 70 }] },
      { headline: "high", dimensions: [{ dimension: "segment", raw_score: 95 }] },
    ];
    expect(pickRepresentative(samples, readings).headline).toBe("middle");
  });

  it("passes a single sample straight through", () => {
    expect(pickRepresentative([{ headline: "only" }], new Map()).headline).toBe("only");
    expect(pickRepresentative([], new Map())).toEqual({});
  });

  it("does not pick a sample whose dimensions nobody recognises", () => {
    const readings = reconcileSamples([[{ dimension: "segment", raw_score: 70 }]]);
    const samples = [
      { headline: "real", dimensions: [{ dimension: "segment", raw_score: 71 }] },
      { headline: "nonsense", dimensions: [{ dimension: "made_up", raw_score: 70 }] },
    ];
    expect(pickRepresentative(samples, readings).headline).toBe("real");
  });
});

describe("parseAiJson", () => {
  it("reads clean JSON", () => {
    expect(parseAiJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("digs the object out of a fenced or chatty response", () => {
    expect(parseAiJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("throws when there is no object at all", () => {
    expect(() => parseAiJson("no json here")).toThrow("ai_response_not_json");
  });
});

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
