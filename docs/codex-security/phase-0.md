# Phase 0 — Controlled Codex Security Pilot

## What shipped
- Migration `codex_scan_jobs`, `codex_scan_events`, `codex_findings` (+ enums, RLS, GRANTs).
- Server client `src/server/codex-security-client.server.ts` (enqueue, status, HMAC verify).
- Server fns `src/lib/codex-security.functions.ts`: `enqueueScan`, `listScanJobs`, `getScanDetail`.
- Public webhook route `POST /api/public/hooks/codex-security` (HMAC verified, upserts findings).
- Operator UI `/security/scans` with manual "Scan Prime Now" trigger and live-polling detail sheet.

## Secrets
- `CODEX_SECURITY_API_KEY` — user-provided.
- `CODEX_SECURITY_WEBHOOK_SECRET` — auto-generated.
- Optional: `CODEX_SECURITY_BASE_URL` (defaults to `https://api.openai.com/v1/security`).
- Optional: `APP_PUBLIC_URL` (defaults to `https://mission-control.aurixasystems.com.au`).

## Next
Phase 1 wires GitHub Actions `workflow_dispatch` to open a draft remediation PR per finding.

> **Superseded.** The Codex Security HTTP API described here was never
> shipped by OpenAI, so this design could not execute. See
> [`live-architecture.md`](./live-architecture.md) for the pipeline that
> actually runs.
