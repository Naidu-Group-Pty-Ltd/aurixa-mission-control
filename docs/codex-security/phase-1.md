# Phase 1 — Autonomous Remediation PR Workflow

## Scope
Mission Control can now request a **draft fix PR** for any Codex Security
finding. A `workflow_dispatch` fires against the target repo's
`.github/workflows/codex-remediation.yml`, which asks Codex for a patch,
pushes a branch, opens a draft PR, and posts each lifecycle event back
to `/api/public/hooks/codex-remediation` (HMAC-signed with
`CODEX_REMEDIATION_WEBHOOK_SECRET`).

## Artifacts
- **DB**: `codex_remediations` (see migration
  `20260727…_codex_remediations.sql`) plus `codex_remediation_status`
  enum. Admin-only writes, operator+ reads. Findings state auto-advances
  via the callback:
  - `pr.opened` / `pr.updated` → `pr_open`
  - `pr.merged` → `fix_merged` (+ `resolved_at`)
  - `pr.closed` (no merge) → `fix_drafted`
- **Server**: `src/server/codex-remediation.server.ts`
  - `dispatchRemediationWorkflow` — Octokit `POST /actions/workflows/{file}/dispatches`
    using the installation cached in `github-app.server.ts`. Immediately
    polls `GET /actions/workflows/{file}/runs` to record the run id/url.
  - `verifyRemediationSignature` — same HMAC-SHA256 shape as the Codex
    webhook (`sha256=<hex>` or bare hex).
- **Server fns**: `src/lib/codex-remediation.functions.ts`
  - `draftRemediationPR({ findingId, baseRef? })` — admin-only, resolves
    owner/repo/installation from `prime_config` or `clones`, generates a
    deterministic branch (`codex/fix-<sev>-<slug>-<idprefix>`), inserts
    the row, then fire-and-forget dispatches. De-duplicates in-flight
    remediations for the same finding.
  - `listRemediations({ jobId?, findingId? })` — operator+ read.
- **Webhook**: `src/routes/api.public.hooks.codex-remediation.ts` —
  validates HMAC, updates status/PR fields, mirrors finding state,
  appends a `codex_scan_events` audit row.
- **UI**: `src/routes/security.scans.tsx` scan-detail sheet gains a
  **Draft Fix PR** action per finding plus a live PR link, run link, and
  status badge. Toast + optimistic refetch after dispatch.
- **Workflow template**: `.github/workflows/codex-remediation.yml`
  committed at the repo root. It uses `secrets.CODEX_SECURITY_API_KEY`
  for the patch call and `secrets.GITHUB_TOKEN` (default) to push /
  open the draft PR.

## Secrets required
- `CODEX_SECURITY_API_KEY` — Mission Control **and** each remediation
  repo need this. Add it as a repo/org Actions secret.
- `CODEX_REMEDIATION_WEBHOOK_SECRET` — auto-generated in Mission Control
  (project secret). Passed through the workflow input `callback_secret`;
  the workflow never persists it.

## Operator flow
1. Scan completes and findings appear in the scan-detail sheet.
2. Admin clicks **Draft Fix PR** on a finding.
3. Mission Control inserts a `codex_remediations` row, dispatches the
   workflow, and records the run URL.
4. Workflow authors the patch, opens the draft PR, and reports back.
5. Finding row shows the PR link and state; Phase 2 will add human
   review + two-key merge gating.

## What Phase 1 intentionally does NOT do
- No auto-merge. All PRs are draft; humans review and mark ready.
- No fleet cascade — the workflow only affects the finding's repo.
  Phase 3 wires cascades.
- No perpetual scheduler; Phase 4 covers nightly + PR-open scans.

> **Partly superseded.** The database schema, callback contract, review
> gating, and UI described here are current. The patch-generation step no
> longer calls a hosted API — `codex-remediation.yml` now drives the Codex
> CLI directly. See [`live-architecture.md`](./live-architecture.md).
