import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyCronAuth } from "./cron-auth.server";

function req(headers: Record<string, string> = {}) {
  return new Request("https://example.com/hooks/run-schedules", {
    method: "POST",
    headers,
  });
}

describe("verifyCronAuth", () => {
  const saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    DRIFT_REFRESH_TOKEN: process.env.DRIFT_REFRESH_TOKEN,
  };

  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.DRIFT_REFRESH_TOKEN;
  });

  afterEach(() => {
    process.env.CRON_SECRET = saved.CRON_SECRET;
    process.env.DRIFT_REFRESH_TOKEN = saved.DRIFT_REFRESH_TOKEN;
  });

  it("fails closed with 500 when no secret is configured", () => {
    const res = verifyCronAuth(req({ authorization: "Bearer anything" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(500);
  });

  it("rejects a request with no Authorization header", () => {
    process.env.CRON_SECRET = "s3cret";
    const res = verifyCronAuth(req());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("rejects a wrong token", () => {
    process.env.CRON_SECRET = "s3cret";
    const res = verifyCronAuth(req({ authorization: "Bearer nope" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("rejects the public anon key shape (different value)", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronAuth(req({ authorization: "Bearer eyJhbGci.public.key" })).ok).toBe(false);
  });

  it("accepts the correct CRON_SECRET as a Bearer token", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronAuth(req({ authorization: "Bearer s3cret" })).ok).toBe(true);
  });

  it("accepts the DRIFT_REFRESH_TOKEN secret as a Bearer token", () => {
    process.env.DRIFT_REFRESH_TOKEN = "drift-token";
    expect(verifyCronAuth(req({ authorization: "Bearer drift-token" })).ok).toBe(true);
  });

  it("does not accept a token missing the Bearer prefix", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronAuth(req({ authorization: "s3cret" })).ok).toBe(false);
  });
});
