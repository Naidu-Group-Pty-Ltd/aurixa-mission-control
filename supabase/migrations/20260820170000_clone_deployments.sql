-- Clone deployments: the step the provisioning pipeline never had.
--
-- `provisionClone` creates a GitHub repo, installs modules, issues an API key,
-- pushes the Codex secrets and enqueues a Supabase backend — and then stops.
-- Nothing builds the clone and nothing serves it. The word "Vercel" did not
-- appear anywhere in this repository before this migration.
--
-- That gap is not visible as a missing feature. It is visible as
-- `clones.deploy_url`, a column READ IN TWENTY PLACES AND WRITTEN IN NONE:
--
--   clone-health.server.ts        pings deploy_url for uptime  → never runs
--   security-partner-dashboard    target_urls: [deploy_url]    → always []
--   billing-handoffs.server.ts    pins the return host to it   → never engages
--   backend-provisioning          builds the new Supabase project's auth
--                                 site_url + uri_allow_list from
--                                 `deploy_url ?? lovable_project_url` — and
--                                 BOTH columns are written by nothing, so the
--                                 allow-list has only ever contained one
--                                 guessed hostname.
--
-- Each consumer degrades quietly rather than failing, which is why none of them
-- ever reported it.
--
-- See docs/HOSTING_ARCHITECTURE.md. The rules that shaped this schema:
--   R3  clone_id is the PRIMARY KEY. `provisionClone` learned the duplicate
--       lesson the expensive way (a double-click forked two GitHub repos, which
--       is why idempotency_key exists); a duplicate Vercel project is worse,
--       because the second one takes the domain while the first keeps building.
--   R4  A deployment that FAILED is not one that is ABSENT. `not_requested`,
--       `deploying` and `failed` are three different facts and one badge cannot
--       say all three — the same reason cron_delivery_health.delivered is
--       three-valued.

-- ── Provider registry ───────────────────────────────────────────────────────
-- Mirrors public.edge_providers so the UI can list what exists without the
-- server telling it. `manual` is a real answer, not a placeholder: it is how
-- every clone is served today (a Lovable custom-domain target), it simply has
-- no API we drive.
create table if not exists public.hosting_providers (
  slug text primary key,
  display_name text not null,
  status text not null default 'live' check (status in ('live', 'manual', 'mocked')),
  capabilities jsonb not null default '{}'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.hosting_providers to authenticated;
grant all on public.hosting_providers to service_role;
alter table public.hosting_providers enable row level security;
drop policy if exists "hosting_providers_read" on public.hosting_providers;
create policy "hosting_providers_read" on public.hosting_providers
for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "hosting_providers_write" on public.hosting_providers;
create policy "hosting_providers_write" on public.hosting_providers
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

insert into public.hosting_providers (slug, display_name, status, sort_order, capabilities) values
  ('vercel', 'Vercel', 'live', 10, '{"git_link":true,"env_vars":true,"custom_domain":true,"redeploy":true}'::jsonb),
  ('manual', 'Manual / Lovable target', 'manual', 90, '{"git_link":false,"env_vars":false,"custom_domain":true,"redeploy":false}'::jsonb)
on conflict (slug) do update
  set display_name = excluded.display_name,
      status       = excluded.status,
      capabilities = excluded.capabilities,
      sort_order   = excluded.sort_order,
      updated_at   = now();

-- ── The deployment itself ───────────────────────────────────────────────────
create table if not exists public.clone_deployments (
  clone_id uuid primary key references public.clones(id) on delete cascade,
  provider_slug text not null default 'vercel' references public.hosting_providers(slug),

  -- Lifecycle. `not_requested` is the operator declining deployment for this
  -- clone; it is NOT a failure and must never render as one (R4).
  status text not null default 'pending' check (status in (
    'not_requested', 'pending_platform', 'pending',
    'creating_project', 'linking_repo', 'syncing_env',
    'deploying', 'attaching_domain', 'verifying_domain',
    'live', 'failed', 'detached'
  )),
  status_detail text,

  -- Provider references.
  project_id text,
  project_name text,
  team_id text,
  latest_deployment_id text,
  -- The provider's own always-on origin (e.g. https://<project>.vercel.app).
  -- Recorded separately from the custom domain so a clone whose DNS has not
  -- landed yet still has a reachable URL for an operator to check.
  provider_origin text,

  -- Custom domain, and the one value the Cloudflare side needs from Vercel.
  domain text,
  -- CNAME/A content Vercel issued for `domain`. NULL means "use the fleet
  -- default in platform_hosting_config.target_value" (R2).
  dns_target_type text check (dns_target_type is null or dns_target_type in ('a','cname')),
  dns_target_value text,
  -- Ownership challenge, when the provider demands one.
  domain_verification jsonb not null default '[]'::jsonb,
  domain_verified_at timestamptz,

  -- Environment sync. `env_digest` is a hash of the NAMES and values we last
  -- pushed, so a re-sync that would change nothing is skipped rather than
  -- burning a rate-limited write per clone per run.
  env_digest text,
  env_synced_at timestamptz,

  -- Worker fields, same shape as clone_backends so the two drains read alike.
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  worker_started_at timestamptz,
  worker_finished_at timestamptz,
  last_deployed_at timestamptz,
  error_message text,

  requested_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.clone_deployments to authenticated;
grant all on public.clone_deployments to service_role;
alter table public.clone_deployments enable row level security;
drop policy if exists "clone_deployments_admin_read" on public.clone_deployments;
create policy "clone_deployments_admin_read" on public.clone_deployments
for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "clone_deployments_admin_write" on public.clone_deployments;
create policy "clone_deployments_admin_write" on public.clone_deployments
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- The drain claims by (status, next_attempt_at) and never scans the whole
-- table; without this it does, and an unordered claim above the cap is how
-- seven other batches in this repo came to process an arbitrary subset.
create index if not exists clone_deployments_claim_idx
  on public.clone_deployments (next_attempt_at)
  where status not in ('live', 'failed', 'detached', 'not_requested', 'pending_platform');

-- A project name is a namespace on the provider's side; two clones holding the
-- same one is the duplicate-project failure R3 exists to prevent, arriving by a
-- different route.
create unique index if not exists clone_deployments_project_uidx
  on public.clone_deployments (provider_slug, project_name)
  where project_name is not null;

create unique index if not exists clone_deployments_domain_uidx
  on public.clone_deployments (domain)
  where domain is not null;

-- ── Audit ───────────────────────────────────────────────────────────────────
-- Append-only, mirroring edge_audit. Every transition and every provider call,
-- so "why is this clone stuck in attaching_domain" is answerable from the row
-- rather than from a log that has rolled over.
create table if not exists public.deployment_events (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null references public.clones(id) on delete cascade,
  provider_slug text not null,
  action text not null,
  from_status text,
  to_status text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  success boolean not null default true,
  error_message text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
grant select on public.deployment_events to authenticated;
grant all on public.deployment_events to service_role;
alter table public.deployment_events enable row level security;
drop policy if exists "deployment_events_admin_read" on public.deployment_events;
create policy "deployment_events_admin_read" on public.deployment_events
for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "deployment_events_admin_write" on public.deployment_events;
create policy "deployment_events_admin_write" on public.deployment_events
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create index if not exists deployment_events_clone_idx
  on public.deployment_events (clone_id, created_at desc);

-- Retention. edge_audit and this table are both unbounded write paths driven by
-- a per-minute worker; support_ingest_requests grew without limit for exactly
-- this reason and its rate limiter then ran three exact counts over it per
-- request. 90 days is well past any debugging window.
create or replace function public.purge_deployment_events()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.deployment_events
   where created_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.purge_deployment_events() from public;
grant execute on function public.purge_deployment_events() to service_role;

-- ── Platform config: which provider, and how to name projects ───────────────
-- `provider_slug` has existed on this table since the subdomain feature shipped
-- and NOTHING HAS EVER READ IT. It stays as the DNS provider; hosting gets its
-- own column rather than overloading one field with two meanings.
alter table public.platform_hosting_config
  add column if not exists hosting_provider_slug text not null default 'manual',
  add column if not exists vercel_team_id text,
  add column if not exists vercel_project_prefix text not null default '',
  add column if not exists auto_deploy boolean not null default false;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'platform_hosting_config_hosting_provider_fk'
  ) then
    alter table public.platform_hosting_config
      add constraint platform_hosting_config_hosting_provider_fk
      foreign key (hosting_provider_slug) references public.hosting_providers(slug);
  end if;
end $$;

comment on column public.platform_hosting_config.target_value is
  'Fleet DEFAULT DNS target. Used when the resolved hosting provider is manual, '
  'or when a clone has no deployment of its own. A clone whose deployment '
  'reports its own CNAME target overrides this — see resolveDnsTarget. A single '
  'fleet-wide value is correct only where one origin serves every clone by Host '
  'header; with a project per clone it resolves every clone to an edge that has '
  'never heard of it.';

-- ── Notification kinds ──────────────────────────────────────────────────────
-- Declared BEFORE anything inserts them. Three kinds shipped without this once
-- and every insert failed with `invalid input value for enum`, silently,
-- because the error was discarded.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'deployment_live';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'deployment_failed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'deployment_domain_pending';
