# Codex Security Autonomous Control Plane — Implementation Plan

Goal: an always-on security control plane inside Mission Control that scans the Prime repo and every clone via OpenAI Codex Security, drafts remediation PRs, gates merges through the existing role hierarchy, and fans fixes across the fleet using the cascade engine.

## Guiding principles

- **Durable queue over immortal process** — every scan is a row (`security_scan_jobs`) with status transitions; workers can die and resume.
- **Reuse existing rails** — GitHub App for repo access, cascade engine for fleet rollout, `security_findings`/`security_assessments` for storage, role hierarchy for approvals, `pg_cron` + `/api/public/hooks/*` for scheduling.
- **Codex Security = analysis; GitHub Actions = execution; Worker = orchestration.** No long-running work on Cloudflare.
- **Provider-neutral intake** — a `SecurityIntakeAdapter` interface so Codex today, other scanners / ticketing tomorrow.

## Phase map (executed one at a time, each ends with a working slice)

### Phase 0 — Controlled Codex Security pilot (Prime repo only)
- Add secrets: `CODEX_SECURITY_API_KEY`, `CODEX_SECURITY_WEBHOOK_SECRET`.
- Migration: `security_scan_jobs`, `security_scan_events`, extend `security_findings` with `scan_job_id`, `codex_finding_id`, `remediation_pr_url`, `auto_fix_confidence`.
- Server: `src/lib/codex-security.functions.ts` (`enqueueScan`, `getScanStatus`, `listScanFindings`), `src/server/codex-security-client.server.ts`.
- Route: `POST /api/public/hooks/codex-security` (HMAC verified) → writes findings, transitions job.
- UI: `/security/scans` (operator+) — list, trigger manual scan on Prime, view findings.
- Nightly `pg_cron` → `enqueueScan(prime)`.

### Phase 1 — Remediation PR workflow
- GitHub Actions workflow `codex-remediate.yml` (checked into Prime) invoked via `workflow_dispatch` from Mission Control with `finding_id`.
- Server fn `requestRemediation(findingId)` (admin only) → dispatches workflow with a signed payload; Codex opens a draft PR against a `codex/fix/<id>` branch.
- Webhook `/api/public/hooks/github-pr` updates `security_findings.remediation_pr_url`, `pr_state`.
- UI: finding drawer with "Draft fix", PR link, reviewer checklist.

### Phase 2 — Human review + merge gate
- Extend role hierarchy: `security_reviewer` capability (admin/super_admin auto-grant).
- Approval table `security_remediation_approvals` — two-key merge for `high` severity (reviewer + admin).
- Merge button calls GitHub API; on merge, mark finding `fix_merged`, kick revalidation scan scoped to touched paths.

### Phase 3 — Fleet cascade for security fixes
- New cascade template kind `security_patch` reusing `cascade_events`/`cascade_results`.
- After Prime merge → auto-create cascade targeting clones whose `clone_modules` intersect changed paths (path→module map already exists).
- Support deletions + migration-carrying patches (extend cascade executor to run `supabase migrations` before code push).
- UI: cascade row shows originating finding.

### Phase 4 — Perpetual scanning + scheduling
- Job kinds: `pr_open` (webhook from GitHub PR), `nightly_full`, `targeted_path`, `post_merge_revalidate`.
- Concurrency caps per repo (reuse GitHub concurrency pattern from Sprint 3).
- Backoff + dead-letter (`security_scan_jobs.failure_count`, `next_attempt_at`).
- Ops dashboard `/security/ops` — queue depth, success rate, MTTR.

### Phase 5 — Clone fleet scanning
- Extend enqueue to iterate `clones where isolated_tenant=false or handoff_state in (draft, dry_run_ready)`.
- Per-clone GitHub token resolution via existing GitHub App installation records.
- Findings tagged with `clone_id`; RLS: operators see Prime + assigned clones, admins see all.

### Phase 6 — Security Partner Portal integration
- Surface Codex findings in existing `/security/partners` portal so EC-Council reviewers can triage.
- Map Codex severity → `security_findings.severity`; allow partner to add comments (`security_assessment_comments`).
- Export signed report bundle to `security-reports` bucket on partner sign-off.

### Phase 7 — Provider-neutral intake + ticketing hooks ✅
- `SecurityIntakeAdapter` interface (`ingestFinding`, `updateStatus`, `linkExternalTicket`) in `src/server/security-intake/adapters.ts`.
- Concrete adapters: `CodexAdapter`, `ManualAdapter`, `GenericAdapter`, stub `TicketingAdapter`.
- Public API `POST /api/public/security/intake` with per-source HMAC (`x-intake-source` + `x-intake-signature`).
- Tables: `security_intake_sources` (rotatable HMAC secrets, admin-only) + `security_external_tickets` (linked to `codex_findings`, unique per source/provider/external_id).
- Admin server fns in `src/lib/security-intake.functions.ts`; management UI at `/security/intake`.

## Cross-cutting technical details

- **DB safety** — every new `public.*` table gets `GRANT` block + RLS scoped via `has_role`/`is_admin`; migrations idempotent.
- **Secrets** — Codex + webhook secrets via `add_secret`; never in code.
- **Worker constraints** — no child_process, no sharp. All heavy Git/scan work runs in Codex or Actions.
- **Observability** — every state transition writes `security_scan_events` (append-only) + `audit_log`.
- **Rollback** — feature flag `security.codex.enabled` in `prime_config`; disables enqueue + hides UI.

## Deliverables per phase

Each phase ends with: migration applied, server code + tests, UI slice, docs entry under `docs/codex-security/phase-N.md`, and a smoke run against Prime.

## Order of execution

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. I begin Phase 0 as soon as you approve this plan.
