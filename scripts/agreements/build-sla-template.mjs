// Build the DocuSign-ready SLA template.
//
//   node scripts/agreements/build-sla-template.mjs
//
// Takes the Gamma-generated agreement body (aurixa-sla-gamma-source.pdf,
// 9 clause pages on the Aurixa dark-navy brand) and appends the Execution
// Schedule — the one page DocuSign actually acts on. The page carries two
// kinds of content:
//
//   * what a person sees: labelled panels for the client details and two
//     signature blocks, in the same navy/gold styling as the Gamma body;
//   * what DocuSign sees: anchor tokens (e.g. \sig_client_1\) printed in
//     6pt text in the EXACT colour of the panel they sit on. Invisible to
//     a reader, found by DocuSign's text scanner, and matched by the tab
//     definitions in src/server/agreements.server.ts (ANCHORS). The prime
//     repo hides white tokens on white paper; on a dark page the same rule
//     is "paint the token in the panel colour", not "paint it white".
//
// The token strings here MUST stay byte-identical to ANCHORS in
// src/server/agreements.server.ts — a drifted token is a tab that silently
// never places. scripts/agreements/check-anchors.spec exists as a unit test
// in src/server/agreements.server.test.ts instead: it reads this file and
// asserts every ANCHORS value appears verbatim.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "aurixa-sla-gamma-source.pdf");
const OUT = join(here, "../../public/agreements/aurixa-sla-template.pdf");

// Anchor tokens — mirror of ANCHORS in src/server/agreements.server.ts.
const ANCHORS = {
  clientSig: "\\sig_client_1\\",
  clientDate: "\\date_client_1\\",
  clientName: "\\name_client_1\\",
  providerSig: "\\sig_provider\\",
  providerDate: "\\date_provider\\",
  providerName: "\\name_provider\\",
  fieldClientName: "\\field_client_name\\",
  fieldClientOrg: "\\field_client_org\\",
  fieldTier: "\\field_service_tier\\",
  fieldCommencement: "\\field_commencement\\",
};

// Aurixa brand (matches the Gamma stratos body and the aurixa-systems site).
const NAVY = rgb(0x0a / 255, 0x0f / 255, 0x1a / 255); // page ground
const PANEL = rgb(0x14 / 255, 0x1c / 255, 0x2c / 255); // field/signature panels
const GOLD = rgb(0xd7 / 255, 0xb3 / 255, 0x5f / 255);
const GOLD_SOFT = rgb(0xf2 / 255, 0xd2 / 255, 0x8d / 255);
const CYAN = rgb(0x5e / 255, 0xdd / 255, 0xe8 / 255);
const BODY = rgb(0xeb / 255, 0xed / 255, 0xf0 / 255);
const MUTED = rgb(0x9a / 255, 0xa5 / 255, 0xb5 / 255);

const A4 = { width: 595.92, height: 841.92 };
const MARGIN = 52;

async function main() {
  const source = await PDFDocument.load(readFileSync(SOURCE));
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(source, source.getPageIndices());
  for (const p of pages) doc.addPage(p);

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);

  const page = doc.addPage([A4.width, A4.height]);
  page.drawRectangle({ x: 0, y: 0, width: A4.width, height: A4.height, color: NAVY });

  const contentW = A4.width - MARGIN * 2;
  let y = A4.height - 64;

  // An anchor token, painted in the colour of whatever it sits on.
  const anchor = (text, x, yy, color) =>
    page.drawText(text, { x, y: yy, size: 6, font: helv, color });

  // ---- Header ----
  page.drawText("AURIXA SYSTEMS PTY LTD", {
    x: MARGIN, y, size: 9, font: helvBold, color: CYAN,
  });
  y -= 30;
  page.drawText("Execution Schedule", {
    x: MARGIN, y, size: 30, font: serifBold, color: GOLD,
  });
  y -= 16;
  page.drawText(
    "Schedule to the Aurixa Systems Service Level Agreement. The details and signatures recorded",
    { x: MARGIN, y, size: 9.5, font: helv, color: BODY },
  );
  y -= 13;
  page.drawText(
    "below form part of the Agreement and bind both parties from the Commencement Date.",
    { x: MARGIN, y, size: 9.5, font: helv, color: BODY },
  );
  y -= 14;
  page.drawRectangle({ x: MARGIN, y, width: contentW, height: 1, color: GOLD });

  // ---- Client details panels ----
  y -= 30;
  page.drawText("1.  CLIENT AND ENGAGEMENT DETAILS", {
    x: MARGIN, y, size: 11, font: helvBold, color: GOLD_SOFT,
  });
  y -= 12;

  const fields = [
    { label: "Client name (authorised signatory)", token: ANCHORS.fieldClientName },
    { label: "Client organisation", token: ANCHORS.fieldClientOrg },
    { label: "Service tier", token: ANCHORS.fieldTier },
    { label: "Commencement date", token: ANCHORS.fieldCommencement },
  ];
  const panelH = 44;
  for (const f of fields) {
    y -= panelH + 10;
    page.drawRectangle({
      x: MARGIN, y, width: contentW, height: panelH, color: PANEL,
      borderColor: rgb(0x24 / 255, 0x30 / 255, 0x46 / 255), borderWidth: 0.75,
    });
    page.drawRectangle({ x: MARGIN, y, width: 3, height: panelH, color: GOLD });
    page.drawText(f.label.toUpperCase(), {
      x: MARGIN + 14, y: y + panelH - 15, size: 7.5, font: helvBold, color: MUTED,
    });
    // DocuSign prints the locked textTab value 2px above this token.
    anchor(f.token, MARGIN + 14, y + 10, PANEL);
  }

  // ---- Signature blocks ----
  y -= 40;
  page.drawText("2.  EXECUTED AS AN AGREEMENT", {
    x: MARGIN, y, size: 11, font: helvBold, color: GOLD_SOFT,
  });
  y -= 12;

  const colW = (contentW - 20) / 2;
  const blockH = 220;
  y -= blockH + 10;

  const signatureBlock = (x, title, subtitle, sigToken, nameToken, dateToken) => {
    page.drawRectangle({
      x, y, width: colW, height: blockH, color: PANEL,
      borderColor: rgb(0x24 / 255, 0x30 / 255, 0x46 / 255), borderWidth: 0.75,
    });
    page.drawRectangle({ x, y: y + blockH - 3, width: colW, height: 3, color: GOLD });
    let by = y + blockH - 24;
    page.drawText(title, { x: x + 14, y: by, size: 10.5, font: helvBold, color: BODY });
    by -= 13;
    page.drawText(subtitle, { x: x + 14, y: by, size: 8, font: helv, color: MUTED });

    // Signature line — DocuSign places the sign-here tag above the token.
    by -= 56;
    page.drawRectangle({ x: x + 14, y: by, width: colW - 28, height: 0.8, color: GOLD });
    anchor(sigToken, x + 14, by - 8, PANEL);
    by -= 20;
    page.drawText("Signature", { x: x + 14, y: by, size: 7.5, font: helv, color: MUTED });

    // Full name line.
    by -= 32;
    page.drawRectangle({ x: x + 14, y: by, width: colW - 28, height: 0.8, color: GOLD });
    anchor(nameToken, x + 14, by - 8, PANEL);
    by -= 12;
    page.drawText("Full name", { x: x + 14, y: by, size: 7.5, font: helv, color: MUTED });

    // Date line.
    by -= 32;
    page.drawRectangle({ x: x + 14, y: by, width: colW - 28, height: 0.8, color: GOLD });
    anchor(dateToken, x + 14, by - 8, PANEL);
    by -= 12;
    page.drawText("Date signed", { x: x + 14, y: by, size: 7.5, font: helv, color: MUTED });
  };

  signatureBlock(
    MARGIN,
    "Signed for the Client",
    "By its authorised signatory",
    ANCHORS.clientSig, ANCHORS.clientName, ANCHORS.clientDate,
  );
  signatureBlock(
    MARGIN + colW + 20,
    "Signed for Aurixa Systems Pty Ltd",
    "By its authorised signatory",
    ANCHORS.providerSig, ANCHORS.providerName, ANCHORS.providerDate,
  );

  // ---- Footer ----
  page.drawRectangle({ x: MARGIN, y: 58, width: contentW, height: 0.6, color: rgb(0x24 / 255, 0x30 / 255, 0x46 / 255) });
  page.drawText("AURIXA SYSTEMS PTY LTD  ·  SERVICE LEVEL AGREEMENT  ·  EXECUTION SCHEDULE", {
    x: MARGIN, y: 44, size: 7, font: helvBold, color: MUTED,
  });
  page.drawText("This schedule is completed and executed electronically via DocuSign.", {
    x: MARGIN, y: 33, size: 7, font: helv, color: MUTED,
  });

  mkdirSync(dirname(OUT), { recursive: true });
  const bytes = await doc.save();
  writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT} (${bytes.length} bytes, ${doc.getPageCount()} pages)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
