# Operator telephony — the softphone beside the AI fleet

Operators make and receive real phone calls from the browser at
`/voice/phone`, carried by **Twilio Voice**. This is the human half of the
voice operation: the AI fleet (VAPI) dials campaigns and answers reception;
the softphone is for the calls a person should take — and both land in the
CRM.

## Built now, connected later

The Twilio number is not purchased yet, and the whole feature treats that
as a first-class state. Every credential is a Worker env secret; nothing is
hard-coded and nothing pretends:

| Secret | What it is |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | The account (AC…) |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | API key pair that signs access tokens (SK…) |
| `TWILIO_AUTH_TOKEN` | Signs/validates webhook signatures |
| `TWILIO_TWIML_APP_SID` | The TwiML App answering browser-originated calls (AP…) |
| `TWILIO_CALLER_ID` | The purchased number, E.164 |

Until all six exist, `/voice/phone` reports "Twilio not configured" and
lists exactly what is missing; the webhook routes answer **503**. The
moment the secrets land, the same build is a working phone — no code
change.

**Twilio console wiring when the number arrives:**

1. Create an API key (Voice), a TwiML App, and buy the number.
2. TwiML App → Voice URL: `POST https://mission-control.aurixasystems.com.au/api/public/telephony/voice`
3. Number → Voice URL: `POST …/api/public/telephony/incoming`
4. (Optional per-call callbacks are already requested in TwiML: `…/api/public/telephony/status`)
5. Add the six secrets to the Worker env. Done.

## How a call flows

**Outbound** — the operator dials on `/voice/phone` (or clicks a contact).
The browser's registered `Twilio.Device` connects; Twilio asks the TwiML
App's Voice URL; `/api/public/telephony/voice` validates the signature,
ledgers the call, and answers `<Dial callerId=…><Number>` with status
callbacks on the far leg.

**Inbound** — a client dials the purchased number; Twilio asks
`/api/public/telephony/incoming`; the route ledgers the call and rings
every browser in `telephony_registrations` whose heartbeat is fresh
(3 minutes) and whose ringing is enabled — the incoming-call banner is
mounted at the app root, so it appears on any page. Nobody registered →
a spoken apology, and a `phone_missed_call` notification either way the
dial fails.

**Lifecycle** — `/api/public/telephony/status` folds every callback into
`phone_calls` (status is deliberately TEXT: Twilio's vocabulary is theirs
to extend). A completed call with a matched contact writes a
`crm_activities` row; an unanswered inbound call notifies operators.

## The pieces

- `src/server/telephony.server.ts` — token minting (a hand-rolled HS256
  JWT with the `twilio-fpa;v=1` content type: the Twilio Node SDK assumes
  Node crypto and this runs on a Worker), webhook signature validation
  (HMAC-SHA1 over canonical URL + sorted params, constant-time compare,
  refusals audited), TwiML builders, registrations, ledger ingestion.
- `src/lib/telephony.functions.ts` — operator server functions: status,
  token issue (upserts the registration), heartbeat, ring toggle, call
  list, notes, contact quick-search.
- `src/components/voice/softphone/` — `TelephonyProvider` (the Device
  lives at the app root; SDK loaded lazily; token self-refreshes;
  60-second heartbeat) and the global incoming banner / in-call dock.
- `src/routes/voice.phone.tsx` — the phone console: dialer + keypad,
  click-to-call contact search, live call panel with mute/DTMF, ring
  toggle and registration roster, recent-call ledger.
- `supabase/migrations/20260827120000_operator_telephony.sql` —
  `phone_calls`, `telephony_registrations`, RLS, indexes, triggers.
- `src/vendor/twilio-voice-sdk.min.js` — the SDK's self-contained browser
  bundle, vendored because the package's exports map only exposes an ESM
  build that imports Node's `events` (see `src/vendor/README.md`).

## Rules that carry it

- **The webhook fails closed.** No secrets → 503; wrong signature → 403
  plus an audit row. Signatures are computed against the canonical public
  origin, never a proxy-rewritten host.
- **Ringability is a heartbeat, not a setting.** A browser rings only
  while its registration is fresh; closing the laptop silences it without
  any cleanup job.
- **The ledger absorbs disorder.** Callbacks arrive out of order and for
  legs never seen; everything upserts by CallSid, and terminal statuses
  are the only ones that close a row.
- **The AI fleet and the softphone stay separate ledgers.** VAPI calls
  live in `voice_calls`, operator calls in `phone_calls` — different
  lifecycles, different vocabularies — but both write `crm_activities`,
  so the client timeline is one story.
