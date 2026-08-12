-- ────────────────────────────────────────────────────────────────────────
-- Support ticketing + self-healing remediation.
--
-- 1. `support_tickets` — tickets ingested from the Aurixa Support Portal
--    (workspace_id + user_id travel from the tenant dashboard), classified
--    P0–P4 by the deterministic matrix in src/lib/ticket-classification.ts.
-- 2. `support_ticket_events` — append-only audit trail per ticket.
-- 3. `remediation_runs` — one row per self-healing action (PR auto-merge,
--    SQL catch-up, edge-function redeploy, recovery monitor, rescan).
--    P2-and-below actions execute unattended; anything the policy module
--    flags parks as `awaiting_validation` for a human.
-- 4. `support_ingest_requests` — sliding-window rate-limit ledger for the
--    public ingest endpoint.
-- 5. Registers the portal as a `security_intake_sources` row so its HMAC
--    secret is managed exactly like every other intake source.
-- 6. Schedules the remediation drain (pg_cron → /hooks/support-remediation-drain).
-- ────────────────────────────────────────────────────────────────────────

-- ── Enums ────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.ticket_priority AS ENUM ('P0', 'P1', 'P2', 'P3', 'P4');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.support_ticket_status AS ENUM (
    'new',                -- inserted, not yet classified (transient)
    'triaged',            -- classified; waiting on a human or has no lane
    'remediating',        -- self-healing runs planned or executing
    'awaiting_validation',-- at least one run parked for human approval
    'remediated',         -- all runs finished, fix in place
    'resolved',           -- confirmed resolved (auto after remediation, or by operator)
    'closed',             -- closed without remediation (duplicate, no-fault, …)
    'failed'              -- remediation exhausted; needs a person
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.support_ticket_category AS ENUM (
    'security_threat',
    'api_outage',
    'provider_downtime',
    'bug',
    'performance',
    'data_issue',
    'access',
    'billing',
    'feature_request',
    'question',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.support_breakage_vector AS ENUM (
    'full_outage',
    'partial_outage',
    'degraded_performance',
    'single_feature',
    'intermittent',
    'cosmetic',
    'none'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.remediation_action_type AS ENUM (
    'pr_merge',            -- squash-merge a verified codex remediation PR
    'sql_migration',       -- replay pending, non-destructive prime migrations onto the clone
    'edge_function_deploy',-- redeploy prime function bundles onto the clone
    'monitor_recovery',    -- watch health beacons; resolve when the clone recovers
    'rescan',              -- enqueue a codex security scan
    'manual'               -- placeholder for operator-driven work
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.remediation_run_status AS ENUM (
    'planned',             -- eligible for the drain
    'awaiting_validation', -- policy parked it; needs an admin decision
    'approved',            -- admin released it; drain executes next pass
    'rejected',            -- admin declined it
    'executing',
    'succeeded',
    'failed',
    'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Notification kinds used by the pipeline. Safe alongside table DDL because
-- nothing in THIS migration inserts rows using them.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'support_ticket_created';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'support_ticket_escalated';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'remediation_awaiting_validation';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'remediation_auto_completed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'remediation_failed';

-- ── 1. support_tickets ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  source_slug TEXT NOT NULL DEFAULT 'support-portal'
    REFERENCES public.security_intake_sources(slug),

  -- Identity as the portal sent it. `workspace_id` is the tenant-side
  -- identifier (a clone slug, a tenant external_ref, or a prime billing
  -- uid like "npc-prime"); resolution onto our fleet is best-effort and
  -- recorded in `metadata.workspace_resolution`.
  workspace_id TEXT NOT NULL,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  user_external_id TEXT,
  reporter_name TEXT,
  reporter_email TEXT,

  category public.support_ticket_category NOT NULL,
  breakage_vector public.support_breakage_vector NOT NULL DEFAULT 'none',
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  impact TEXT,

  -- Classification output, denormalised for querying; the full reasoning
  -- lives in `classification` for the audit trail.
  priority public.ticket_priority NOT NULL,
  priority_score INT NOT NULL DEFAULT 0,
  priority_overridden_by UUID REFERENCES auth.users(id),
  priority_overridden_at TIMESTAMPTZ,
  classification JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_human BOOLEAN NOT NULL DEFAULT false,
  auto_remediable BOOLEAN NOT NULL DEFAULT false,
  remediation_lane TEXT,

  status public.support_ticket_status NOT NULL DEFAULT 'new',
  sla_due_at TIMESTAMPTZ,
  sla_breached_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,

  codex_finding_id UUID REFERENCES public.codex_findings(id) ON DELETE SET NULL,
  client_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_tickets_open_idx
  ON public.support_tickets(priority, created_at DESC)
  WHERE status NOT IN ('resolved', 'closed');

CREATE INDEX IF NOT EXISTS support_tickets_workspace_idx
  ON public.support_tickets(workspace_id, created_at DESC);

-- The SLA sweep only cares about unresolved tickets with a deadline that
-- has not yet been marked breached.
CREATE INDEX IF NOT EXISTS support_tickets_sla_idx
  ON public.support_tickets(sla_due_at)
  WHERE resolved_at IS NULL AND sla_breached_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.support_tickets TO authenticated;
GRANT ALL ON public.support_tickets TO service_role;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "support_tickets read operator+" ON public.support_tickets
  FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

CREATE POLICY "support_tickets write admin" ON public.support_tickets
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS trg_support_tickets_updated ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 2. support_ticket_events (append-only) ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_ticket_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  -- auth.users uuid for operator actions, 'system' for pipeline actions.
  actor TEXT NOT NULL DEFAULT 'system',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_events_ticket_idx
  ON public.support_ticket_events(ticket_id, created_at);

GRANT SELECT, INSERT ON public.support_ticket_events TO authenticated;
GRANT ALL ON public.support_ticket_events TO service_role;
ALTER TABLE public.support_ticket_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "support_ticket_events read operator+" ON public.support_ticket_events
  FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

CREATE POLICY "support_ticket_events insert admin" ON public.support_ticket_events
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));

-- ── 3. remediation_runs ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.remediation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  -- Scan-driven runs (auto-merge of a verified codex remediation) may
  -- exist without a ticket.
  finding_id UUID REFERENCES public.codex_findings(id) ON DELETE SET NULL,
  remediation_id UUID REFERENCES public.codex_remediations(id) ON DELETE SET NULL,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,

  action_type public.remediation_action_type NOT NULL,
  priority public.ticket_priority NOT NULL DEFAULT 'P3',
  status public.remediation_run_status NOT NULL DEFAULT 'planned',
  requires_human BOOLEAN NOT NULL DEFAULT false,
  destructive BOOLEAN NOT NULL DEFAULT false,

  -- What the policy decided and why (decideRemediation output), what the
  -- executor should do (lane-specific), and what actually happened.
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,

  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 30,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES auth.users(id),
  rejected_at TIMESTAMPTZ,
  rejected_reason TEXT,

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The drain's work queue.
CREATE INDEX IF NOT EXISTS remediation_runs_drain_idx
  ON public.remediation_runs(next_attempt_at)
  WHERE status IN ('planned', 'approved');

CREATE INDEX IF NOT EXISTS remediation_runs_ticket_idx
  ON public.remediation_runs(ticket_id);

CREATE INDEX IF NOT EXISTS remediation_runs_awaiting_idx
  ON public.remediation_runs(created_at DESC)
  WHERE status = 'awaiting_validation';

GRANT SELECT, INSERT, UPDATE ON public.remediation_runs TO authenticated;
GRANT ALL ON public.remediation_runs TO service_role;
ALTER TABLE public.remediation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "remediation_runs read operator+" ON public.remediation_runs
  FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

CREATE POLICY "remediation_runs write admin" ON public.remediation_runs
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS trg_remediation_runs_updated ON public.remediation_runs;
CREATE TRIGGER trg_remediation_runs_updated BEFORE UPDATE ON public.remediation_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 4. support_ingest_requests (rate-limit ledger) ──────────────────────

-- One row per ingest attempt, valid or not — failed validations count
-- against the window too. Service-role only; the drain prunes rows older
-- than 7 days.
CREATE TABLE IF NOT EXISTS public.support_ingest_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash TEXT NOT NULL,
  workspace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ingest_requests_ip_idx
  ON public.support_ingest_requests(ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS support_ingest_requests_workspace_idx
  ON public.support_ingest_requests(workspace_id, created_at DESC);

GRANT ALL ON public.support_ingest_requests TO service_role;
ALTER TABLE public.support_ingest_requests ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role client (the ingest endpoint and the
-- drain) may touch this table.

-- ── 5. Register the portal as an intake source ──────────────────────────

-- hmac_secret starts NULL: until an operator sets one on /security/intake,
-- the ingest endpoint falls back to the SUPPORT_INGEST_SECRET shared-secret
-- header (and records unverified submissions as such in ticket metadata).
INSERT INTO public.security_intake_sources (slug, name, kind, active, metadata)
VALUES (
  'support-portal',
  'Aurixa Support Portal',
  'ticketing',
  true,
  jsonb_build_object('managed_by', 'support-ticketing')
)
ON CONFLICT (slug) DO NOTHING;

-- ── 6. Schedule the remediation drain ────────────────────────────────────

DO $$
DECLARE
  v_secret TEXT;
  v_base TEXT;
  v_headers TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE WARNING 'pg_cron not installed — support remediation drain NOT scheduled.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;

  IF v_secret IS NULL THEN
    -- Loud, because the failure it guards against is invisible: without the
    -- drain, planned remediations sit forever and every "self-healing"
    -- promise silently stops being true.
    RAISE WARNING 'Vault entry cron_secret not found — support remediation drain NOT scheduled. Planned remediation runs will not execute until this is set.';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_base
  FROM vault.decrypted_secrets WHERE name = 'app_public_url' LIMIT 1;
  v_base := COALESCE(NULLIF(rtrim(v_base, '/'), ''), 'https://aurixa-mission-control.lovable.app');

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_secret
  )::text;

  PERFORM cron.unschedule('support-remediation-drain')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'support-remediation-drain');

  PERFORM cron.schedule(
    'support-remediation-drain', '*/2 * * * *',
    format($f$SELECT net.http_post(
      url:=%L, headers:=%L::jsonb, body:='{}'::jsonb)$f$,
      v_base || '/hooks/support-remediation-drain', v_headers)
  );
EXCEPTION WHEN OTHERS THEN
  -- Scheduling depends on vault, pg_net and cron privileges — none worth
  -- failing the schema over. Warned rather than swallowed: a drain that was
  -- never scheduled is exactly the silent failure self-healing cannot have.
  RAISE WARNING 'support remediation drain NOT scheduled (%). Drive it manually with POST /hooks/support-remediation-drain until this is fixed.', SQLERRM;
END $$;
