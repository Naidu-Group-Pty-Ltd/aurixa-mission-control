import { describe, expect, it } from "vitest";
import { lifecyclePatchFor, readVercelWebhook } from "./vercelWebhook.pure";

const prod = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  payload: {
    target: "production",
    project: { id: "prj_1" },
    deployment: { id: "dpl_1", url: "clone-abc.vercel.app" },
    ...extra,
  },
});

describe("readVercelWebhook", () => {
  it("reads a successful production build", () => {
    expect(readVercelWebhook(prod("deployment.succeeded"))).toEqual({
      kind: "build",
      projectId: "prj_1",
      deploymentId: "dpl_1",
      state: "ready",
      target: "production",
      url: "clone-abc.vercel.app",
      errorMessage: null,
    });
  });

  it("reads a failed production build and keeps the message", () => {
    const r = readVercelWebhook(prod("deployment.error", { error: { message: "Build exceeded" } }));
    expect(r.kind).toBe("build");
    if (r.kind === "build") {
      expect(r.state).toBe("error");
      expect(r.errorMessage).toBe("Build exceeded");
    }
  });

  it("ignores preview builds", () => {
    // A failing preview is a pull request that will not merge, not a live site
    // gone stale. Alarming on both means alarming on every branch push.
    const r = readVercelWebhook({
      type: "deployment.error",
      payload: { target: "preview", project: { id: "prj_1" }, deployment: { id: "d" } },
    });
    expect(r).toEqual({ kind: "ignored", reason: "not_production" });
  });

  it("treats an absent target as not production", () => {
    // An event with no target anywhere is not evidence about production, and
    // guessing would mark a clone failed on a preview build.
    const r = readVercelWebhook({
      type: "deployment.error",
      payload: { project: { id: "prj_1" }, deployment: { id: "d" } },
    });
    expect(r).toEqual({ kind: "ignored", reason: "not_production" });
  });

  it("finds the target on the deployment when the payload omits it", () => {
    const r = readVercelWebhook({
      type: "deployment.succeeded",
      payload: { project: { id: "prj_1" }, deployment: { id: "d", target: "production" } },
    });
    expect(r.kind).toBe("build");
  });

  it("names a reason for every ignore rather than dropping silently", () => {
    // Vercel retries a non-2xx, so an ignore has to be a 200 with a recorded
    // reason. A receiver that cannot say why it did nothing is undebuggable.
    expect(readVercelWebhook(null).kind).toBe("ignored");
    expect(readVercelWebhook("nope")).toEqual({ kind: "ignored", reason: "unparseable" });
    expect(readVercelWebhook({ type: "project.created" })).toEqual({
      kind: "ignored",
      reason: "unhandled_type",
    });
    expect(readVercelWebhook({ type: "deployment.succeeded", payload: {} })).toEqual({
      kind: "ignored",
      reason: "no_project",
    });
  });
});

describe("lifecyclePatchFor", () => {
  it("does not touch status for a clone that is already live", () => {
    // Two writers on one column arriving out of order is how a row advertises a
    // state neither of them decided. The webhook records build health; the drain
    // owns `status`.
    expect(
      lifecyclePatchFor({
        currentStatus: "live",
        trackedDeploymentId: "dpl_1",
        state: "error",
        deploymentId: "dpl_1",
      }),
    ).toBeNull();
  });

  it("tells a waiting drain its build finished", () => {
    expect(
      lifecyclePatchFor({
        currentStatus: "deploying",
        trackedDeploymentId: "dpl_1",
        state: "ready",
        deploymentId: "dpl_1",
      }),
    ).toEqual({ status: "attaching_domain", detail: "Build reported ready by webhook." });
  });

  it("fails the row when the build it was waiting on failed", () => {
    const p = lifecyclePatchFor({
      currentStatus: "deploying",
      trackedDeploymentId: "dpl_1",
      state: "error",
      deploymentId: "dpl_1",
    });
    expect(p?.status).toBe("failed");
  });

  it("ignores a build the drain is not watching", () => {
    // A concurrent build of another commit finishing first must not decide this
    // row's fate.
    expect(
      lifecyclePatchFor({
        currentStatus: "deploying",
        trackedDeploymentId: "dpl_1",
        state: "ready",
        deploymentId: "dpl_2",
      }),
    ).toBeNull();
  });

  it("ignores an in-progress state", () => {
    expect(
      lifecyclePatchFor({
        currentStatus: "deploying",
        trackedDeploymentId: "dpl_1",
        state: "building",
        deploymentId: "dpl_1",
      }),
    ).toBeNull();
  });
});
