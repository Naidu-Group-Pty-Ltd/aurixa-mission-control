// Tests for the pure halves of the inbound tools: envelope shape, tool-call
// extraction across VAPI's three spellings, the deterministic booking-intent
// classifier, availability slot generation and handoff classification.
import { describe, expect, it } from "vitest";
import {
  candidateSlots,
  classifyBookingIntent,
  classifyHandoffIntent,
  extractToolCalls,
  toolEnvelope,
} from "./voice-tools.server";

describe("toolEnvelope", () => {
  it("stringifies the result — VAPI ignores structured bodies", () => {
    const env = toolEnvelope("tc_1", { success: true });
    expect(env.results).toHaveLength(1);
    expect(env.results[0].toolCallId).toBe("tc_1");
    expect(JSON.parse(env.results[0].result)).toEqual({ success: true });
  });
});

describe("extractToolCalls", () => {
  it("reads toolCallList with function.arguments as a JSON string", () => {
    const calls = extractToolCalls({
      toolCallList: [
        { id: "a", function: { name: "resolve_contact", arguments: '{"full_name":"Jo"}' } },
      ],
    });
    expect(calls).toEqual([{ id: "a", name: "resolve_contact", args: { full_name: "Jo" } }]);
  });

  it("falls back to toolCalls and toolWithToolCallList", () => {
    expect(
      extractToolCalls({
        toolCalls: [{ id: "b", function: { name: "get_call_context", arguments: {} } }],
      })[0].name,
    ).toBe("get_call_context");
    expect(
      extractToolCalls({
        toolWithToolCallList: [
          { toolCall: { id: "c", function: { name: "book_appointment", arguments: {} } } },
        ],
      })[0].name,
    ).toBe("book_appointment");
  });

  it("ignores malformed entries instead of throwing mid-call", () => {
    expect(extractToolCalls({ toolCallList: [{ function: {} }, null] })).toEqual([]);
  });
});

describe("classifyBookingIntent", () => {
  it("maps the Aurixa session vocabulary", () => {
    expect(classifyBookingIntent("book my strategic review").kind).toBe("strategic_review");
    expect(classifyBookingIntent("platform discovery session").kind).toBe("discovery_session");
    expect(classifyBookingIntent("a guided demonstration of the platform").kind).toBe(
      "guided_demo",
    );
    expect(classifyBookingIntent("enterprise requirements consultation").kind).toBe(
      "enterprise_consultation",
    );
    expect(classifyBookingIntent("our onboarding kickoff call").kind).toBe("kickoff");
  });

  it("lands plain review/application language on the strategic review", () => {
    expect(classifyBookingIntent("the review for my application").kind).toBe("strategic_review");
  });

  it("asks for clarification instead of guessing", () => {
    const r = classifyBookingIntent("just wanted to chat");
    expect(r.kind).toBeNull();
    expect(r.clarificationQuestion).toBeTruthy();
  });
});

describe("candidateSlots", () => {
  // 2026-08-26T00:00Z is Wednesday 10:00 AEST.
  const now = new Date("2026-08-26T00:00:00Z");
  const slots = candidateSlots(now);

  it("honours 24h minimum notice and the Mon–Fri 9:00–16:30 Sydney window", () => {
    expect(slots.length).toBeGreaterThan(0);
    const minStart = now.getTime() + 24 * 60 * 60_000;
    const fmt = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    for (const s of slots) {
      expect(s.getTime()).toBeGreaterThanOrEqual(minStart);
      const parts = fmt.formatToParts(s);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      expect(["Sat", "Sun"]).not.toContain(get("weekday").slice(0, 3));
      const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
      expect(minutes).toBeGreaterThanOrEqual(9 * 60);
      // A 30-minute slot must end by 4:30 p.m., so the last start is 4:00 p.m.
      expect(minutes).toBeLessThanOrEqual(16 * 60);
    }
  });

  it("covers the 45-day booking horizon", () => {
    const last = slots[slots.length - 1];
    expect(last.getTime()).toBeGreaterThan(now.getTime() + 40 * 24 * 60 * 60_000);
  });

  it("starts every slot on a half hour", () => {
    for (const s of slots) expect(s.getTime() % (30 * 60_000)).toBe(0);
  });
});

describe("classifyHandoffIntent", () => {
  it("routes support and product language to the specialists", () => {
    expect(classifyHandoffIntent("something is broken and I need support with an error")).toBe(
      "support",
    );
    expect(classifyHandoffIntent("what does the platform cost and which modules exist")).toBe(
      "solutions",
    );
    expect(classifyHandoffIntent("I want to book my review time slot")).toBe("review");
  });

  it("defaults to the solutions advisor when nothing scores", () => {
    expect(classifyHandoffIntent("hello there")).toBe("solutions");
  });
});
