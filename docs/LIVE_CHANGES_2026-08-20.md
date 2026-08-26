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

| status  | calls in 3h |
| ------- | ----------- |
| 200     | 560         |
| **401** | **215**     |
| 404     | 14          |

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

---

# 26 Aug 2026 — the six workers that had never been scheduled

Applied to Mission Control's live database (`0fb4d803-…`) through the Lovable
MCP, and expressed as `20260826000000_schedule_the_engine.sql` so a rebuild
reproduces it. **Three of the six landed in that first pass and three did not** —
the correction and the delivery evidence are the section below, which is the
authority on what is actually scheduled. Full analysis: [`THE_CLONING_ENGINE.md`](./THE_CLONING_ENGINE.md).

`cron.job` held **16** hook jobs; twenty-two are required. Six had never been
created, because each of their migrations reads `vault.decrypted_secrets` into
a variable and `RETURN`s when it is absent — and the vault was empty when they
ran. Two of the six are the cloning engine.

| Job                               | Cadence        | Endpoint                            | Why it matters                                                      |
| --------------------------------- | -------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `backend-provisioning-drain-1min` | `* * * * *`    | `/hooks/backend-provisioning-drain` | drains `clone_backends` — the clone's own Supabase project          |
| `cascade-drain-1min`              | `* * * * *`    | `/hooks/cascade-drain`              | drains `cascade_events` — module files into the clone's repo        |
| `entitlement-drain-2min`          | `*/2 * * * *`  | `/hooks/entitlement-drain`          | module reconciliation after a plan change                           |
| `codex-security-sweep`            | `*/10 * * * *` | `/hooks/codex-sweep`                | clears stalled scans (17 have been stalled for weeks)               |
| `codex-security-nightly`          | `0 7 * * *`    | `/hooks/codex-nightly`              | nightly scans — still gated by `prime_config.codex_nightly_enabled` |
| `feedback-forward-retry`          | `*/10 * * * *` | `/hooks/feedback-forward-retry`     | replays undelivered feedback                                        |

Each is scheduled with the vault lookup **inside** the command, matching the
sixteen that were already healthy, so a rotation needs no reschedule and a
missing secret produces a visible 401 rather than a job that was never made.

**A schedule is not a policy switch.** Turning `codex-security-nightly` on does
not turn nightly scanning on — `codex_nightly_enabled` does, and it was not
touched. The cron job's only job is to call the worker; whether work happens is
the worker's decision, already implemented.

**Blast radius.** Four of the six drain queues that are currently EMPTY
(`clone_backends`, `cascade_events`, `clone_entitlement_reconciliations` and
`clones` all have zero rows), so they have nothing to do on their first run.
The two with a backlog: `codex-security-sweep` marks 10 scans that have been
`running` since 31 Jul–6 Aug as timed out and may re-dispatch up to 7 `queued`
since 27 Jul (bounded by `MAX_DISPATCH_ATTEMPTS`); `feedback-forward-retry`
forwards one unforwarded submission.

**Note on the MCP.** The Lovable connector returned `499 request_cancelled` on
several of these calls while the statement had in fact COMMITTED — `cron.schedule`
returned jobid 46 for the first one only when queried afterwards. State was
re-read after every error rather than the call being retried blind. `cron.schedule`
is upsert-by-name, so a repeat would have been safe either way.

---

# 26 Aug 2026, 02:4x UTC — the other three, and what delivery actually proves

## The record above was wrong for half of it

The connector answered `499 request_cancelled` on several calls in that pass and
the note above reads them as "committed anyway". That was true for three of them
and false for three. Read back before touching anything:

```
cron.job -> 46 backend-provisioning-drain-1min   * * * * *
            47 cascade-drain-1min                * * * * *
            48 entitlement-drain-2min            */2 * * * *
            (no codex-security-nightly, no codex-security-sweep,
             no feedback-forward-retry)
```

So a 499 is not evidence either way, in either direction. The rule the note
states — re-read state after every error rather than retrying blind — is the
right one; the mistake was recording the conclusion before doing it for all six.

The remaining three were scheduled in one `DO` block (transactional, so
all-or-nothing) with the same vault-inside-command shape, and confirmed by
reading `cron.job` back:

| jobid | job                      | schedule       | endpoint                        | reads vault |
| ----: | ------------------------ | -------------- | ------------------------------- | ----------- |
|    49 | `codex-security-nightly` | `0 7 * * *`    | `/hooks/codex-nightly`          | yes         |
|    50 | `codex-security-sweep`   | `*/10 * * * *` | `/hooks/codex-sweep`            | yes         |
|    51 | `feedback-forward-retry` | `*/10 * * * *` | `/hooks/feedback-forward-retry` | yes         |

All six now exist, are `active`, and resolve `v_base` to
`https://mission-control.aurixasystems.com.au`.

## Delivery, from `net._http_response` and nothing else

98 responses in the 20 minutes after the schedules landed. **Every one 200.**
No 401, no 5xx, no timeout — so the vault-inside-command credential is being
read and accepted on every tick.

The two ten-minute jobs are the ones with observable first runs, and both fired
at exactly the two boundaries since they were created — `02:40` and `02:50`,
and at no earlier boundary in a 75-minute window:

| Job                      | 02:40                                    | 02:50                                  |
| ------------------------ | ---------------------------------------- | -------------------------------------- |
| `codex-security-sweep`   | `retried: 7, failed: 0, timedOut: 12`    | `retried: 0, failed: 0, timedOut: 0`   |
| `feedback-forward-retry` | `attempted: 1, delivered: 0, failed: 1`  | `attempted: 1, delivered: 0, failed: 1` |

The sweeper cleared its whole backlog on its first run — the 19 scans the
migration comment described, stalled since late July — and returned zeros ten
minutes later. That is the engine doing work, not just answering.

`codex-security-nightly` fires at `0 7 * * *` and had not come due. Its command
is byte-identical in shape to the two above; that is all that can honestly be
said about it yet.

**`feedback-forward-retry` is a finding, not a success.** It runs, it is
reached, and it fails the same single submission every ten minutes. The worker
was never the problem; whatever it forwards to is. Nothing here fixes that, and
it was invisible for as long as the job did not exist.

## `cron_delivery_health()` cannot attribute a response to a job

This is the function this deployment has for exactly the question above, and it
answers `NULL` for every job, always. It joins a run to its response like this:

```sql
rp.id::TEXT = regexp_replace(runs.last_message, '\D', '', 'g')
```

`last_message` is `cron.job_run_details.return_message`, and for a command of
the form `SELECT net.http_post(...)` pg_cron records the **row count**, not the
returned value:

```
jobid 43 -> "1 row"    jobid 46 -> "1 row"    jobid 48 -> "1 row"
jobid 22 -> "1 row"    jobid 47 -> "1 row"    jobid 50 -> "1 row"
```

Stripping non-digits from `"1 row"` gives `"1"`, so the lateral looks up
`net._http_response.id = 1` — a row purged long ago, ids now being ~411,000.
`last_http_status` and `delivered` are therefore NULL on every row of every
call, which reads as "never delivered" rather than as "cannot tell".

It is also unusable in practice for a second reason: casting `rp.id` to text
defeats the primary key, so the function seq-scans `net._http_response` and the
connector times it out.

**pg_net keeps no URL**, and `net.http_request_queue` is drained, so nothing in
the database currently ties a response back to the job that made it. The
attribution above was done by response-body signature — each hook returns a
distinctly-shaped JSON object — which works but is not something a function
should have to do.

The fix is a dispatch ledger: have each job command write `(jobname,
request_id)` and join `request_id = net._http_response.id` as a bigint. That
rewrites the command of **every** currently-working job, so it is not being
applied here on inference — it is written up rather than done, and applying it
is one migration.

**A green cron run is not a delivered request; a delivery-health function that
answers NULL is not a delivery report either.**
