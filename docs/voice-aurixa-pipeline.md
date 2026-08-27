# The Aurixa voice pipeline — agents tailored to our own funnel

The first fleet spoke NPC's property-consulting script (discovery calls with a
consultant, strategy sessions, finance consults). Aurixa Systems is a B2B SaaS
provider, and its funnel is already precisely defined — by the website's
priority-access flow, the waitlist emails, and Mission Control's own CRM
machinery. This document is the plan the fleet is built against.

## The lifecycle the agents serve

```
S1 Applied ──▶ S2 BRQ complete ──▶ S3 Review booked ──▶ Strategic review
 (AX-… ref)     (questionnaire)      (30 min, manual        (human session)
     │                │               calendar invite)           │
     ▼                ▼                    ▼                     ▼
 [call: get the  [call: get the     [call: confirm +      pathway: discovery
  BRQ done]       review booked]     remind, rescue        session / guided demo /
                                     no-shows]             enterprise consultation
                                                                 │
                              deal ladder: discovery → demo → proposal
                                     → contract (fit gate) → won
                                                                 │
                                                    onboarding (10 steps,
                                                    step 1 = kickoff call)
                                                    [call: schedule kickoff]
                                                                 │
                                                     active ⇄ at_risk
                                                     [call: check-in, disabled
                                                      until switched on]
```

Facts the scripts must respect (all from the site's own copy):

- The BRQ takes **6–8 minutes**, reached by the secure link in the
  "Application Received" email, fallback is the applicant's **AX-… reference**
  plus work email. Review completes **within two business days** of the BRQ.
- The strategic review is **30 minutes, online**, booked within a **45-day
  window**; slots are Mon–Fri **9:00 a.m.–4:30 p.m. Sydney** with **24 hours'
  minimum notice**. A booking is _requested_; **the Aurixa team confirms by
  email, usually within one business day**, and the calendar invitation
  follows separately — an agent never claims a booking is confirmed beyond
  that.
- **Never claim approval, acceptance, allocation, guaranteed access or instant
  provisioning.** Joining the waitlist does not guarantee platform access.
- Register: the _transactional_ voice — measured Australian English
  ("organisation", "work email"), not the marketing hero voice. Sign-off idea:
  "Structured intelligence for confident property decisions."
- Vocabulary: priority access application · Business Readiness Questionnaire ·
  readiness profile · strategic review · Aurixa pathway · application
  reference · platform discovery session / guided demonstration / enterprise
  requirements consultation · Launch / Growth / Scale / Enterprise · modules ·
  credits · onboarding package.
- Pricing posture on a call: tiers exist (Launch/Growth/Scale from A$699 to
  A$2,210 a month, Enterprise scoped and quoted; onboarding packages from
  A$3,000), but the right price conversation is the strategic review — an
  agent may state the shape, never negotiate or promise.

## Journey stages (crm_journey_stages reseed)

| key              | name                      | drives                                                   |
| ---------------- | ------------------------- | -------------------------------------------------------- |
| `applied`        | Stage 1 — Applied         | entering it queues the **questionnaire follow-up** call  |
| `questionnaire`  | Stage 2 — BRQ in progress | parking stage while the BRQ is open                      |
| `review_pending` | Stage 3 — Review to book  | entering it queues the **review booking follow-up** call |
| `review_booked`  | Strategic review booked   | set automatically when a strategic review is booked      |
| `pathway`        | Pathway recommended       | post-session; deal ladder in flight                      |
| `onboarding`     | Onboarding                | entering it queues the **kickoff scheduler** call        |
| `live`           | Live customer (terminal)  |                                                          |
| `closed_lost`    | Closed — lost (terminal)  |                                                          |

The NPC stages are deactivated, not deleted (journeys keep FK integrity).

## Appointment kinds (added)

`strategic_review`, `discovery_session`, `guided_demo`,
`enterprise_consultation`, `kickoff`. Booking a `strategic_review` advances
the journey to `review_booked` and queues the confirmation call plus the
reminder; the three pathway sessions advance to `pathway`; a `kickoff`
advances to `onboarding`. The NPC kinds remain in the enum but are no longer
offered.

## Campaign triggers (added; NPC rules disabled)

| trigger                    | fires when                      | dials                                  | agent                       |
| -------------------------- | ------------------------------- | -------------------------------------- | --------------------------- |
| `questionnaire_follow_up`  | journey enters `applied`        | +4 h (cancelled if the stage moved on) | MC Questionnaire Follow Up  |
| `review_booking_follow_up` | journey enters `review_pending` | +4 h (stage-guarded)                   | MC Review Booking Follow Up |
| `review_confirmation`      | strategic review booked         | +2 min                                 | MC Review Confirmation      |
| `session_reminder`         | any session booked              | session −2 h                           | MC Session Reminder         |
| `session_no_show`          | session marked no-show          | +10 min                                | MC Session No-Show          |
| `kickoff_scheduler`        | journey enters `onboarding`     | +1 h                                   | MC Kickoff Scheduler        |
| `checkin_at_risk`          | manual (seeded **disabled**)    | +1 min                                 | MC Account Check-In         |
| `nurture`                  | operator signal                 | +2 min                                 | MC Nurture                  |

Quiet hours move to business hours: **Mon–Fri 9:00–17:30 Sydney**. Chaser
jobs carry `only_in_stage` metadata: the dispatcher cancels a job whose
journey has already moved past the stage that queued it — a lead who finished
the BRQ before the +4 h chaser fires is never called about it.

## The fleet (the 12 MC assistants, retargeted)

Inbound — **MC Reception Squad**:

1. **MC Front Desk** — answers "what is Aurixa" (governed AI operating
   systems for Australian property, finance and advisory firms), explains the
   priority-access process, qualifies (organisation type, volume, role),
   routes: booking questions → MC Review Booking; platform/capability
   questions → MC Solutions Advisor; support → MC Support Intake.
2. **MC Review Booking** — books the strategic review (and the pathway
   sessions) against the real calendar.
3. **MC Solutions Advisor** — speaks the capability vocabulary (CRM,
   onboarding and workflow, client and partner portals, finance portal,
   report generation, AI voice agents and call logging, AML and compliance…),
   states the tier shape without negotiating, lands on booking a review.
4. **MC Support Intake** — collects a structured description for existing
   customers, points at the support portal, promises the P0–P3 triage that
   the site itself promises, takes a callback commitment.

Outbound: 5. **MC Questionnaire Follow Up** — S1 chaser: get the 6–8 minute BRQ done. 6. **MC Review Booking Follow Up** — S2 chaser: book the 30-minute review on
the call. 7. **MC Review Confirmation** — after a booking: confirm details, flag that
the calendar invite follows from the team, verify the email address. 8. **MC Session Reminder** — 2 hours before any session; rebook if needed. 9. **MC Session No-Show** — zero-guilt rebook after a missed session. 10. **MC Kickoff Scheduler** — after a won deal: welcome, schedule the
onboarding kickoff call (step 1 of the 10-step checklist). 11. **MC Nurture** — re-engagement of stalled applications. 12. **MC Account Check-In** — retention call for at-risk accounts (rule
seeded disabled until retention calling is a deliberate decision).

All twelve are updates to the existing MC fleet on the Aurixa VAPI account —
same assistant ids, new names, prompts and tools; the pre-existing NPC
assistants stay untouched.

## Booking window change

`voice-tools.server.ts` moves from the NPC window to the strategic-review
rules: Mon–Fri **9:00–16:30 Sydney**, 30-minute slots, **minimum 24 hours'
notice**, bookable **45 days** ahead. One host calendar; any booked
appointment blocks all kinds.
