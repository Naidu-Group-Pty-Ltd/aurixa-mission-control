import { describe, expect, it } from "vitest";
import {
  BREAKAGE_VECTORS,
  TICKET_CATEGORIES,
  classifyTicket,
  priorityAtOrBelow,
  severityToPriority,
} from "./ticket-classification";

describe("classifyTicket", () => {
  it("pins the band edges of the category × vector matrix", () => {
    // A security threat taking everything down is the definition of P0.
    expect(
      classifyTicket({ category: "security_threat", breakageVector: "full_outage" }).priority,
    ).toBe("P0");
    // A security threat with no breakage is a reported vulnerability: P2,
    // which is what lets medium-severity scan findings self-heal.
    expect(classifyTicket({ category: "security_threat", breakageVector: "none" }).priority).toBe(
      "P2",
    );
    expect(classifyTicket({ category: "api_outage", breakageVector: "full_outage" }).priority).toBe(
      "P0",
    );
    expect(
      classifyTicket({ category: "provider_downtime", breakageVector: "degraded_performance" })
        .priority,
    ).toBe("P2");
    expect(classifyTicket({ category: "bug", breakageVector: "single_feature" }).priority).toBe(
      "P3",
    );
    expect(classifyTicket({ category: "question", breakageVector: "none" }).priority).toBe("P4");
  });

  it("escalates on security language in the report text but never de-escalates", () => {
    const quiet = classifyTicket({ category: "bug", breakageVector: "single_feature" });
    const loud = classifyTicket({
      category: "bug",
      breakageVector: "single_feature",
      description: "I think an API key was exposed in the error page shown to clients.",
    });
    expect(loud.score).toBeGreaterThan(quiet.score);

    // Calm language must not lower a hot category.
    const calm = classifyTicket({
      category: "api_outage",
      breakageVector: "full_outage",
      description: "No big deal, take your time.",
    });
    expect(calm.priority).toBe("P0");
  });

  it("always routes P0 and P1 to a human", () => {
    const p0 = classifyTicket({ category: "security_threat", breakageVector: "full_outage" });
    expect(p0.requiresHuman).toBe(true);
    expect(p0.autoRemediable).toBe(false);

    const p1 = classifyTicket({ category: "api_outage", breakageVector: "partial_outage" });
    expect(p1.priority).toBe("P1");
    expect(p1.requiresHuman).toBe(true);
  });

  it("always routes data, billing and access tickets to a human, even at low priority", () => {
    for (const category of ["data_issue", "billing", "access"] as const) {
      const c = classifyTicket({ category, breakageVector: "cosmetic" });
      expect(c.requiresHuman).toBe(true);
      expect(c.autoRemediable).toBe(false);
    }
  });

  it("lets P2-and-below tickets with a lane self-remediate", () => {
    const monitor = classifyTicket({
      category: "provider_downtime",
      breakageVector: "degraded_performance",
    });
    expect(monitor.priority).toBe("P2");
    expect(monitor.autoRemediable).toBe(true);
    expect(monitor.lane).toBe("monitor");

    const rescan = classifyTicket({ category: "bug", breakageVector: "single_feature" });
    expect(rescan.autoRemediable).toBe(true);
    expect(rescan.lane).toBe("rescan");

    const securityScan = classifyTicket({
      category: "security_threat",
      breakageVector: "none",
    });
    expect(securityScan.priority).toBe("P2");
    expect(securityScan.autoRemediable).toBe(true);
    expect(securityScan.lane).toBe("security_scan");
  });

  it("gives lane-less categories no auto-remediation", () => {
    const c = classifyTicket({ category: "feature_request", breakageVector: "none" });
    expect(c.autoRemediable).toBe(false);
    expect(c.lane).toBeNull();
  });

  it("produces a valid classification for every category × vector cell", () => {
    for (const category of TICKET_CATEGORIES) {
      for (const breakageVector of BREAKAGE_VECTORS) {
        const c = classifyTicket({ category, breakageVector });
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(100);
        expect(["P0", "P1", "P2", "P3", "P4"]).toContain(c.priority);
        expect(c.slaMinutes).toBeGreaterThan(0);
        // The invariant the whole pipeline rests on: nothing above P2 is
        // ever auto-remediable.
        if (c.priority === "P0" || c.priority === "P1") {
          expect(c.autoRemediable).toBe(false);
        }
        // And nothing is both auto and human-gated.
        expect(c.autoRemediable && c.requiresHuman).toBe(false);
      }
    }
  });

  it("records its reasoning for the audit trail", () => {
    const c = classifyTicket({ category: "api_outage", breakageVector: "full_outage" });
    expect(c.reasons.length).toBeGreaterThanOrEqual(2);
    expect(c.reasons.join(" ")).toContain("api_outage");
  });
});

describe("severityToPriority", () => {
  it("maps the scanner's scale onto the ticket scale", () => {
    expect(severityToPriority("critical")).toBe("P0");
    expect(severityToPriority("high")).toBe("P1");
    expect(severityToPriority("medium")).toBe("P2");
    expect(severityToPriority("low")).toBe("P3");
    expect(severityToPriority("info")).toBe("P4");
    expect(severityToPriority("unknown-junk")).toBe("P4");
  });
});

describe("priorityAtOrBelow", () => {
  it("orders priorities by urgency", () => {
    expect(priorityAtOrBelow("P2", "P2")).toBe(true);
    expect(priorityAtOrBelow("P3", "P2")).toBe(true);
    expect(priorityAtOrBelow("P1", "P2")).toBe(false);
    expect(priorityAtOrBelow("P0", "P2")).toBe(false);
  });
});
