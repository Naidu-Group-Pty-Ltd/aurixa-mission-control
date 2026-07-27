// Pure-JavaScript libsodium `crypto_box_seal`, used to encrypt GitHub Actions
// secrets before they are PUT to the REST API.
//
// Why this file exists instead of a one-line call into libsodium-wrappers:
//
// libsodium-wrappers is an Emscripten build. The first `await sodium.ready`
// calls `WebAssembly.instantiate()` on a Wasm module embedded in the bundle.
// Mission Control is deployed to Cloudflare Workers (see wrangler.jsonc), and
// Workers forbids compiling WebAssembly from bytes at runtime — modules have
// to be statically imported as bindings. So that await rejected with:
//
//   Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation
//   disallowed by embedder). Build with -sASSERTIONS for more info.
//
// `putRepoSecret()` awaited sodium before every single write, so an operator
// clicking "Sync secrets" got that same line once per secret name — six
// identical failures that looked like six problems instead of one.
//
// The sealed box itself is small and fully specified, so we build it from
// pure-JS primitives that run anywhere: tweetnacl (X25519 + XSalsa20-Poly1305)
// and blakejs (BLAKE2b). No Wasm, no native addons, no runtime codegen.
//
// crypto_box_seal(m, pk), verbatim from the libsodium spec:
//
//   (epk, esk) = crypto_box_keypair()
//   nonce      = BLAKE2b(epk ‖ pk, outlen = 24)      // unkeyed
//   c          = crypto_box_easy(m, nonce, pk, esk)  // X25519-XSalsa20-Poly1305
//   sealed     = epk ‖ c
//
// The nonce is not transmitted: the recipient re-derives it from the epk that
// prefixes the box. github-sealed-box.server.test.ts proves byte-for-byte
// compatibility by opening our output with libsodium's own
// crypto_box_seal_open, and github-sealed-box.no-wasm.test.ts proves the path
// still works when WebAssembly compilation is denied.
import { blake2b } from "blakejs";
import nacl from "tweetnacl";

/** X25519 public/secret key length. */
const KEY_BYTES = 32;
/** XSalsa20 nonce length — also the BLAKE2b output length used to derive it. */
const NONCE_BYTES = 24;
/** Poly1305 authentication tag, prepended to the ciphertext by crypto_box. */
const MAC_BYTES = 16;

/**
 * Encryption failed locally, before GitHub was ever contacted.
 *
 * Distinguished from a transport/permission error because the remedy is
 * completely different: nothing about the repository, the App installation or
 * its permissions can fix it, and retrying the remaining secrets cannot
 * succeed. `describeSecretError` keys off this type to say so.
 */
export class SealedBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedBoxError";
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa wants a latin1 string. Chunk the spread so a large secret cannot
  // blow the argument limit on String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function randomBytes(length: number): Uint8Array {
  const webcrypto = globalThis.crypto;
  if (typeof webcrypto?.getRandomValues !== "function") {
    throw new SealedBoxError(
      "no cryptographic random source — globalThis.crypto.getRandomValues is unavailable in this runtime",
    );
  }
  return webcrypto.getRandomValues(new Uint8Array(length));
}

/**
 * Seal `plaintext` against a repository's Actions public key.
 *
 * @param publicKeyBase64 the `key` field from
 *   `GET /repos/{owner}/{repo}/actions/secrets/public-key` — standard base64,
 *   32 raw bytes of X25519 public key.
 * @returns standard base64 of `epk ‖ ciphertext`, ready to send as
 *   `encrypted_value`.
 */
export function sealedBoxBase64(publicKeyBase64: string, plaintext: string): string {
  let recipientPublicKey: Uint8Array;
  try {
    recipientPublicKey = base64ToBytes(publicKeyBase64);
  } catch {
    throw new SealedBoxError(
      "GitHub's Actions public key for this repository is not valid base64 — the public-key response was malformed",
    );
  }
  if (recipientPublicKey.length !== KEY_BYTES) {
    throw new SealedBoxError(
      `GitHub's Actions public key for this repository is ${recipientPublicKey.length} bytes, ` +
        `expected ${KEY_BYTES}`,
    );
  }

  const message = new TextEncoder().encode(plaintext);
  const ephemeral = nacl.box.keyPair.fromSecretKey(randomBytes(KEY_BYTES));
  try {
    const nonce = blake2b(
      concatBytes(ephemeral.publicKey, recipientPublicKey),
      undefined,
      NONCE_BYTES,
    );
    const ciphertext = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
    if (!ciphertext || ciphertext.length !== message.length + MAC_BYTES) {
      // Unreachable with well-formed inputs; a mismatch here would mean the
      // primitive changed shape under us, and silently shipping a bad box
      // would surface much later as an unusable Actions secret.
      throw new SealedBoxError("sealed box produced an unexpected ciphertext length");
    }
    return bytesToBase64(concatBytes(ephemeral.publicKey, ciphertext));
  } finally {
    // The ephemeral secret is single-use; do not leave it in the heap for a
    // heap snapshot or a later allocation to pick up.
    ephemeral.secretKey.fill(0);
  }
}

/**
 * True when `err` came from the local encryption path rather than from GitHub.
 *
 * The `instanceof` check is the reliable one. The message sniffing behind it
 * is a safety net for the specific regression this module was written to
 * eliminate: if a future dependency drags a Wasm-backed crypto library back
 * into the secret-sync path, the failure is recognised and explained rather
 * than reported as an opaque `Aborted(CompileError: ...)`.
 */
export function isLocalEncryptionFailure(err: unknown): boolean {
  if (err instanceof SealedBoxError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /WebAssembly|Wasm code generation|libsodium|asm\.js/i.test(message);
}
