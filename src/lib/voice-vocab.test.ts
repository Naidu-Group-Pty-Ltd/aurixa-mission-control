import { describe, expect, it } from "vitest";
import {
  callQualityScore,
  formatDuration,
  getOutcomeCategory,
  outcomeLabel,
  outcomeTone,
} from "./voice-vocab";

describe("getOutcomeCategory", () => {
  it("maps VAPI endedReasons to categories", () => {
    expect(getOutcomeCategory("customer-ended-call")).toBe("success");
    expect(getOutcomeCategory("assistant-ended-call")).toBe("success");
    expect(getOutcomeCategory("assistant-forwarded-call")).toBe("success");
    expect(getOutcomeCategory("voicemail")).toBe("voicemail");
    expect(getOutcomeCategory("customer-did-not-answer")).toBe("no-answer");
    expect(getOutcomeCategory("customer-busy")).toBe("busy");
    expect(getOutcomeCategory("silence-timed-out")).toBe("timeout");
    expect(getOutcomeCategory("exceeded-max-duration")).toBe("timeout");
    expect(getOutcomeCategory("manually-canceled")).toBe("cancelled");
    expect(getOutcomeCategory("blacklisted")).toBe("error");
    expect(getOutcomeCategory("killed")).toBe("error");
    expect(getOutcomeCategory(null)).toBe("other");
  });

  it("never throws on a reason it has not seen", () => {
    expect(getOutcomeCategory("pipeline-error-eleven-labs-timed-out")).toBe("error");
    expect(getOutcomeCategory("some-brand-new-reason")).toBe("other");
  });
});

describe("outcomeLabel / outcomeTone", () => {
  it("uses the display map for known reasons", () => {
    expect(outcomeLabel("customer-ended-call")).toBe("Customer ended");
    expect(outcomeTone("customer-ended-call")).toBe("success");
    expect(outcomeTone("blacklisted")).toBe("destructive");
  });

  it("title-cases unknown reasons instead of leaking raw slugs", () => {
    expect(outcomeLabel("twilio-connection-dropped")).toBe("Twilio Connection Dropped");
  });
});

describe("callQualityScore", () => {
  it("scores a model call at the top of the rubric", () => {
    const s = callQualityScore({
      sentiment: "positive",
      durationSeconds: 5 * 60,
      outcome: "customer-ended-call",
      cost: 0.04,
      hasTranscript: true,
    });
    expect(s.total).toBe(100);
  });

  it("scores a failed silent call near the bottom", () => {
    const s = callQualityScore({
      sentiment: "negative",
      durationSeconds: 20,
      outcome: "failed",
      cost: 0.8,
      hasTranscript: false,
    });
    expect(s.total).toBe(5 + 5 + 5 + 2 + 0);
  });

  it("treats voicemail as the middle of the outcome band", () => {
    expect(
      callQualityScore({
        sentiment: "neutral",
        durationSeconds: 90,
        outcome: "voicemail",
        cost: 0.1,
        hasTranscript: true,
      }).outcome,
    ).toBe(15);
  });
});

describe("formatDuration", () => {
  it("renders mm:ss and an em dash for the unknown", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatDuration(null)).toBe("—");
  });
});
