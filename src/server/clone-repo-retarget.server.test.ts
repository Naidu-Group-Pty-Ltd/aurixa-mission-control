import { describe, it, expect } from "vitest";
import {
  rewriteConfigTomlProjectId,
  configTomlNamesForeignProject,
  stripWorkflowProjectRefDefault,
  workflowHasProjectRefDefault,
} from "./clone-repo-retarget.server";

const PRIME = "dduzbchuswwbefdunfct";
const CLONE = "plisdzywzleljorrphxv";

describe("rewriteConfigTomlProjectId", () => {
  it("points project_id at the clone", () => {
    const out = rewriteConfigTomlProjectId(`project_id = "${PRIME}"\n`, CLONE);
    expect(out).toBe(`project_id = "${CLONE}"\n`);
  });

  it("leaves the [functions.*] blocks alone", () => {
    // config.toml carries one block per edge function — 423 on this prime.
    // A blanket replace of the ref would corrupt every one of them.
    const toml = [
      `project_id = "${PRIME}"`,
      "",
      "[functions.aml-cases]",
      "verify_jwt = false",
      "",
      "[functions.custom-auth-login]",
      "verify_jwt = false",
      "",
    ].join("\n");
    const out = rewriteConfigTomlProjectId(toml, CLONE);
    expect(out).toContain("[functions.aml-cases]");
    expect(out).toContain("[functions.custom-auth-login]");
    expect(out.match(/verify_jwt = false/g)).toHaveLength(2);
    expect(out).toContain(`project_id = "${CLONE}"`);
    expect(out).not.toContain(PRIME);
  });

  it("rewrites only the first assignment", () => {
    const toml = `project_id = "${PRIME}"\n# project_id = "${PRIME}"\n`;
    const out = rewriteConfigTomlProjectId(toml, CLONE);
    expect(out.match(new RegExp(CLONE, "g"))).toHaveLength(1);
  });

  it("tolerates leading whitespace", () => {
    expect(rewriteConfigTomlProjectId(`  project_id = "${PRIME}"`, CLONE)).toContain(CLONE);
  });
});

describe("configTomlNamesForeignProject", () => {
  it("is true while the file names another project", () => {
    expect(configTomlNamesForeignProject(`project_id = "${PRIME}"`, CLONE)).toBe(true);
  });

  it("is false once it names our own", () => {
    expect(configTomlNamesForeignProject(`project_id = "${CLONE}"`, CLONE)).toBe(false);
  });

  it("is false when there is no project_id to disagree with", () => {
    expect(configTomlNamesForeignProject("[functions.x]\nverify_jwt = false\n", CLONE)).toBe(false);
  });
});

describe("stripWorkflowProjectRefDefault", () => {
  const withDefault = `          PROJECT_REF: \${{ vars.SUPABASE_PROJECT_REF || '${PRIME}' }}\n`;

  it("removes the hard-coded fallback", () => {
    expect(stripWorkflowProjectRefDefault(withDefault)).toBe(
      "          PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}\n",
    );
  });

  it("does NOT substitute the clone's ref", () => {
    // The ref belongs in a repository variable, where it changes without a
    // commit. A second hard-coded default is the same bug with a new value.
    const out = stripWorkflowProjectRefDefault(withDefault);
    expect(out).not.toContain(CLONE);
    expect(out).not.toContain(PRIME);
  });

  it("removes every occurrence — the deploy workflow has two", () => {
    const twice = withDefault + "\n" + withDefault;
    expect(workflowHasProjectRefDefault(stripWorkflowProjectRefDefault(twice))).toBe(false);
  });

  it("leaves an already-fixed workflow untouched", () => {
    const clean = "PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}\n";
    expect(stripWorkflowProjectRefDefault(clean)).toBe(clean);
  });

  it("tolerates spacing variants", () => {
    const spaced = "${{vars.SUPABASE_PROJECT_REF||'abc'}}";
    expect(stripWorkflowProjectRefDefault(spaced)).toBe("${{ vars.SUPABASE_PROJECT_REF }}");
  });
});

describe("workflowHasProjectRefDefault", () => {
  it("detects the shape that made a clone able to deploy into the prime", () => {
    expect(workflowHasProjectRefDefault(`\${{ vars.SUPABASE_PROJECT_REF || '${PRIME}' }}`)).toBe(
      true,
    );
  });

  it("is false once the job fails closed", () => {
    expect(workflowHasProjectRefDefault("${{ vars.SUPABASE_PROJECT_REF }}")).toBe(false);
  });
});
