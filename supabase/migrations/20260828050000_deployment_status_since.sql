-- @asserts column:clone_deployments.status_since
--
-- The deployment worker bounds waits by wall clock, and was measuring the
-- wrong clock.
--
-- `hooks/deployment-drain` deliberately does not spend an attempt on a healthy
-- wait: a build in flight and a domain waiting on DNS both re-queue without
-- incrementing `attempts`, because burning the retry budget on something that
-- was going to be fine is how a working clone gets marked failed. The bound is
-- wall-clock instead — STUCK_HOURS — and the message it writes says
-- "Stuck in <status> for more than 6h".
--
-- It computed that from `created_at`: the age of the deployment ROW. A row is
-- created once and then advances through eight statuses over its whole life,
-- so on any row older than six hours the FIRST wait of any kind resolved to
-- "stuck". Measured on this deployment: it entered `syncing_env` at 02:36:01
-- and was failed with "Stuck in syncing_env for more than 6h" at 02:37:01 —
-- sixty seconds later — because the row had been created the previous day.
--
-- The reach is every wait in the pipeline, not just that one. `deploying`
-- waits 30 seconds for a queued build; `verifying_domain` waits on DNS
-- propagation. On a row older than the budget, none of them can complete, so
-- no deployment that is not finished within six hours of its row being created
-- can ever finish at all. That is the whole of "Vercel deployments stuck in
-- progress": they were not stuck, they were being failed on their first tick.
--
-- This column records when the row entered the status it is in now, which is
-- the quantity the message has always claimed. `finalize()` stamps it on
-- transition and only on transition — a wait inside the same status must not
-- reset it, or the budget could never be reached and the bound would stop
-- existing in the other direction.

ALTER TABLE public.clone_deployments
  ADD COLUMN IF NOT EXISTS status_since timestamptz;

COMMENT ON COLUMN public.clone_deployments.status_since IS
  'When this row entered its current status. The deployment worker measures its '
  'wall-clock wait budget from here. NOT created_at, which is the age of the row: '
  'measuring from that failed every deployment on its first wait.';

-- Backfill from the event log rather than from now(), because the log already
-- knows. `deployment_events` records every transition with `to_status`, so the
-- most recent event that moved a row INTO its current status is exactly the
-- timestamp this column wants.
--
-- Rows with no such event fall back to `updated_at`, then `created_at`. Both
-- fallbacks can only be EARLIER than the truth, never later, and an earlier
-- stamp is the safe direction to be wrong in: it can retire a genuinely stalled
-- row sooner, and it cannot fail a healthy one that has just started waiting.
UPDATE public.clone_deployments d
SET status_since = COALESCE(
  (
    SELECT max(e.created_at)
    FROM public.deployment_events e
    WHERE e.clone_id = d.clone_id
      AND e.to_status = d.status
  ),
  d.updated_at,
  d.created_at,
  now()
)
WHERE d.status_since IS NULL;

ALTER TABLE public.clone_deployments
  ALTER COLUMN status_since SET DEFAULT now();

-- A row inserted without the column would be unmeasurable, and `judgeWait`
-- reads an absent stamp as "waiting" rather than as "stuck" — the safe reading,
-- but one that removes the bound entirely. The default plus this NOT NULL keep
-- the bound real for every future row.
ALTER TABLE public.clone_deployments
  ALTER COLUMN status_since SET NOT NULL;
