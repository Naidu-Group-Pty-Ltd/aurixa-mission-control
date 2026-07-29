# Aurixa CRM — Full Client Lifecycle Control Plane

Extends the existing waitlist lead capture into an end-to-end system covering: lead → qualified opportunity → onboarded client → live account (payments, support, feedback, disputes) → renewal or exit (offboarding + data migration).

## Lifecycle model

```text
LEAD            OPPORTUNITY        CLIENT (active)                 EXIT
capture    →    qualify/quote  →   onboard → operate → renew   →   offboard
waitlist        deal pipeline      account + contract              churn record
_leads          stages/value       payments · tickets · feedback   data export
                                   disputes · health score         migration pack
```

Everything hangs off a single spine: **`crm_accounts`** (the client organisation), linked to the existing `clones`, `tenants`, `purchases`, `invoices`, `feedback_submissions` and `handoffs` tables so the CRM reads real billing/product truth instead of duplicating it.

## Phase 1 — CRM spine and lead promotion

New tables (all with GRANTs + RLS scoped to operator/admin roles via `is_operator`/`is_admin`):

- `crm_accounts` — organisation record: name, classification, lifecycle_stage (`lead`, `opportunity`, `onboarding`, `active`, `at_risk`, `churned`), owner (assigned operator), source, links to `clone_id` / `tenant_id`, health score, ARR, tags.
- `crm_contacts` — people at an account: name, email, phone, role, is_primary, marketing consent.
- `crm_activities` — universal timeline: calls, emails, notes, meetings, system events. Every other module writes here so one account page shows the whole story.
- `crm_tasks` — follow-ups with due date, assignee, status, reminder → notifications.

Lead promotion: a "Convert lead" action on `/leads` creates the account + primary contact, copies the lead payload, links `waitlist_leads.account_id`, and stamps `converted` status. Airtable-mirrored historical leads promote the same way.

## Phase 2 — Deal pipeline (pre-contract)

- `crm_deals` — opportunity per account: stage (`discovery`, `demo`, `proposal`, `contract`, `won`, `lost`), tier being sold (Launch/Growth/Scale), add-on modules, seat count, expected MRR, close date, lost reason.
- `crm_deal_line_items` — resolved from the live pricing catalog (`seat_plans`, `addon_modules`, `setup_packages`) so quotes always match Stripe prices.
- Quote → checkout: a "Send pricing link" action mints a storefront access grant scoped to the deal, and the resulting Stripe purchase auto-advances the deal to `won` via the existing webhook, creating the contract.
- Kanban board UI with drag-between-stages, weighted forecast, and stage-age warnings.

## Phase 3 — Contracts, onboarding, payments

- `crm_contracts` — term start/end, billing cadence, tier, committed seats, auto-renew flag, notice period, cancellation terms version (reuses `handoff_terms_versions`), signed-by/at.
- `crm_onboarding_tasks` — templated checklist auto-created when a deal is won (backend provisioned, domain mapped, brand cascade applied, seats issued, training done). Ties directly to existing clone provisioning status so items tick themselves.
- **Payments view** per account, read from live data — no duplication: Stripe purchases, invoices, payment methods, token ledger and seat entitlements aggregated into one panel with outstanding balance, failed-payment flags and dunning state.
- Payment failure / card expiry raises an activity + task + notification and can flip the account to `at_risk`.

## Phase 4 — Support, issues and disputes

- `crm_tickets` — issue tracking: type (`support`, `bug`, `billing`, `feature`), severity, status (`open`, `in_progress`, `waiting_client`, `resolved`, `closed`), SLA due-at, assignee, resolution notes. Links optionally to a `codex_findings` or `route_errors` record so platform incidents attach to affected clients.
- `crm_ticket_messages` — threaded correspondence with internal-note flag.
- `crm_disputes` — formal escalations: chargebacks (auto-created from Stripe `charge.dispute.created`), service credits, contractual disagreements. Fields: amount, opened/closed dates, outcome, evidence links, resolution owner. Dispute open → account flagged and blocked from auto-renew until resolved.
- SLA breach sweep on the existing cron hook raises notifications.

## Phase 5 — Feedback, health and retention

- Surfaces existing `feedback_submissions` (NPS, module ratings) on the account timeline, and adds `crm_feedback_requests` for operator-triggered survey sends with response tracking.
- **Health score** (materialised nightly): usage/token burn trend, seat utilisation, ticket volume and severity, payment reliability, NPS, days since last contact. Drives an `at_risk` watchlist.
- Renewal engine: contracts approaching term end generate renewal tasks, notice-period alerts, and a renewal deal in the pipeline.

## Phase 6 — Exit, offboarding and data migration

- `crm_churn_events` — cancellation request date, effective date, reason taxonomy (price, missing capability, switched provider, internal build, non-payment), competitor named, save-attempt outcome, refund/credit issued, final invoice link.
- `crm_offboarding_runs` — a governed wind-down checklist per exit: notice acknowledged, final invoice settled, seats revoked, API keys revoked, subscription cancelled in Stripe, access grants expired.
- **Data migration / portability**: reuses the existing handoff machinery. Two paths:
  - *Ownership transfer* — the client keeps the deployment; run the existing Supabase backend handoff (contracts, parity report, secret rotation, storage replication, audit shipper).
  - *Export and terminate* — generate a portable data pack (per-tenant DB export manifest, storage assets, brand config, report archive), record checksums and delivery, then schedule destruction after a retention window.
- Retention & deletion clock: `data_retention_until` on the churn record, with a cron sweep that prompts before purge, and a full audit trail of who exported/deleted what.
- Re-activation: churned accounts stay queryable and can be reopened into a new deal, preserving history.

## UI surface

New `/crm` section in the sidebar:
- `/crm` — pipeline overview: funnel, forecast, at-risk list, overdue tasks, SLA breaches.
- `/crm/accounts` — filterable list with lifecycle, owner, ARR, health.
- `/crm/accounts/$accountId` — the hub: header with health/ARR/stage, tabs for Timeline, Contacts, Deals, Contract, Payments, Tickets, Disputes, Feedback, Offboarding.
- `/crm/deals` — kanban board.
- `/crm/tickets` — queue with SLA countdown.
- `/leads` — gains a "Convert to account" action and shows already-converted links.

## Technical notes

- All schema lands as migrations with explicit `GRANT`s, RLS gated by the existing role hierarchy (operator read/write, admin full, `high_king` unrestricted), and `updated_at` triggers.
- Server logic via `createServerFn` in `src/lib/crm*.functions.ts` with `requireSupabaseAuth`; heavy/privileged work behind role checks in `src/server/crm/*.server.ts`.
- No duplication of billing state: payments, invoices, tokens and seats are read from existing tables; the CRM stores only relationship data.
- Automation hooks piggyback on existing crons (`hooks.*`) for SLA sweeps, health scoring, renewal alerts and retention purges.
- Stripe webhook gains handlers for `charge.dispute.*` and `customer.subscription.deleted` to feed disputes and churn automatically.
- Existing notification + realtime pipeline reused so assignments, SLA breaches and churn signals reach operators live.

## Suggested build order

1. Phase 1 spine + lead promotion + account hub shell (immediately useful).
2. Phase 2 pipeline + Phase 3 contracts/onboarding/payments view.
3. Phase 4 tickets/disputes.
4. Phase 5 health/renewals, Phase 6 exit and migration.
