import { describe, expect, it } from "vitest";
import { buildLeadSubject } from "./fit-analysis.functions";

/** A lead that has been all the way through the priority-access funnel. */
const fullFunnelLead = {
  application_id: "AX-C94B1D8EC9",
  first_name: "Rugesh",
  last_name: "Naidu",
  email: "rugesh@npcservices.com.au",
  mobile_number: "+61412345678",
  entity_name: "Naidu Property Consulting Services",
  entity_classification: "property_advisory",
  transaction_volume: "26_to_75",
  tech_stack_bottlenecks: "Three spreadsheets and a shared inbox.",
  role: "ceo",
  primary_areas: ["disconnected_systems", "compliance_aml"],
  additional_notes: "Two entities under one group.",
  form_version: "stage-1-priority-access-v3",
  submitted_at: "2026-07-31T10:10:18.868Z",
  source: "AURIXA Contact Waitlist Page",
  page: "/contact",
  utm_source: "linkedin",
  utm_medium: "cpc",
  utm_campaign: "priority-access-q3",
  landing_page: "/?utm_source=linkedin",
  referrer: "https://www.linkedin.com/",
  marketing_consent: true,
  airtable_status: "On Waitlist",
  notes: "Referred by an existing client.",
  stage: 3,
  stage2_status: "Completed",
  stage2_completed_at: "2026-07-31T10:15:10.675Z",
  stage2_next_step: "General platform demonstration",
  stage2_investment: "More than A$5,000 per month",
  stage2_timeline: "Within 3 months",
  stage2_summary: "CURRENT SYSTEMS\n\nNo central system; email and spreadsheets.",
  stage2_answers: { userCount: "4_to_10", migration: "yes", security: ["mfa"] },
  stage3_booked_at: "2026-07-31T10:16:41.000Z",
  stage3_status: "Requested",
  stage3_session_start: "2026-08-06T01:00:00.000Z",
  stage3_time_zone: "Australia/Sydney",
};

describe("buildLeadSubject", () => {
  it("carries the Stage 1 answers the engine could not previously see", () => {
    const subject = buildLeadSubject(fullFunnelLead) as Record<string, unknown>;
    expect(subject).toMatchObject({
      application_id: "AX-C94B1D8EC9",
      entity_name: "Naidu Property Consulting Services",
      contact_role: "ceo",
      priority_areas_to_improve: ["disconnected_systems", "compliance_aml"],
      applicant_additional_notes: "Two entities under one group.",
      form_version: "stage-1-priority-access-v3",
    });
  });

  it("carries the readiness questionnaire — the richest qualification data we hold", () => {
    const subject = buildLeadSubject(fullFunnelLead) as Record<string, any>;
    expect(subject.readiness_questionnaire).toMatchObject({
      completed_at: "2026-07-31T10:15:10.675Z",
      preferred_next_step: "General platform demonstration",
      approved_investment_range: "More than A$5,000 per month",
      implementation_timeline: "Within 3 months",
    });
    expect(subject.readiness_questionnaire.answers).toMatchObject({ userCount: "4_to_10" });
    expect(subject.readiness_questionnaire.summary).toMatch(/CURRENT SYSTEMS/);
  });

  it("carries the booked strategic review", () => {
    const subject = buildLeadSubject(fullFunnelLead) as Record<string, any>;
    expect(subject.strategic_review_booking).toMatchObject({
      booked_at: "2026-07-31T10:16:41.000Z",
      status: "Requested",
      session_start: "2026-08-06T01:00:00.000Z",
    });
    expect(subject.funnel_stage_reached).toBe(3);
  });

  it("reports honestly that a Stage 1-only lead has gone no further", () => {
    const subject = buildLeadSubject({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.test",
      entity_name: "Analytical Engines",
      stage: 1,
      primary_areas: [],
    }) as Record<string, any>;
    expect(subject.readiness_questionnaire).toBeNull();
    expect(subject.strategic_review_booking).toBeNull();
    expect(subject.funnel_stage_reached).toBe(1);
    // An empty selection is absent, not an empty list to reason about.
    expect(subject.priority_areas_to_improve).toBeUndefined();
  });

  it("treats a Stage 2 completion as present even without the answer blob", () => {
    const subject = buildLeadSubject({
      email: "a@b.co",
      stage: 2,
      stage2_completed_at: "2026-07-31T10:15:10.675Z",
      stage2_next_step: "Pricing discussion",
      stage2_answers: {},
    }) as Record<string, any>;
    expect(subject.readiness_questionnaire).toMatchObject({
      preferred_next_step: "Pricing discussion",
    });
    expect(subject.readiness_questionnaire.answers).toBeUndefined();
  });

  it("keeps how they found us — a referral and a cold click are different prospects", () => {
    const subject = buildLeadSubject(fullFunnelLead) as Record<string, any>;
    expect(subject.attribution).toMatchObject({
      utm_source: "linkedin",
      utm_medium: "cpc",
      utm_campaign: "priority-access-q3",
      referrer: "https://www.linkedin.com/",
    });
  });

  it("merges the operator's own notes with the run-time note", () => {
    const subject = buildLeadSubject(fullFunnelLead, "Asked about SSO on the call.") as Record<
      string,
      any
    >;
    expect(subject.operator_notes).toBe(
      "Referred by an existing client.\nAsked about SSO on the call.",
    );
  });

  it("omits operator notes entirely when there are none", () => {
    const subject = buildLeadSubject({ email: "a@b.co" }) as Record<string, any>;
    expect(subject.operator_notes).toBeUndefined();
  });

  it("defaults a lead with no recorded stage to Stage 1", () => {
    expect((buildLeadSubject({ email: "a@b.co" }) as Record<string, any>).funnel_stage_reached).toBe(
      1,
    );
  });
});
