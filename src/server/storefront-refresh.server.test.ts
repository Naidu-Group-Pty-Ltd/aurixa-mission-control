// The mirror refresh has one job and one rule: tell the truth about whether
// the storefront picked the change up, and never take a cutover down with it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRefresh, refreshStorefrontMirror } from "./storefront-refresh.server";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("refreshStorefrontMirror", () => {
  it("reports success and carries the row counts back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, counts: { catalog_packs: 8, catalog_plans: 4 } })),
    );
    const r = await refreshStorefrontMirror();
    expect(r.ok).toBe(true);
    expect(r.counts?.catalog_packs).toBe(8);
  });

  it("asks the storefront to re-pull, with the gateway token attached", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await refreshStorefrontMirror();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/functions\/v1\/catalog-sync$/);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer .+/);
  });

  it("treats ok:false in a 200 body as a failure", async () => {
    // catalog-sync answers 200 with ok:false when its own pull fails, so the
    // status code alone is not the answer.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "mc_catalog_500" })),
    );
    const r = await refreshStorefrontMirror();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("mc_catalog_500");
  });

  it("names the status when something in front of the function answers", async () => {
    // An auth gateway or proxy returns HTML, and JSON.parse on it would
    // surface as "Unexpected token <" — which tells an operator nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!DOCTYPE html><html>…", { status: 401 })),
    );
    const r = await refreshStorefrontMirror();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/storefront_sync_http_401/);
  });

  it("never throws when the network does", async () => {
    // The whole point: a cutover that succeeded must not be reported as failed
    // because the mirror was unreachable.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await refreshStorefrontMirror();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ECONNREFUSED");
  });

  it("gives up rather than hanging the cutover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );
    vi.useFakeTimers();
    const pending = refreshStorefrontMirror();
    await vi.advanceTimersByTimeAsync(16_000);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });
});

describe("describeRefresh", () => {
  it("says what landed", () => {
    const msg = describeRefresh({ ok: true, counts: { catalog_packs: 8, catalog_plans: 4 } });
    expect(msg).toMatch(/refreshed/i);
    expect(msg).toContain("8 packs");
    expect(msg).toContain("4 plans");
  });

  it("is still a sentence when the sync reported no counts", () => {
    expect(describeRefresh({ ok: true })).toBe("Storefront pricing page refreshed.");
  });

  it("on failure, says the change IS live and when the page will catch up", () => {
    // The failure that matters is the one that reads as "the cutover broke".
    // It didn't — only the mirror is behind, and it self-heals.
    const msg = describeRefresh({ ok: false, error: "boom" }, "ladder");
    expect(msg).toContain("ladder is live here");
    expect(msg).toContain("boom");
    expect(msg).toMatch(/15 minutes/);
  });
});
