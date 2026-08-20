import { describe, expect, it } from "vitest";
import { DEPLOYMENT_STATUSES } from "./deploymentState.pure";
import { decideRedeploy } from "./redeployPolicy.pure";

describe("decideRedeploy", () => {
  it("rebuilds a live clone", () => {
    expect(decideRedeploy({ status: "live", hasProject: true })).toEqual({
      act: true,
      resumeAt: "deploying",
      clearDeploymentId: true,
    });
  });

  it("never enrols a clone that has no deployment row", () => {
    // A cascade touches every clone in scope. Reading "somebody pushed code" as
    // consent to start hosting would create projects nobody asked for.
    expect(decideRedeploy({ status: null, hasProject: false })).toEqual({
      act: false,
      reason: "no_deployment_row",
    });
  });

  it("respects a declined deployment", () => {
    expect(decideRedeploy({ status: "not_requested", hasProject: false }).act).toBe(false);
  });

  it("does not resurrect a detached deployment", () => {
    // Rebuilding a site that was deliberately switched off is worse than not
    // rebuilding one that should have been.
    expect(decideRedeploy({ status: "detached", hasProject: true })).toEqual({
      act: false,
      reason: "detached",
    });
  });

  it("leaves a dormant row for the operator's reconcile", () => {
    expect(decideRedeploy({ status: "pending_platform", hasProject: false }).act).toBe(false);
  });

  it("leaves rows that have not reached the build step alone", () => {
    // They will build whatever HEAD is when they get there. Re-queueing from
    // `pending` would re-run project creation and env sync for nothing.
    for (const status of ["pending", "creating_project", "linking_repo", "syncing_env"] as const) {
      expect(decideRedeploy({ status, hasProject: true })).toEqual({
        act: false,
        reason: "already_pending_earlier_step",
      });
    }
  });

  it("abandons an in-flight build of the previous commit", () => {
    // Letting it finish marks the clone live on stale code and silently drops
    // the change that prompted the rebuild.
    expect(decideRedeploy({ status: "deploying", hasProject: true })).toEqual({
      act: true,
      resumeAt: "deploying",
      clearDeploymentId: true,
    });
  });

  it("rewinds domain work to the build", () => {
    // The domain steps are about the NAME. Finishing them would leave the old
    // build serving under a correctly attached domain.
    for (const status of ["attaching_domain", "verifying_domain"] as const) {
      expect(decideRedeploy({ status, hasProject: true }).act).toBe(true);
      const d = decideRedeploy({ status, hasProject: true });
      expect(d.act && d.resumeAt).toBe("deploying");
    }
  });

  it("retries a failure from a step that can actually run", () => {
    // `deploying` with a null project_id fails instantly and spends an attempt
    // to say so.
    const withProject = decideRedeploy({ status: "failed", hasProject: true });
    expect(withProject.act && withProject.resumeAt).toBe("deploying");
    const without = decideRedeploy({ status: "failed", hasProject: false });
    expect(without.act && without.resumeAt).toBe("pending");
  });

  it("has an answer for every status the column accepts", () => {
    // A status added to the machine without a rule here would fall through to a
    // default and quietly stop rebuilding that state's clones.
    for (const status of DEPLOYMENT_STATUSES) {
      const d = decideRedeploy({ status, hasProject: true });
      expect(typeof d.act).toBe("boolean");
      if (!d.act) expect(d.reason).toBeTruthy();
      else expect(["pending", "deploying"]).toContain(d.resumeAt);
    }
  });
});
