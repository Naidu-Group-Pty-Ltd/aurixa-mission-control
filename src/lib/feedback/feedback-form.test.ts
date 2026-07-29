// What each workspace gets asked, and what a public form is allowed to store.
import { describe, expect, it } from "vitest";
import {
  CORE_AREAS,
  buildFeedbackForm,
  modulesForPlan,
  sanitiseRatings,
  scoreOrNull,
  textOrNull,
} from "./feedback-form";

describe("the questions follow the plan", () => {
  it("asks a Scale workspace about more than a Launch one", () => {
    const launch = buildFeedbackForm({ slug: "launch" });
    const scale = buildFeedbackForm({ slug: "scale" });
    expect(scale.questions.length).toBeGreaterThan(launch.questions.length);
  });

  it("never asks about a module the tier does not include", () => {
    // Marketing is Scale-only. Asking Launch to rate it produces a score for
    // something they have never opened.
    const launch = buildFeedbackForm({ slug: "launch" });
    expect(launch.questions.map((q) => q.key)).not.toContain("marketing");
    expect(buildFeedbackForm({ slug: "scale" }).questions.map((q) => q.key)).toContain("marketing");
  });

  it("asks Growth about Deal Pipeline and Launch about neither", () => {
    expect(modulesForPlan("growth").map((m) => m.slug)).toContain("deal-pipeline");
    expect(modulesForPlan("launch").map((m) => m.slug)).not.toContain("deal-pipeline");
  });

  it("never asks about something that is not built yet", () => {
    for (const slug of ["launch", "growth", "scale"]) {
      expect(modulesForPlan(slug).every((m) => !m.comingSoon)).toBe(true);
    }
  });

  it("asks an unknown plan the core questions and nothing module-specific", () => {
    // Enterprise, billing-exempt, or a failed plan lookup. Guessing the other
    // way would score modules the workspace may not have.
    for (const slug of [null, undefined, "enterprise", "legacy-pro"]) {
      const form = buildFeedbackForm({ slug });
      expect(form.questions).toHaveLength(CORE_AREAS.length);
      expect(form.questions.map((q) => q.key)).toEqual(CORE_AREAS.map((q) => q.key));
    }
  });

  it("always asks the everyday questions first", () => {
    const form = buildFeedbackForm({ slug: "scale" });
    expect(form.groups[0]).toBe("The everyday");
    expect(form.questions.slice(0, CORE_AREAS.length).map((q) => q.key)).toEqual(
      CORE_AREAS.map((q) => q.key),
    );
  });

  it("gives every question a key, a label and a reason to exist", () => {
    for (const q of buildFeedbackForm({ slug: "scale" }).questions) {
      expect(q.key.length).toBeGreaterThan(0);
      expect(q.label.length).toBeGreaterThan(0);
      expect(q.hint.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate keys, so one answer cannot overwrite another", () => {
    const keys = buildFeedbackForm({ slug: "scale" }).questions.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is stable — the same plan asks the same questions in the same order", () => {
    // A rating is only comparable across quarters if the question has not moved.
    expect(buildFeedbackForm({ slug: "growth" })).toEqual(buildFeedbackForm({ slug: "growth" }));
  });
});

describe("what a browser is allowed to store", () => {
  const form = buildFeedbackForm({ slug: "launch" });

  it("keeps ratings for questions that were actually asked", () => {
    expect(sanitiseRatings({ "core.reports": 5, "core.speed": 3 }, form)).toEqual({
      "core.reports": 5,
      "core.speed": 3,
    });
  });

  it("drops a rating for a module this workspace was never asked about", () => {
    // The form is served to a browser and a browser can post anything. A score
    // against a module they do not have is worse than a lost score.
    expect(sanitiseRatings({ marketing: 5, "core.reports": 4 }, form)).toEqual({
      "core.reports": 4,
    });
  });

  it("drops anything outside 1–5, including clever values", () => {
    expect(
      sanitiseRatings(
        { "core.reports": 0, "core.clients": 6, "core.speed": 2.5, "core.support": "5" },
        form,
      ),
    ).toEqual({ "core.support": 5 });
  });

  it("survives rubbish instead of throwing", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(sanitiseRatings(junk, form)).toEqual({});
    }
  });
});

describe("scores and text", () => {
  it("keeps a recommend score in 0–10 and rejects the rest", () => {
    expect(scoreOrNull(0, 0, 10)).toBe(0);
    expect(scoreOrNull(10, 0, 10)).toBe(10);
    expect(scoreOrNull(11, 0, 10)).toBeNull();
    expect(scoreOrNull(-1, 0, 10)).toBeNull();
    expect(scoreOrNull("7", 0, 10)).toBe(7);
    expect(scoreOrNull("seven", 0, 10)).toBeNull();
  });

  it("treats zero as a real score, not a missing one", () => {
    // A detractor answering 0 is the single most valuable response on the
    // form. Falsy-checking it away would delete exactly that.
    expect(scoreOrNull(0, 0, 10)).toBe(0);
  });

  it("trims text, drops empty, and bounds the long", () => {
    expect(textOrNull("  hello  ")).toBe("hello");
    expect(textOrNull("   ")).toBeNull();
    expect(textOrNull(123)).toBeNull();
    expect(textOrNull("x".repeat(5000))!.length).toBe(4000);
  });
});
