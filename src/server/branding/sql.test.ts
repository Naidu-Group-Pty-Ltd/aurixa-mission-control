import { describe, expect, it } from "vitest";
import { buildApplySql, primeContactPayload } from "./sql";

describe("primeContactPayload", () => {
  it("maps the bundle's contact_* keys onto the keys the prime reads", () => {
    const payload = primeContactPayload({
      contact_name: "Sam Owner",
      contact_email: "hello@acme.example",
      contact_phone: "02 9000 0000",
      contact_address: "1 Quay St, Sydney NSW",
      contact_website: "acme.example",
      legal_name: "Acme Property Co Pty Ltd",
      abn: "12 345 678 901",
      licence_number: "RE 12345",
    });
    // The prime's `contact_details` keys (snapshot.pure.ts).
    expect(payload.name).toBe("Acme Property Co Pty Ltd");
    expect(payload.company_name).toBe("Acme Property Co Pty Ltd");
    expect(payload.abn).toBe("12 345 678 901");
    expect(payload.licence_number).toBe("RE 12345");
    expect(payload.email).toBe("hello@acme.example");
    expect(payload.phone).toBe("02 9000 0000");
    expect(payload.address).toBe("1 Quay St, Sydney NSW");
    expect(payload.website).toBe("acme.example");
    // The original keys survive for anything that learned to read them.
    expect(payload.contact_name).toBe("Sam Owner");
  });

  it("falls back to the contact name when no legal name is set, and drops blanks", () => {
    const payload = primeContactPayload({
      contact_name: "Sam Owner",
      contact_email: "  ",
      abn: "",
    });
    expect(payload.name).toBe("Sam Owner");
    expect("email" in payload).toBe(false);
    expect("abn" in payload).toBe(false);
  });

  it("is inlined into the apply SQL", () => {
    const sql = buildApplySql({
      brand_config: { brand_name: "Acme" },
      report_contact: { legal_name: "Acme Pty Ltd", abn: "12 345 678 901" },
      config_hash: "abc123",
    });
    expect(sql).toContain('"abn":"12 345 678 901"');
    expect(sql).toContain('"name":"Acme Pty Ltd"');
  });
});
