// Byte-compatibility proof for our pure-JS crypto_box_seal.
//
// libsodium-wrappers is a devDependency kept *only* for this file: it runs in
// Node (which permits Wasm) and is the reference implementation GitHub's API
// is specified against. If our sealed box ever stops being openable by
// libsodium, the secrets we push would be silently unusable inside Actions —
// GitHub accepts any base64 blob and only the workflow would notice. This
// test is the thing standing between that and a green CI run.
//
// It must never be imported by application code; see the ESLint
// `no-restricted-imports` guard in eslint.config.js.
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { SealedBoxError, sealedBoxBase64 } from "@/server/github-sealed-box.server";

/** X25519 public key length; a sealed box adds this plus a 16-byte MAC. */
const SEAL_OVERHEAD = 32 + 16;

let recipient: { publicKey: Uint8Array; privateKey: Uint8Array };
let recipientPublicKeyBase64: string;

beforeAll(async () => {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  recipient = { publicKey: pair.publicKey, privateKey: pair.privateKey };
  recipientPublicKeyBase64 = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
});

/** Open one of our seals the way GitHub's Actions backend would. */
function openWithLibsodium(encryptedValue: string): string {
  const sealed = sodium.from_base64(encryptedValue, sodium.base64_variants.ORIGINAL);
  const opened = sodium.crypto_box_seal_open(sealed, recipient.publicKey, recipient.privateKey);
  return new TextDecoder().decode(opened);
}

describe("sealedBoxBase64", () => {
  it("produces a seal libsodium's crypto_box_seal_open accepts", () => {
    const secret = "sk-proj-not-a-real-key-0123456789";
    expect(openWithLibsodium(sealedBoxBase64(recipientPublicKeyBase64, secret))).toBe(secret);
  });

  it("round-trips the real secret shapes Mission Control pushes", () => {
    // A URL, a hex webhook secret and an API key — the three shapes in
    // buildCodexRepoSecrets(). Empty is included because a zero-length
    // message is the classic off-by-one in a hand-rolled box.
    for (const value of [
      "https://mission-control.aurixasystems.com.au/api/public/hooks/codex-security",
      "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
      "sk-proj-AAAABBBBCCCCDDDD",
      "",
    ]) {
      expect(openWithLibsodium(sealedBoxBase64(recipientPublicKeyBase64, value))).toBe(value);
    }
  });

  it("round-trips multi-byte UTF-8 without truncating", () => {
    // TextEncoder byte length ≠ string length here; a length check written
    // against the string would corrupt the box.
    const value = "pässwörd–✓–🔐";
    expect(openWithLibsodium(sealedBoxBase64(recipientPublicKeyBase64, value))).toBe(value);
  });

  it("round-trips a value larger than the base64 chunking window", () => {
    // bytesToBase64 chunks its String.fromCharCode spread at 0x8000; cross
    // that boundary so a chunking bug cannot hide.
    const value = "x".repeat(0x8000 * 2 + 7);
    expect(openWithLibsodium(sealedBoxBase64(recipientPublicKeyBase64, value))).toBe(value);
  });

  it("emits ephemeral-key + MAC overhead and nothing more", () => {
    const secret = "sk-length-probe";
    const sealed = sodium.from_base64(
      sealedBoxBase64(recipientPublicKeyBase64, secret),
      sodium.base64_variants.ORIGINAL,
    );
    expect(sealed.length).toBe(secret.length + SEAL_OVERHEAD);
  });

  it("uses a fresh ephemeral keypair for every call", () => {
    // Reusing the ephemeral key across seals would reuse the nonce too, and
    // XSalsa20 nonce reuse leaks plaintext. The first 32 bytes are the
    // ephemeral public key.
    const a = sealedBoxBase64(recipientPublicKeyBase64, "same-value");
    const b = sealedBoxBase64(recipientPublicKeyBase64, "same-value");
    expect(a).not.toBe(b);
    expect(a.slice(0, 43)).not.toBe(b.slice(0, 43));
  });

  it("rejects a public key of the wrong length instead of sealing to nothing", () => {
    const short = sodium.to_base64(new Uint8Array(16), sodium.base64_variants.ORIGINAL);
    expect(() => sealedBoxBase64(short, "v")).toThrow(SealedBoxError);
    expect(() => sealedBoxBase64(short, "v")).toThrow(/16 bytes, expected 32/);
  });

  it("rejects a malformed public key with a message naming the cause", () => {
    expect(() => sealedBoxBase64("!!! not base64 !!!", "v")).toThrow(SealedBoxError);
    expect(() => sealedBoxBase64("!!! not base64 !!!", "v")).toThrow(/not valid base64/);
  });
});
