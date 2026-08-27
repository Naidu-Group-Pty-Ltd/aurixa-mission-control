import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildInboundTwiml,
  buildOutboundTwiml,
  escapeXml,
  expectedTwilioSignature,
  identityForUser,
  isTerminalStatus,
  MISSED_STATUSES,
  mintVoiceToken,
  publicUrlFor,
  type TelephonyConfig,
} from "./telephony.server";

const CONFIG: TelephonyConfig = {
  ready: true,
  missing: [],
  accountSid: "AC0000000000000000000000000000test",
  apiKeySid: "SK0000000000000000000000000000test",
  apiKeySecret: "super-secret-api-key-secret",
  authToken: "auth-token-for-signatures",
  twimlAppSid: "AP0000000000000000000000000000test",
  callerId: "+61255550000",
};

function decodeSegment(segment: string): Record<string, unknown> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

describe("mintVoiceToken", () => {
  it("emits a Twilio-shaped HS256 JWT with voice grants", async () => {
    const token = await mintVoiceToken(CONFIG, "op_abc123", 1_700_000_000);
    const [h, p, s] = token.split(".");
    expect(s).toBeTruthy();

    const header = decodeSegment(h);
    expect(header).toEqual({ typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" });

    const payload = decodeSegment(p) as {
      iss: string;
      sub: string;
      iat: number;
      exp: number;
      grants: { identity: string; voice: { incoming: { allow: boolean }; outgoing: { application_sid: string } } };
    };
    expect(payload.iss).toBe(CONFIG.apiKeySid);
    expect(payload.sub).toBe(CONFIG.accountSid);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(payload.grants.identity).toBe("op_abc123");
    expect(payload.grants.voice.incoming.allow).toBe(true);
    expect(payload.grants.voice.outgoing.application_sid).toBe(CONFIG.twimlAppSid);
  });

  it("signs with HMAC-SHA256 over header.payload using the API key secret", async () => {
    const token = await mintVoiceToken(CONFIG, "op_abc123", 1_700_000_000);
    const [h, p, s] = token.split(".");
    const expected = createHmac("sha256", CONFIG.apiKeySecret)
      .update(`${h}.${p}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(s).toBe(expected);
  });
});

describe("expectedTwilioSignature", () => {
  it("matches Twilio's documented HMAC-SHA1 over url + sorted params", async () => {
    const url = "https://mission-control.aurixasystems.com.au/api/public/telephony/status";
    const params = { CallSid: "CA123", To: "+61400000000", From: "client:op_x" };
    const data = url + ["CallSid", "From", "To"].map((k) => k + params[k as keyof typeof params]).join("");
    const reference = createHmac("sha1", CONFIG.authToken).update(data).digest("base64");
    await expect(expectedTwilioSignature(CONFIG.authToken, url, params)).resolves.toBe(reference);
  });

  it("changes when any param changes", async () => {
    const url = "https://example.com/hook";
    const a = await expectedTwilioSignature("tok", url, { A: "1" });
    const b = await expectedTwilioSignature("tok", url, { A: "2" });
    expect(a).not.toBe(b);
  });
});

describe("TwiML builders", () => {
  it("bridges an outgoing call with the purchased caller id and status callbacks", () => {
    const xml = buildOutboundTwiml(CONFIG, "+61400123123");
    expect(xml).toContain(`callerId="+61255550000"`);
    expect(xml).toContain(">+61400123123</Number>");
    expect(xml).toContain(publicUrlFor("/api/public/telephony/status"));
    expect(xml).toContain(`statusCallbackEvent="initiated ringing answered completed"`);
  });

  it("rings every fresh registered client, capped, with a dial action", () => {
    const xml = buildInboundTwiml(["op_a", "op_b"]);
    expect(xml).toContain("<Client>op_a</Client>");
    expect(xml).toContain("<Client>op_b</Client>");
    expect(xml).toContain(`action="${escapeXml(publicUrlFor("/api/public/telephony/status?leg=inbound-result"))}"`);
    expect(xml).toContain(`timeout="25"`);
  });

  it("says nobody is available when no client is registered — never dead air", () => {
    const xml = buildInboundTwiml([]);
    expect(xml).toContain("<Say");
    expect(xml).toContain("Nobody is available");
    expect(xml).not.toContain("<Dial");
  });

  it("escapes XML metacharacters in interpolated values", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("status vocabulary", () => {
  it("treats Twilio's terminal states as terminal and nothing else", () => {
    for (const s of ["completed", "busy", "failed", "no-answer", "canceled"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    for (const s of ["queued", "initiated", "ringing", "in-progress", "future-status"]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it("counts every unanswered terminal state as missed, but not completed", () => {
    expect(MISSED_STATUSES.has("no-answer")).toBe(true);
    expect(MISSED_STATUSES.has("busy")).toBe(true);
    expect(MISSED_STATUSES.has("completed")).toBe(false);
  });
});

describe("identityForUser", () => {
  it("derives a stable, Twilio-safe client identity from the user id", () => {
    expect(identityForUser("6f1f8f7a-1234-4abc-9def-000011112222")).toBe(
      "op_6f1f8f7a12344abc9def000011112222",
    );
    // deterministic — the same user always rings the same client name
    expect(identityForUser("abc")).toBe(identityForUser("abc"));
  });
});
