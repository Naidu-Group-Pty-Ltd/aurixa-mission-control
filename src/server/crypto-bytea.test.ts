import { describe, expect, it } from "vitest";
import { decodeBytea, encodeBytea, decryptSecret, encryptSecret } from "./crypto.server";

describe("bytea encoding for stored secrets", () => {
  it("round-trips an ASCII ciphertext", () => {
    const v = "enc:v1:AAAAAAAAAAAAAAAAAAAA";
    expect(decodeBytea(encodeBytea(v))).toBe(v);
  });

  it("produces the literal Postgres accepts for a bytea column", () => {
    // `\x` followed by lowercase hex is the form `bytea_output = hex` both
    // writes and reads, which is the whole point of having one helper.
    expect(encodeBytea("abc")).toBe("\\x616263");
  });

  it("decodes what PostgREST returns for a bytea column", () => {
    expect(decodeBytea("\\x656e633a76313a")).toBe("enc:v1:");
  });

  it("passes plain text through untouched", () => {
    // A legacy row that holds an un-encoded string must still resolve rather
    // than being mangled into nonsense.
    expect(decodeBytea("enc:v1:plain")).toBe("enc:v1:plain");
  });

  it("treats an absent value as empty rather than the string 'null'", () => {
    // `String(null)` is "null", which decryptSecret would have happily returned
    // as though it were a credential.
    expect(decodeBytea(null)).toBe("");
    expect(decodeBytea(undefined)).toBe("");
  });

  it("survives the full write-then-read path with encryption off", () => {
    const pat = "sbp_0123456789abcdef";
    const stored = encodeBytea(encryptSecret(pat));
    expect(decryptSecret(decodeBytea(stored))).toBe(pat);
  });

  it("survives the full write-then-read path with encryption on", () => {
    const prev = process.env.CREDENTIALS_ENC_KEY;
    process.env.CREDENTIALS_ENC_KEY = "test-key-for-round-trip";
    try {
      const pat = "sbp_0123456789abcdef";
      const stored = encodeBytea(encryptSecret(pat));
      expect(stored.startsWith("\\x")).toBe(true);
      expect(decryptSecret(decodeBytea(stored))).toBe(pat);
    } finally {
      if (prev === undefined) delete process.env.CREDENTIALS_ENC_KEY;
      else process.env.CREDENTIALS_ENC_KEY = prev;
    }
  });
});
