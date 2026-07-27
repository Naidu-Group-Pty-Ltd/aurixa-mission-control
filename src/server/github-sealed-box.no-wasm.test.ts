// Regression guard for the bug this module was written to kill.
//
// Cloudflare Workers refuses to compile WebAssembly from bytes at runtime.
// libsodium-wrappers does exactly that on first use, so every Actions secret
// sync failed in production with:
//
//   Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation
//   disallowed by embedder). Build with -sASSERTIONS for more info.
//
// This file stands in for that embedder: it makes every entry point into the
// Wasm compiler throw before importing anything, then seals a value. If a
// dependency ever drags a Wasm-backed crypto library back into the secret
// path, this test fails in CI instead of in production.
//
// Deliberately isolated in its own file — importing libsodium here (as the
// interop test does) would instantiate Wasm before the denial is installed.
import { describe, expect, it, vi } from "vitest";

const deny = () => {
  throw new WebAssembly.CompileError(
    "WebAssembly.instantiate(): Wasm code generation disallowed by embedder",
  );
};

vi.stubGlobal("WebAssembly", {
  ...WebAssembly,
  instantiate: deny,
  instantiateStreaming: deny,
  compile: deny,
  compileStreaming: deny,
  Module: function () {
    deny();
  },
  Instance: function () {
    deny();
  },
  CompileError: WebAssembly.CompileError,
});

describe("sealed box under an embedder that forbids Wasm codegen", () => {
  it("seals without touching the Wasm compiler", async () => {
    // Imported after the denial is installed so module-init Wasm would fail.
    const { sealedBoxBase64 } = await import("@/server/github-sealed-box.server");
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

    const encrypted = sealedBoxBase64(publicKeyBase64, "sk-value-under-a-strict-embedder");

    // 32-byte ephemeral key + 32-byte value + 16-byte MAC = 80 bytes.
    expect(atob(encrypted)).toHaveLength(80);
  });

  it("confirms the denial is actually in force", () => {
    // Guards the guard: if stubGlobal silently stopped working, the test
    // above would pass for the wrong reason.
    expect(() => WebAssembly.compile(new Uint8Array())).toThrow(/disallowed by embedder/);
  });
});
