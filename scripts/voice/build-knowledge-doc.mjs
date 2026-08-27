#!/usr/bin/env node
// Builds the Aurixa Systems voice-agent knowledge base as a Word document.
//
// This script is the source of truth for the document attached to every MC
// voice assistant in VAPI (as a query-tool knowledge base). Edit here, run
// `node scripts/voice/build-knowledge-doc.mjs`, re-upload the file to VAPI
// and re-point the assistants' query tools at the new file id.
//
// Content rules: everything here is drawn from the company's own published
// copy (aurixasystems.com.au) and Mission Control's catalog. It states facts
// an agent may speak aloud; the system prompts still own tone and the
// never-claim rules (no approval, no allocation, no guaranteed access).
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { writeFileSync } from "node:fs";

const BULLET_NUMBERING = {
  config: [
    {
      reference: "kb-bullets",
      levels: [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: "•",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 360, hanging: 200 } } },
        },
      ],
    },
  ],
};

const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
const p = (text) => new Paragraph({ children: [new TextRun(text)] });
const b = (text) =>
  new Paragraph({
    numbering: { reference: "kb-bullets", level: 0 },
    children: [new TextRun(text)],
  });

const children = [
  new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun("Aurixa Systems — Voice Agent Knowledge Base")],
  }),
  p(
    "This document is reference material for Aurixa Systems voice agents. It contains the facts an agent may draw on when answering callers. It never overrides the agent's own instructions: an agent still never claims an application is approved, accepted or allocated, never promises platform access, never invents an appointment time, and never negotiates pricing.",
  ),

  h1("1. About Aurixa Systems"),
  p(
    "Aurixa Systems is an Australian company that builds governed AI operating systems for property, finance and advisory firms. The platform brings client intelligence, financial modelling, AI voice agents and compliance oversight together in one controlled, white-labelled platform, provisioned and managed for each client organisation.",
  ),
  p(
    "The company sign-off is: “Structured intelligence for confident property decisions.” The website is aurixasystems.com.au, and the team can be reached by email at admin@aurixasystems.com.au.",
  ),
  h2("Who the platform is for"),
  p(
    "Australian property, finance and advisory organisations, including: buyer's agencies, property advisory firms, real estate agencies, mortgage and finance brokerages, property developers, construction and building firms, accounting and SMSF advisories, conveyancing and legal services, property management, multi-service property groups, and technology or integration partners. Typical buyers are founders and directors, chief executives, operations leaders, technology or systems leads, and compliance or risk managers. Enterprise conversations suit franchise groups, networks, national or multi-entity organisations, and white-label partners.",
  ),

  h1("2. How access works — the priority access application"),
  p(
    "Access to Aurixa is by application, in three stages. Joining the waitlist does not guarantee platform access, and there is no paid queue priority: Aurixa does not accept payment to move an application up the list.",
  ),
  h2("Stage 1 — Priority Access Application"),
  b("Completed on the website at aurixasystems.com.au/contact. It takes about 60 to 90 seconds."),
  b(
    "It asks for name, work email, mobile number, organisation name, role, organisation type, approximate annual client or transaction volume, current bottlenecks, and the areas the organisation most wants to improve.",
  ),
  b(
    "On submission the applicant receives an application reference in the form AX- followed by ten characters, and an email titled “Application Received” containing a secure personal link to the Business Readiness Questionnaire.",
  ),
  h2("Stage 2 — Business Readiness Questionnaire"),
  b("Takes approximately 6 to 8 minutes. Progress is saved as the applicant goes."),
  b(
    "Reached through the secure link in the “Application Received” email. If the link has expired, the applicant's application reference together with their work email reopens the questionnaire on the website. Secure links should not be forwarded.",
  ),
  b(
    "It covers the organisation's structure, current systems and workflows, the Aurixa capabilities that matter most, integration and migration needs, security requirements, implementation timing and the most useful next step.",
  ),
  b(
    "Once the questionnaire is complete, the Aurixa team reviews the application, aiming to complete the initial review within two business days. No further submission is required in the meantime.",
  ),
  h2("Stage 3 — Strategic Review"),
  b(
    "A 30-minute private online session with the Aurixa team, booked from the link in the “Questionnaire Received” email within a 45-day booking window.",
  ),
  b(
    "Available times run Monday to Friday, 9:00 a.m. to 4:30 p.m. Sydney time, in 30-minute slots, with at least 24 hours' notice.",
  ),
  b(
    "A booking is a request: the Aurixa team confirms it by email, usually within one business day, and the calendar invitation with meeting access details follows separately from the team.",
  ),
  b(
    "In the session the team works through the questionnaire responses — the current operational environment, priority workflows, platform suitability and implementation considerations — and recommends the right Aurixa pathway: a platform discovery session, a guided demonstration, or an enterprise requirements consultation.",
  ),

  h1("3. What the platform does"),
  p(
    "Capabilities, in Aurixa's own vocabulary. Each is configured to the client organisation rather than deployed as a generic template.",
  ),
  b("CRM — client records, pipeline and activity in one place."),
  b("Client onboarding and workflow — structured onboarding journeys and task accountability."),
  b("Buyer's agency workflow — the end-to-end buying journey for buyer's agents."),
  b(
    "Client and partner portals — branded portals where clients and partners see their own information.",
  ),
  b("Finance portal — finance and broker coordination, handovers and finance messaging."),
  b("Borrowing capacity and serviceability modelling — lending matrix and capacity analysis."),
  b(
    "Ten-year cash-flow and portfolio analysis — long-range financial modelling and portfolio views.",
  ),
  b("Property comparison and due diligence — side-by-side analysis and research workflows."),
  b("Report generation — branded, data-driven client reports produced from live records."),
  b("Suburb and market reporting — market updates and location intelligence."),
  b("Template builder — document and report templates under the organisation's own brand."),
  b("AI communications — drafting and managing client communications with AI assistance."),
  b(
    "AI voice agents and call logging — inbound and outbound voice agents with full call records, transcripts and outcomes written back to the CRM.",
  ),
  b(
    "Calendar and task automation — bookings, reminders and downstream tasks triggered automatically.",
  ),
  b("AML and compliance — AML/CTF compliance workflow and oversight."),
  b("SMSF workflow — self-managed super fund advisory workflow."),
  b("Market intelligence — scheduled market intelligence reporting."),
  b(
    "API and integrations — connections to systems such as Microsoft 365, Google Workspace, Xero, MYOB, Cotality/CoreLogic, electronic signing and identity verification providers.",
  ),

  h1("4. Plans and pricing shape"),
  p(
    "Aurixa is sold as seat-banded plans plus optional add-on modules, prepaid AI credits, and a one-off onboarding package. All prices are in Australian dollars and include GST; nothing is added at checkout. The strategic review is where pricing is discussed properly for a specific organisation — agents state the shape and never negotiate or promise custom terms.",
  ),
  h2("Tiers"),
  b("Launch — A$699 per month, 1 to 4 seats, 7,000 report credits per month."),
  b("Growth — A$1,055 per month, 5 to 15 seats, 35,000 report credits per month."),
  b("Scale — A$2,210 per month, 16 to 30 seats, 75,000 report credits per month."),
  b(
    "Enterprise — scoped and quoted; for franchise groups, networks, national organisations and white-label partners. Multi-year arrangements are available.",
  ),
  b("Annual billing is available at 10% off, billed twelve months up front."),
  b(
    "Every tier's headline price includes the AML/CTF Compliance module; each tier also shows a lower price without it, the difference being that module's own price of A$195 per month.",
  ),
  b("Plan changes are pro-rated on the next billing cycle."),
  h2("Add-on modules"),
  p(
    "Each module is its own monthly subscription in AUD including GST and can be cancelled independently of the plan. The team enables a purchased module, usually within one business day. Examples: Market Updates A$59; Agreements A$69; Send Portfolio To Client A$69; Aurixa Intelligence Hub A$79; Client AI A$79; Generated Reports: Comparisons A$99; Cash Flow Comparisons A$99; Email Copilot A$99; Deal Pipeline A$99; Portfolio Analysis A$125; Integrations A$135; API Usage A$149; Commercial / Industrial A$169; Opportunity Marketplace A$169; Marketing A$179; AML/CTF Compliance A$195; Model Hub A$195; Call Logs A$225; Borrowing Capacity A$225; Finance Portal A$225; Aurixa Agent A$375. Some modules require the Growth or Scale tier.",
  ),
  h2("Credits"),
  b("Credits meter AI work such as report generation; the cost per report type is fixed."),
  b(
    "Credits expire 30 days from issue; unused credits roll over within that window, and the soonest-to-expire credits are spent first.",
  ),
  b("A failed generation costs nothing — credits are held during a run and released if it fails."),
  b(
    "One-off top-up packs range from 250 credits at A$20.90 to 15,000 credits at A$713.90; larger packs cost substantially less per credit.",
  ),
  h2("Onboarding packages"),
  b(
    "One-off onboarding packages: Launch Onboarding A$3,000; Professional Onboarding A$10,000; Growth Onboarding A$25,000; Enterprise Onboarding A$100,000.",
  ),
  b(
    "A dedicated specialist walks the team through configuration, brand setup, workflows and training; larger packages include data migration, integrations and white-label theming.",
  ),
  b(
    "The first onboarding step is a kickoff call with the specialist, followed by backend provisioning, domain and branding setup, module enablement, seats, billing, training and go-live confirmation.",
  ),
  h2("Trials"),
  p(
    "There is no self-serve free trial. A sandbox environment with sample data can be arranged through the contact page.",
  ),

  h1("5. Security and governance"),
  b("Single sign-on, multi-factor authentication, role-based access control and audit logs."),
  b("Australian data residency and isolated tenancy per organisation."),
  b(
    "Client data is not scraped, aggregated or repurposed for training internal machine-learning models.",
  ),
  b(
    "Enterprise requirements such as penetration testing, service-level agreements, vendor-risk assessment and dedicated environments are handled through the enterprise requirements consultation.",
  ),

  h1("6. Support for existing customers"),
  b(
    "The support page at aurixasystems.com.au/support is the fastest path: an assistant answers how-do-I questions against the platform user guide, and anything else becomes a ticket.",
  ),
  b(
    "Tickets go straight to Aurixa Mission Control and are classified by severity from P0 to P3. Eligible issues are queued for automatic remediation; urgent incidents go straight to an engineer. Updates are emailed, and the ticket reference should be quoted in any follow-up.",
  ),
  b(
    "Outages, security concerns, data loss and billing disputes are always escalated to a person — an agent should collect the details and never troubleshoot such incidents on the call.",
  ),

  h1("7. Quick answers"),
  b(
    "Where do I apply? — aurixasystems.com.au/contact; the application takes about 60 to 90 seconds.",
  ),
  b(
    "My questionnaire link expired. — The application reference (AX-…) plus the work email reopens it on the website; links are time-limited for the applicant's protection.",
  ),
  b(
    "I applied with the wrong email. — Email admin@aurixasystems.com.au and the team will correct it against the application reference.",
  ),
  b(
    "How long until I hear back? — The team aims to complete the initial review within two business days of the questionnaire being completed.",
  ),
  b(
    "When can the review be booked? — Monday to Friday, 9:00 a.m. to 4:30 p.m. Sydney time, at least 24 hours ahead, within a 45-day window; a separate confirmation email and calendar invitation follow from the team.",
  ),
  b("Can I pay to skip the queue? — No. Aurixa does not accept payment for queue priority."),
  b(
    "Is a booking final once made on a call? — It is a request in the calendar; the Aurixa team confirms by email, usually within one business day.",
  ),
  b(
    "Can modules be cancelled? — Yes, each add-on module is billed as its own monthly subscription and can be cancelled independently of the plan.",
  ),
  b(
    "Is the platform white-labelled? — Yes; the platform is delivered under the client organisation's own brand.",
  ),
  b(
    "Confidential documents on calls or forms? — Please do not share client identification documents, financial records or confidential client information on a call or in an application.",
  ),
];

const doc = new Document({
  numbering: BULLET_NUMBERING,
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
    },
  },
  sections: [{ children }],
});

const buffer = await Packer.toBuffer(doc);
const out = process.argv[2] ?? "aurixa-voice-knowledge-base.docx";
writeFileSync(out, buffer);
console.log(`wrote ${out} (${buffer.length} bytes)`);
