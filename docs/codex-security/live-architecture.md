# Codex Security — live architecture

Phases 0–6 built the whole pipeline (schema, UI, remediation PRs, partner
bridge, intake adapters) around a scan API that does not exist. This
document describes what actually executes today, and how to verify it.

## Why nothing was running

| # | Fault | Effect |
|---|-------|--------|
| 1 | `codex-security-client.server.ts` POSTed to `https://api.openai.com/v1/security/scans` — an endpoint OpenAI has never shipped | Every enqueue threw; jobs flipped straight to `failed`. |
| 2 | Dispatch ran in a floating `(async () => {…})()` that nothing awaited | On Cloudflare Workers the isolate is reclaimed once the response is written, so jobs were stranded at `queued` with no event row and no error. |
| 3 | `clones.repo_full_name` and `clones.github_app_installation_id` did not exist | Every select naming them returned a PostgREST error, silently disabling clone scans, clone remediations, and the Actions secret sync. |
| 4 | Code read `APP_PUBLIC_URL`; `.env.example` documented `PUBLIC_APP_URL` | Callback URLs silently fell back to a hardcoded host. |
| 5 | The intake adapter inserted `scan_job_id: NULL` into a `NOT NULL` column | Every non-webhook intake write failed. |
| 6 | No sweeper, despite `failure_count` / `next_attempt_at` existing | One lost dispatch stranded a job, and the dedup window then suppressed every later scan of that target. |
| 7 | `codex-remediation.yml` called `…/v1/security/remediations` | Draft-fix PRs could never be produced. |

## What runs now

```
 Mission Control                         Target repo (Prime or clone)
 ───────────────                         ────────────────────────────
 enqueueScanNoAuth
   ├── insert codex_scan_jobs (queued)
   └── dispatchCodexScan ──────────────► workflow_dispatch
        (GitHub App, awaited)             codex-security-scan.yml
                                            ├── gitleaks      (secrets)
                                            ├── semgrep       (SAST)
                                            ├── osv-scanner   (deps)
                                            └── codex exec    (reasoning)
                                                    │
 /api/public/hooks/codex-security ◄──────────────────┘
   ├── HMAC verify                        scan.started / progress /
   ├── carry forward triage verdicts      completed / failed
   ├── flag regressions
   ├── auto-resolve fixed findings
   └── recount summary
```

### Engines

`CODEX_SECURITY_ENGINE` selects the executor:

- **`github_actions` (default)** — dispatches `.github/workflows/codex-security-scan.yml`
  in the target repo through the Aurixa GitHub App. Needs no key beyond the
  existing `GITHUB_APP_*` configuration.
- **`http`** — the original vendor-API passthrough, retained behind the flag
  so a real hosted scan API can be adopted later without touching a caller.

`workflow_dispatch` only accepts a branch or tag as its ref, so PR scans
dispatch on the repo's default branch and pass the head SHA through as the
`scan_ref` input.

### Scanners

| Scanner | Finds | Severity source | Auto-fix confidence |
|---|---|---|---|
| gitleaks | committed credentials | always `critical` | 0.35 |
| semgrep (`p/security-audit`, `p/secrets`, `p/owasp-top-ten`) | injection, authz, unsafe APIs | rule impact/likelihood, else ERROR/WARNING/INFO | 0.8 with autofix, else 0.4 |
| osv-scanner | vulnerable dependencies | CVSS score | 0.9 when a fixed version exists |
| Codex CLI (optional) | logic-level flaws rules can't express | model-assigned, clamped to the enum | model confidence, default 0.5 |

Each scanner step is `continue-on-error` — one broken scanner degrades the
scan instead of failing it, and `result_summary.scanners` records which ones
actually ran.

### Fingerprints and cross-run state

Every finding gets a stable `fingerprint` (`sha256(scanner, rule, file,
line)`), which is what makes repeated scans useful rather than noisy:

- `dismissed` / `false_positive` verdicts survive re-scans.
- A `resolved` finding that reappears is reopened and logged as
  `regression_detected`.
- After a **full-tree** scan completes, findings the previous full-tree scan
  reported that this one does not are set to `resolved`.
  `pr_open` and `targeted_path` scans never auto-resolve — they see only a
  slice of the tree, so absence proves nothing. (See
  `src/lib/codex-finding-state.ts`, unit tested.)

### Scheduling

| Trigger | Route | Scope |
|---|---|---|
| pg_cron `0 7 * * *` | `POST /hooks/codex-nightly` | Prime + every clone with `codex_nightly_enabled` |
| pg_cron `*/10 * * * *` | `POST /hooks/codex-sweep` | Re-dispatch stranded jobs, retire hung runs |
| GitHub `pull_request` | `POST /hooks/github` | PR head SHA, scoped to the diff vs the base ref |
| GitHub `push` to default branch | `POST /hooks/github` | Post-merge revalidation of Prime |
| Operator | `/security/scans` | Prime, a single clone, or the whole fleet |

Both cron endpoints authenticate with `CRON_SECRET` as a Bearer token.

The sweeper re-dispatches a `queued` job that has sat undispatched for 10
minutes, backing off 5/10/15 minutes across at most 3 attempts, then fails
it. A `running` job with no terminal callback after 75 minutes (the workflow
itself times out at 45) is failed as `scan_timeout`.

## Secrets

| Name | Required | Notes |
|---|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | yes | Installation needs **Actions: read & write** and **Secrets: read & write**. |
| `CRON_SECRET` | yes | Mirror into Postgres: `ALTER DATABASE postgres SET app.settings.cron_secret = '…';` |
| `PUBLIC_APP_URL` (or `APP_PUBLIC_URL`) | recommended | Origin the scanner posts results back to. |
| `CODEX_SECURITY_WEBHOOK_SECRET` | optional | Falls back to the auto-generated secret on the built-in `codex` row of `security_intake_sources`, so a fresh deployment works unprovisioned. |
| `CODEX_REMEDIATION_WEBHOOK_SECRET` | optional | Falls back to the scan secret. |
| `OPENAI_API_KEY` | optional for scans, **required for remediation** | Synced into each managed repo as an Actions secret. Without it, scans still run gitleaks/semgrep/osv-scanner; remediation cannot author patches. |

## Bringing it up

1. Apply `supabase/migrations/20260727140000_codex_security_engine_live.sql`.
2. Copy `.github/workflows/codex-security-scan.yml` and
   `.github/workflows/codex-remediation.yml` into Prime and every clone
   (clone provisioning pushes the secrets automatically; the workflow files
   travel with the repo template).
3. Open **/security/scans** and read the **Engine health** card. Every
   blocking misconfiguration is listed there with its exact fix — missing
   secret, missing App permission, missing workflow file, dead cron.
4. Click **Scan Prime Now** and watch the job go
   `queued → running → completed` with findings attached.

## Verifying without waiting for cron

```bash
# nightly fan-out
curl -X POST https://<mission-control>/hooks/codex-nightly \
  -H "Authorization: Bearer $CRON_SECRET"

# sweeper
curl -X POST https://<mission-control>/hooks/codex-sweep \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Performance notes

- Fleet overview moved from "fetch 500 jobs + every open finding, group in
  JS on each 30s poll" to the `codex_fleet_overview()` RPC, which does the
  `DISTINCT ON` and severity roll-up against partial indexes.
- Nightly fan-out dispatches 5 clones concurrently instead of serially.
- The partner bridge went from 3 queries per finding to one lookup plus two
  batched writes.
- PR scans are diff-scoped, so they cost seconds rather than minutes and
  only report what the PR actually introduced.
