# Agreements — Service Level Agreements via DocuSign

Converted leads sign an Aurixa Systems Service Level Agreement. The operator
raises it at `/agreements` (usually against a CRM contact), sends it for
signature through DocuSign, and the lifecycle is tracked on the same page:
`draft → sent → delivered → signed / declined / voided`. A signed agreement's
PDF downloads straight from DocuSign; a signed or declined transition raises
an operator notification.

The flow mirrors the prime repo's `manage-agency-agreements` module — the
same JWT-grant auth, the same anchor-token envelope pattern — rebuilt for a
Cloudflare Worker with WebCrypto.

## Built now, connected later

Like the softphone, the feature is env-gated. Until the secrets exist,
`/agreements` says exactly what is missing; drafts can still be prepared and
nothing pretends to send.

| Secret | What it is |
| --- | --- |
| `DOCUSIGN_INTEGRATION_KEY` | The app's integration key (GUID) from the DocuSign console |
| `DOCUSIGN_USER_ID` | API User ID (GUID) of the impersonated user — Settings → Apps & Keys |
| `DOCUSIGN_RSA_PRIVATE_KEY` | RSA private key generated for the integration key (PKCS#1 is fine — it is converted; escaped `\n` is fine — it is normalised) |
| `DOCUSIGN_ACCOUNT_ID` | API Account ID (GUID) |
| `DOCUSIGN_BASE_URL` | *(optional)* REST base; defaults to `https://demo.docusign.net/restapi`. Production accounts use the base URI shown in Apps & Keys, e.g. `https://au.docusign.net/restapi` |
| `DOCUSIGN_OAUTH_HOST` | *(optional)* overrides the OAuth host; otherwise derived (demo → `account-d.docusign.com`, production → `account.docusign.com`) |
| `DOCUSIGN_COUNTERSIGNER_NAME` / `DOCUSIGN_COUNTERSIGNER_EMAIL` | *(optional)* an Aurixa signatory routed **second**, after the client signs. Omit both and the envelope is client-only |

## DocuSign console setup (one time)

1. **Create an app** (Settings → Apps & Keys → Add App and Integration Key).
   Record the Integration Key.
2. **Generate an RSA keypair** on the app and keep the private key — that is
   `DOCUSIGN_RSA_PRIVATE_KEY`.
3. Record the **API User ID** and **API Account ID** from the same page.
4. **Grant one-time consent** for impersonation. Open (demo shown; swap the
   host for production):

   ```
   https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<INTEGRATION_KEY>&redirect_uri=https://www.docusign.com
   ```

   sign in as the impersonated user and click **Accept**. Until consent is
   granted, sending fails with a message carrying this URL.
5. Add the secrets to the Worker env and redeploy. No code change.

Demo envelopes are watermarked and free; switching to production is a
secrets change (`DOCUSIGN_BASE_URL` + re-consent on the production host).

## The template

The document every client sees is `public/agreements/aurixa-sla-template.pdf`:
nine clause pages generated in Gamma on the Aurixa brand (deep navy, gold,
cyan — the aurixa-systems.com.au styling) plus an **Execution Schedule** page
appended by `scripts/agreements/build-sla-template.mjs`.

The execution page carries the machinery:

- **Visible**: labelled panels for client name, organisation, service tier
  and commencement date, and two signature blocks (Client / Aurixa Systems).
- **Invisible**: ~6pt anchor tokens (`\sig_client_1\`, `\field_service_tier\`, …)
  painted in the exact colour of the panel they sit on. DocuSign's text
  scanner finds them and places the tabs; humans never see them. The token
  strings are defined once in `ANCHORS`
  (`src/server/agreements.server.ts`) and a unit test asserts the build
  script carries every one verbatim.

When the agreement is sent, the client's details are stamped into those
panels as **locked text tabs** — the PDF itself is never regenerated per
client, so what was reviewed is what is signed.

### Regenerating the template

- Clause content or styling: regenerate the body in Gamma (theme **stratos**
  gave the current dark-navy look), export as PDF, replace
  `scripts/agreements/aurixa-sla-gamma-source.pdf`.
- Execution page layout: edit `scripts/agreements/build-sla-template.mjs`.
- Then:

  ```sh
  node scripts/agreements/build-sla-template.mjs
  ```

  which rewrites `public/agreements/aurixa-sla-template.pdf`. Keep the
  anchor tokens byte-identical to `ANCHORS` — the test fails if they drift.

## The pieces

- `src/server/agreements.server.ts` — the DocuSign engine: JWT-grant auth
  (RS256 via WebCrypto, PKCS#1 → PKCS#8 conversion for console-issued keys),
  envelope build (anchor tabs + locked field tabs, client first, optional
  countersigner second), status refresh with notifications, signed-PDF
  download, void.
- `src/lib/agreements.functions.ts` — operator server functions: config
  state, list/search, create (with CRM contact link), send, refresh,
  download, void, delete-draft.
- `src/routes/agreements.tsx` — the page: metrics, config banner, filters,
  lifecycle rows, the new-agreement dialog with CRM contact picker (shows
  journey stage), void dialog.
- `supabase/migrations/20260828010000_client_agreements.sql` —
  `client_agreements` (linked to `crm_contacts` / `crm_accounts`), RLS,
  indexes, `agreement_signed` / `agreement_declined` notification kinds.

## Rules that carry it

- **Status is TEXT, not an enum.** DocuSign's envelope vocabulary is theirs
  to extend; unknown statuses update `docusign_status` and leave the
  lifecycle untouched rather than guessing.
- **An envelope is sent once.** A row with `docusign_envelope_id` refuses a
  second send; a revision is a void plus a new agreement.
- **The record outlives the envelope.** Voided and declined agreements stay
  on the page — they are history on the client record, not clutter. Only
  never-sent drafts can be deleted.
- **The template is fetched from the deployed origin** and checked to be a
  PDF before it is sent anywhere — a missing asset fails loudly, not with an
  empty envelope.
