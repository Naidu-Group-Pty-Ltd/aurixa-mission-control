# Changes made directly to the live Mission Control database

Applied on 2026-08-20 against the Lovable project `aurixa-mission-control`
(`0fb4d803-5071-4093-be25-5afbcf116476`), not through a deploy. Recorded here
because a change that exists only in a database and not in the repository is
the exact shape of drift this repository has already been bitten by twice.

Every one of them is now also expressed as a migration, so a rebuild from zero
reproduces the same end state.

## 1 · `prime_config.supabase_project_ref` = `dduzbchuswwbefdunfct`

The column was added and set by hand because the migration that introduces it
is still on an unmerged branch. Both statements are `IF NOT EXISTS` /
idempotent, so the migration re-applying later is a no-op.

`dduzbchuswwbefdunfct` is the **NPC Property Dashboard** Supabase project — the
prime product's backend, matching `prime_config.github_repo =
npc-property-dashbord`. See `PRIME_HAS_TWO_HALVES.md` for why this could not be
derived.

## 2 · `deployment-drain-1min` rescheduled

**This job had never once authenticated.** Its command was:

```
url     := 'https://aurixa-mission-control.lovable.app/hooks/deployment-drain'
headers := '{"Content-Type": "application/json", "Authorization": "Bearer "}'
```

An empty bearer, against the preview host rather than the production one.

Measured before the repair, from `net._http_response`:

| status | calls in 3h |
| --- | --- |
| 200 | 560 |
| **401** | **215** |
| 404 | 14 |

All 208 of the `{"error":"Unauthorized"}` bodies were this job. Measured after:
**0 × 401, 25 × 200** in the following six minutes.

`cron.job_run_details` reported every one of those runs as `succeeded`,
because queueing the HTTP call is the success it reports. The failure was only
visible in the response table — which is exactly the asymmetry
`cron_delivery_health()` exists to expose, and the reason `delivered` is the
column that matters.

### Why it was broken — three faults, one idea

1. **Wrong source.** It read `app.settings.cron_secret`. That GUC is unset here
   and always has been; every working job reads `vault.decrypted_secrets`. The
   hand-off notes recommended the GUC, and the migration followed the notes
   instead of the deployment.
2. **A missing secret became an empty one.** `COALESCE(..., '')` turned "no
   credential" into the literal header `Bearer `, which is a well-formed
   request the endpoint answers 401 — rather than a failure at schedule time.
3. **Baked at install time.** `format(%L)` froze the header into the job's
   command text. Setting the GUC afterwards would have changed nothing; the job
   would have kept sending the empty string for ever.

The corrected command builds the header **inside** the job body, so each run
reads the current vault value and a rotation needs no rescheduling.

## What this means for the deployment pipeline

The Vercel/Cloudflare work merged earlier could not have advanced a single
clone, whatever provider credentials were configured — the worker that drives
every state transition was being refused on every tick. That was not visible
from the code, from the job list, or from pg_cron's own reporting.

## Still not done, and not doable from here

- `app.settings.public_app_url` and `app.settings.cron_secret` remain unset.
  The first is now harmless (the migrations default to the production host);
  the second must never be set to a guess, because a wrong value would break
  the jobs that currently work. `CRON_SECRET` itself is not readable from here.
- `CREDENTIALS_ENC_KEY`, `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID`,
  `VERCEL_WEBHOOK_SECRET` and `CLOUDFLARE_API_TOKEN` are deployment
  environment variables, not database state.
