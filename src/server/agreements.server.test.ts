// The DocuSign engine, held to its contracts:
//   * the JWT grant is a real RS256 JWT DocuSign will accept — verified with
//     WebCrypto against a generated keypair, not by eyeballing base64;
//   * a PKCS#1 key from the DocuSign console converts to a PKCS#8 WebCrypto
//     can import (the exact shape the console hands out);
//   * the envelope definition matches the anchor-token template — and the
//     template build script carries every anchor verbatim, because a drifted
//     token is a tab that silently never places;
//   * DocuSign's envelope vocabulary folds into ours predictably, with
//     unknown statuses left alone rather than guessed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANCHORS,
  buildEnvelopeDefinition,
  buildFieldTabs,
  buildSignerTabs,
  convertPkcs1ToPkcs8Pem,
  docusignOauthHost,
  docusignRestBaseUrl,
  mapEnvelopeStatus,
  signDocusignJwt,
  type AgreementFields,
} from "./agreements.server";

function b64UrlDecode(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64UrlDecode(segment)));
}

async function generateRsaPem(): Promise<{ privatePem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const lines = btoa(bin).match(/.{1,64}/g) ?? [];
  return {
    privatePem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

describe("signDocusignJwt", () => {
  it("emits the JWT-grant claims DocuSign requires, signed RS256", async () => {
    const { privatePem, publicKey } = await generateRsaPem();
    const token = await signDocusignJwt(
      {
        integrationKey: "ik-123",
        userId: "user-456",
        rsaPrivateKey: privatePem,
        oauthHost: "account-d.docusign.com",
      },
      1_700_000_000,
    );
    const [h, p, s] = token.split(".");
    expect(decodeJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJson(p)).toEqual({
      iss: "ik-123",
      sub: "user-456",
      aud: "account-d.docusign.com",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      scope: "signature impersonation",
    });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64UrlDecode(s) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
  });

  it("accepts a key whose newlines arrived escaped, as env secrets do", async () => {
    const { privatePem } = await generateRsaPem();
    const escaped = privatePem.replace(/\n/g, "\\n");
    const token = await signDocusignJwt({
      integrationKey: "ik",
      userId: "u",
      rsaPrivateKey: escaped,
      oauthHost: "account-d.docusign.com",
    });
    expect(token.split(".")).toHaveLength(3);
  });
});

describe("convertPkcs1ToPkcs8Pem", () => {
  it("leaves a PKCS#8 key untouched", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    expect(convertPkcs1ToPkcs8Pem(pem)).toBe(pem);
  });

  it("wraps a PKCS#1 key into PKCS#8 that WebCrypto imports", async () => {
    // Build a genuine PKCS#1 body by stripping the PKCS#8 wrapper from a
    // generated key (the inner OCTET STRING is the PKCS#1 DER).
    const { privatePem } = await generateRsaPem();
    const der = Uint8Array.from(
      atob(privatePem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")),
      (c) => c.charCodeAt(0),
    );
    // PKCS#8: SEQ { version, algoId(15 bytes), OCTET STRING { pkcs1 } }.
    // Find the OCTET STRING tag (0x04) after the algorithm identifier.
    let idx = -1;
    for (let i = 20; i < der.length - 4; i++) {
      if (der[i] === 0x04 && (der[i + 1] === 0x82 || der[i + 1] === 0x81)) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThan(0);
    const lenForm = der[idx + 1];
    const skip = lenForm === 0x82 ? 4 : 3;
    const pkcs1 = der.subarray(idx + skip);
    let bin = "";
    for (const b of pkcs1) bin += String.fromCharCode(b);
    const pkcs1Pem = `-----BEGIN RSA PRIVATE KEY-----\n${(btoa(bin).match(/.{1,64}/g) ?? []).join("\n")}\n-----END RSA PRIVATE KEY-----`;

    const pkcs8Pem = convertPkcs1ToPkcs8Pem(pkcs1Pem);
    expect(pkcs8Pem).toContain("BEGIN PRIVATE KEY");
    const rewrapped = Uint8Array.from(
      atob(pkcs8Pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")),
      (c) => c.charCodeAt(0),
    );
    const imported = await crypto.subtle.importKey(
      "pkcs8",
      rewrapped,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expect(imported.type).toBe("private");
  });
});

describe("docusign hosts", () => {
  it("defaults to the demo REST base and appends /restapi once", () => {
    expect(docusignRestBaseUrl()).toBe("https://demo.docusign.net/restapi");
    expect(docusignRestBaseUrl("https://demo.docusign.net")).toBe("https://demo.docusign.net/restapi");
    expect(docusignRestBaseUrl("https://au.docusign.net/restapi/")).toBe("https://au.docusign.net/restapi");
  });

  it("routes production REST bases to the production OAuth host", () => {
    expect(docusignOauthHost("https://demo.docusign.net/restapi")).toBe("account-d.docusign.com");
    expect(docusignOauthHost("https://www.docusign.net/restapi")).toBe("account.docusign.com");
    expect(docusignOauthHost("https://au.docusign.net/restapi")).toBe("account.docusign.com");
    expect(docusignOauthHost("https://na3.docusign.net/restapi")).toBe("account.docusign.com");
  });
});

const FIELDS: AgreementFields = {
  clientName: "Avery Client",
  clientEmail: "avery@client.example",
  clientOrg: "Client Pty Ltd",
  serviceTier: "Growth",
  commencementDate: "2026-09-01",
};

describe("buildSignerTabs / buildFieldTabs", () => {
  it("anchors the sign-here tab above the token and scales it", () => {
    const tabs = buildSignerTabs(ANCHORS.clientSig, ANCHORS.clientDate, ANCHORS.clientName);
    expect(tabs.signHereTabs[0]).toMatchObject({
      anchorString: ANCHORS.clientSig,
      anchorYOffset: "-30",
      scaleValue: "0.7",
      anchorIgnoreIfNotPresent: "true",
      anchorCaseSensitive: "true",
      anchorMatchWholeWord: "false",
    });
    expect(tabs.dateSignedTabs[0]).toMatchObject({
      anchorString: ANCHORS.clientDate,
      anchorYOffset: "-2",
      font: "Helvetica",
      fontSize: "Size10",
    });
    expect(tabs.fullNameTabs[0].anchorString).toBe(ANCHORS.clientName);
  });

  it("prefills locked text tabs and drops absent fields rather than sending blanks", () => {
    const tabs = buildFieldTabs({ ...FIELDS, clientOrg: null, commencementDate: null });
    expect(tabs.map((t) => t.anchorString)).toEqual([ANCHORS.fieldClientName, ANCHORS.fieldTier]);
    expect(tabs[0]).toMatchObject({ value: "Avery Client", locked: "true" });
  });
});

describe("buildEnvelopeDefinition", () => {
  it("sends immediately with the client as first signer", () => {
    const def = buildEnvelopeDefinition({
      base64Pdf: "JVBERi0=",
      fields: FIELDS,
      countersignerName: null,
      countersignerEmail: null,
    }) as {
      status: string;
      documents: Array<Record<string, string>>;
      recipients: { signers: Array<Record<string, unknown>> };
    };
    expect(def.status).toBe("sent");
    expect(def.documents[0]).toMatchObject({ documentId: "1", fileExtension: "pdf" });
    expect(def.recipients.signers).toHaveLength(1);
    expect(def.recipients.signers[0]).toMatchObject({
      email: "avery@client.example",
      recipientId: "1",
      routingOrder: "1",
    });
  });

  it("routes an optional countersigner second", () => {
    const def = buildEnvelopeDefinition({
      base64Pdf: "JVBERi0=",
      fields: FIELDS,
      countersignerName: "Aurixa Director",
      countersignerEmail: "director@aurixasystems.com.au",
    }) as { recipients: { signers: Array<Record<string, unknown>> } };
    expect(def.recipients.signers).toHaveLength(2);
    expect(def.recipients.signers[1]).toMatchObject({
      email: "director@aurixasystems.com.au",
      name: "Aurixa Director",
      routingOrder: "2",
    });
  });
});

describe("mapEnvelopeStatus", () => {
  it("folds DocuSign's vocabulary into the agreement lifecycle", () => {
    expect(mapEnvelopeStatus("completed")).toBe("signed");
    expect(mapEnvelopeStatus("Delivered")).toBe("delivered");
    expect(mapEnvelopeStatus("sent")).toBe("sent");
    expect(mapEnvelopeStatus("declined")).toBe("declined");
    expect(mapEnvelopeStatus("voided")).toBe("voided");
  });

  it("leaves unknown statuses alone rather than guessing", () => {
    expect(mapEnvelopeStatus("created")).toBeNull();
    expect(mapEnvelopeStatus("correcting")).toBeNull();
  });
});

describe("template build script", () => {
  it("carries every anchor token verbatim", () => {
    const script = readFileSync(
      join(__dirname, "../../scripts/agreements/build-sla-template.mjs"),
      "utf8",
    );
    for (const token of Object.values(ANCHORS)) {
      // The script writes tokens as JS string literals with escaped
      // backslashes — the source form of the same runtime string.
      const literal = token.replace(/\\/g, "\\\\");
      expect(script, `missing anchor ${token}`).toContain(literal);
    }
  });

  it("ships the built template beside the app", () => {
    const pdf = readFileSync(join(__dirname, "../../public/agreements/aurixa-sla-template.pdf"));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
