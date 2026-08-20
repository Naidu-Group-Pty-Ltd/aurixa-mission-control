-- The fleet decision: every clone is staged on Vercel and served at
-- <subdomain>.aurixasystems.com.au, with DNS in Cloudflare.
--
-- Until now the hosting columns shipped with defaults that describe the OLD
-- world — `manual` provider, `auto_deploy` off, and a fleet-wide DNS target of
-- Lovable's A record. Those defaults are not neutral: a clone provisioned today
-- would record `provider_slug = 'manual'`, never be built, and point its
-- subdomain at an origin that has never heard of it.
--
-- Three separate things are being changed and it is worth naming why each is
-- safe:
--
--   1. The COLUMN DEFAULTS, which only affect rows inserted from here on.
--   2. The SINGLETON ROW, but only where it still holds the shipped default —
--      an operator who deliberately set something keeps it. A migration that
--      overwrites a deliberate value is a migration that loses a decision
--      nobody recorded anywhere else.
--
--      One honest limit, found by re-running this against a real database: for
--      `hosting_provider_slug` the old default and a deliberate choice are the
--      SAME VALUE — `manual` means both "never configured" and "an operator
--      chose hand-serving". Nothing in the schema distinguishes them, so a
--      re-run would flip a deliberate `manual` back to `vercel`. Supabase
--      applies a migration once, so this is a hazard of a hand re-run rather
--      than of deployment; it is written down because the guard below LOOKS
--      like it protects a deliberate choice here and does not.
--   3. `proxied`, which is the one that would fail silently. See below.

-- ── 1. Column defaults ──────────────────────────────────────────────────────
alter table public.platform_hosting_config
  alter column hosting_provider_slug set default 'vercel',
  alter column auto_deploy set default true;

-- ── 2. The singleton, where it is untouched ─────────────────────────────────
update public.platform_hosting_config
   set hosting_provider_slug = 'vercel',
       updated_at = now()
 where singleton = true
   and hosting_provider_slug = 'manual';

update public.platform_hosting_config
   set auto_deploy = true,
       updated_at = now()
 where singleton = true
   and auto_deploy = false;

-- The domain the whole fleet is served from. Already the shipped default; set
-- again only where it is empty, so this migration is the one place a reader can
-- confirm it rather than having to trust a default from eight months ago.
update public.platform_hosting_config
   set primary_domain = 'aurixasystems.com.au',
       updated_at = now()
 where singleton = true
   and (primary_domain is null or btrim(primary_domain) = '');

-- ── 3. The fleet DNS default ────────────────────────────────────────────────
-- `185.158.133.1` is Lovable's A record, correct for a platform where ONE
-- origin serves every clone and routes by Host header. With a Vercel project
-- per clone it is wrong twice over: wrong platform, and wrong shape — Vercel
-- routes by the domains registered on a project, so an address record for the
-- fleet resolves every clone to an edge that answers DEPLOYMENT_NOT_FOUND.
--
-- The value that matters is still the per-deployment CNAME Vercel issues
-- (resolveDnsTarget prefers it, and on a provider-managed fleet now REQUIRES
-- it). This default only survives for a clone served by hand, and pointing that
-- at the right platform is better than pointing it at the previous one.
update public.platform_hosting_config
   set target_type = 'cname',
       target_value = 'cname.vercel-dns.com',
       updated_at = now()
 where singleton = true
   and target_type = 'a'
   and target_value = '185.158.133.1';

-- `proxied` is the one that fails SILENTLY, and it is the single most expensive
-- value on this table.
--
-- An orange-cloud record terminates TLS at Cloudflare and hides the origin. A
-- hosting provider issuing its own certificate needs its challenge to reach the
-- origin, so a proxied record means the domain attaches, the DNS resolves, the
-- site even loads through Cloudflare's edge — and the certificate never issues.
-- The symptom is an intermittent TLS error on a domain that looks correctly
-- configured in both dashboards.
--
-- `resolveDnsTarget` already forces DNS-only for a deployment-sourced target.
-- This aligns the stored default with that so the two cannot disagree, and so
-- an operator reading the settings page is not told `proxied` when nothing is.
update public.platform_hosting_config
   set proxied = false,
       updated_at = now()
 where singleton = true
   and proxied = true;

alter table public.platform_hosting_config
  alter column proxied set default false;

comment on column public.platform_hosting_config.proxied is
  'Cloudflare orange-cloud. FALSE for any provider-managed target: a proxied '
  'record hides the origin from the provider''s ACME challenge, so the '
  'certificate never issues while every dashboard shows the domain as '
  'correctly configured. resolveDnsTarget forces DNS-only for deployment '
  'targets regardless of this value.';

comment on column public.platform_hosting_config.hosting_provider_slug is
  'Which provider builds and serves a clone. Defaults to vercel: every clone is '
  'staged on Vercel and served at <subdomain>.aurixasystems.com.au. `manual` '
  'means a person configures the host — a real posture, not a failure.';

-- ── 4. A subdomain status the column will accept ────────────────────────────
-- `awaiting_deployment` is a real, common and CORRECT state on a
-- provider-managed fleet: the clone has its name reserved, the platform is
-- configured, and there is simply no DNS target yet because its Vercel project
-- has not attached the domain. It is neither `pending_platform` (which blames
-- the platform, sending an operator to Settings to fix something that is fine)
-- nor `failed`.
--
-- It has to be added to the CHECK before anything writes it. A status the column
-- refuses fails the UPDATE with `violates check constraint`, and every caller
-- here discards the error — so the row would simply never move, which is the
-- single hardest failure in this codebase to diagnose from the UI.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'clones_subdomain_status_check') then
    alter table public.clones drop constraint clones_subdomain_status_check;
  end if;
  alter table public.clones add constraint clones_subdomain_status_check
    check (subdomain_status is null or subdomain_status in
      ('pending_platform','awaiting_deployment','queued','provisioning','active','failed','detached'));
end $$;

comment on column public.clones.subdomain_status is
  'pending_platform = the platform is not configured. awaiting_deployment = the '
  'platform is fine and the clone''s own deployment has not reported a DNS '
  'target yet. Collapsing the two sends an operator to the wrong page.';

-- ── 5. Build health, separate from the deployment lifecycle ─────────────────
-- The drain polls a deployment only while the row is in `deploying`, and stops
-- at `live`. That is right — polling every live clone forever burns the team
-- rate limit on nothing — but it leaves the NEXT build unobserved. A cascade
-- pushes code, the build fails, Vercel keeps the previous production deployment
-- serving, and this table goes on saying `live`. Which is true, and useless:
-- the clone is up, and it is not running what we last pushed.
--
-- Those are two facts and one column cannot carry both. Overloading `status`
-- would make a failed build read as an outage and send whoever is paged to the
-- wrong problem, so build health gets its own columns and `status` stays the
-- lifecycle the worker owns.
alter table public.clone_deployments
  add column if not exists last_build_state text
    check (last_build_state is null or last_build_state in
      ('queued','building','ready','error','canceled')),
  add column if not exists last_build_deployment_id text,
  add column if not exists last_build_error text,
  add column if not exists last_build_at timestamptz,
  -- When the reconciliation sweep last ASKED. Distinct from `last_build_at`,
  -- which is when the answer last changed: a sweep that runs and finds nothing
  -- new must still record that it ran, or the backoff cannot tell "checked,
  -- unchanged" from "never checked".
  add column if not exists build_checked_at timestamptz;

create index if not exists clone_deployments_build_check_idx
  on public.clone_deployments (build_checked_at)
  where status = 'live';

comment on column public.clone_deployments.last_build_state is
  'Health of the most recent PRODUCTION build, independent of `status`. `live` '
  'with last_build_state = error means the clone is serving the previous good '
  'build and the latest push did not ship.';

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'deployment_build_failed';