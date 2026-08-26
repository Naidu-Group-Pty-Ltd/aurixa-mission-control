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
  it("maps the five booking types the Make router served", () => {
    expect(classifyBookingIntent("book a discovery call").kind).toBe("discovery");
    expect(classifyBookingIntent("strategy session please").kind).toBe("strategy_phone");
    expect(classifyBookingIntent("strategy session on zoom").kind).toBe("strategy_zoom");
    expect(classifyBookingIntent("initial finance consult").kind).toBe("ifc_phone");
    expect(classifyBookingIntent("finance chat over zoom").kind).toBe("ifc_zoom");
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

  it("offers no same-day slots and nothing outside Mon–Fri 13:00–18:00 Sydney", () => {
    expect(slots.length).toBeGreaterThan(0);
    const fmt = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      weekday: "short",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    for (const s of slots) {
      const parts = fmt.formatToParts(s);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      expect(get("day")).not.toBe("26");
      expect(["Sat", "Sun"]).not.toContain(get("weekday").slice(0, 3));
      const hour = Number(get("hour")) % 24;
      expect(hour).toBeGreaterThanOrEqual(13);
      expect(hour).toBeLessThan(18);
    }
  });

  it("starts every slot on a half hour", () => {
    for (const s of slots) expect(s.getTime() % (30 * 60_000)).toBe(0);
  });
});

describe("classifyHandoffIntent", () => {
  it("routes finance and strategy language to the specialists", () => {
    expect(classifyHandoffIntent("I want to talk about my mortgage and borrowing")).toBe("finance");
    expect(classifyHandoffIntent("we need a portfolio strategy plan")).toBe("strategy");
  });

  it("defaults to discovery when nothing scores", () => {
    expect(classifyHandoffIntent("hello there")).toBe("discovery");
  });
});
