import { describe, expect, it } from "vitest";
import { mapRecord } from "./airtable-sync.server";

/**
 * A row from the Airtable "Aurixa Waitlist" table, in the shape the connector
 * gateway returns it: single selects as `{id, name}`, multi-selects as arrays
 * of the same, formulas as bare numbers.
 */
const waitlistRecord = {
  id: "recnC8j6YucPUCX4L",
  createdTime: "2026-07-31T10:10:19.000Z",
  fields: {
    "First Name": "Rugesh",
    "Last Name": "Naidu",
    "Corporate Email": "Rugesh@NPCServices.com.au",
    "Entity Name": "Naidu Property Consulting Services",
    "Entity Classification": { id: "sel42ueOkHR0kpS2V", name: "property_advisory" },
    "Annual Transactional Value": { id: "selgPRHnI4sKOd6jG", name: "26_to_75" },
    "Application ID": "AX-C94B1D8EC9",
    "Form Version": "stage-1-priority-access-v3",
    "Your Role": { id: "sel9YgQRZo8I70oMc", name: "Chief Executive Officer" },
    "Primary Areas to Improve": [
      { id: "selZtGDTPffKVOeRl", name: "Disconnected systems and duplicate data entry" },
      { id: "selzXorD3kN9RXagP", name: "Document collection and management" },
    ],
    "Privacy Acknowledged": true,
    "Marketing Consent": true,
    Source: "AURIXA Contact Waitlist Page",
    "UTM Source": "linkedin",
    Status: "On Waitlist",
    "Date Added": "2026-07-31T10:10:18.868Z",
    "Stage 2 Reached": 1,
    "Stage 2 Started At": "2026-07-31T10:15:10.675Z",
    "Stage 3 Reached": 0,
  },
};

describe("mapRecord", () => {
  it("keeps the application reference that joins the three stages", () => {
    expect(mapRecord(waitlistRecord)?.application_id).toBe("AX-C94B1D8EC9");
  });

  it("unwraps single selects and multi-selects to their slugs", () => {
    const mapped = mapRecord(waitlistRecord);
    expect(mapped).toMatchObject({
      entity_classification: "property_advisory",
      transaction_volume: "26_to_75",
      role: "Chief Executive Officer",
      primary_areas: [
        "Disconnected systems and duplicate data entry",
        "Document collection and management",
      ],
    });
  });

  it("reads the Stage 2 / Stage 3 rollups the previous mapping ignored", () => {
    const mapped = mapRecord(waitlistRecord);
    expect(mapped).toMatchObject({
      stage: 2,
      // "Stage 2 Started At" rolls up the response's submitted time.
      stage2_completed_at: "2026-07-31T10:15:10.675Z",
      stage3_status: null,
      stage3_booked_at: null,
    });
  });

  it("promotes an applicant to Stage 3 once a booking is rolled up", () => {
    const mapped = mapRecord({
      ...waitlistRecord,
      fields: {
        ...waitlistRecord.fields,
        "Stage 3 Reached": 1,
        "Stage 3 Booking Status": { id: "selDBPfY8M0huujim", name: "Requested" },
        "Stage 3 Booked At": "2026-07-31T10:16:41.000Z",
        "Stage 3 Session Start": "2026-08-06T01:00:00.000Z",
      },
    });
    expect(mapped).toMatchObject({
      stage: 3,
      stage3_status: "Requested",
      stage3_booked_at: "2026-07-31T10:16:41.000Z",
      stage3_session_start: "2026-08-06T01:00:00.000Z",
    });
  });

  it("keeps consent and attribution", () => {
    expect(mapRecord(waitlistRecord)).toMatchObject({
      privacy_acknowledged: true,
      marketing_consent: true,
      utm_source: "linkedin",
      form_version: "stage-1-priority-access-v3",
      airtable_status: "On Waitlist",
      airtable_record_id: "recnC8j6YucPUCX4L",
    });
  });

  it("normalises the email and prefers the submitted date over the row's", () => {
    const mapped = mapRecord(waitlistRecord);
    expect(mapped?.email).toBe("rugesh@npcservices.com.au");
    expect(mapped?.submitted_at).toBe("2026-07-31T10:10:18.868Z");
  });

  it("falls back to the row's creation time when no date was recorded", () => {
    const { "Date Added": _dropped, ...fields } = waitlistRecord.fields;
    expect(mapRecord({ ...waitlistRecord, fields })?.submitted_at).toBe("2026-07-31T10:10:19.000Z");
  });

  it("skips rows that cannot identify a person", () => {
    const cases = [
      { "First Name": "" },
      { "Last Name": "" },
      { "Corporate Email": "" },
      { "Corporate Email": "not-an-email" },
    ];
    for (const override of cases) {
      expect(
        mapRecord({ ...waitlistRecord, fields: { ...waitlistRecord.fields, ...override } }),
      ).toBeNull();
    }
  });

  it("records no journey progress when the rollups are empty", () => {
    const mapped = mapRecord({
      id: "recEmpty000000000",
      createdTime: "2026-07-01T00:00:00.000Z",
      fields: {
        "First Name": "Ada",
        "Last Name": "Lovelace",
        "Corporate Email": "ada@example.test",
      },
    });
    expect(mapped).toMatchObject({
      stage: 1,
      application_id: null,
      stage2_status: null,
      stage2_completed_at: null,
      stage3_status: null,
      primary_areas: [],
    });
  });
});
