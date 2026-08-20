-- Tearing a clone's hosting down when the clone is deleted.
--
-- Deleting a clone today removes the row and nothing else. The Vercel project
-- keeps building, the custom domain stays attached to it, and the Cloudflare
-- CNAME keeps resolving — so `<slug>.aurixasystems.com.au` serves a live
-- application for a customer who has been offboarded. That is worse than an
-- orphaned resource: it is a running site nobody is watching, on our domain,
-- carrying whatever data its Supabase project still holds.
--
-- The hard part is that everything needed to clean up is destroyed by the same
-- delete. `clone_deployments.clone_id`, `edge_provisioning_jobs.clone_id` and
-- `edge_dns_records.clone_id` all cascade, so by the time any application code
-- could react, the project id and the DNS record ids are gone. Enqueuing a
-- normal job does not help — that job cascades too.
--
-- So the teardown queue holds everything BY VALUE and has no foreign key to
-- `clones` at all, and it is filled by a BEFORE DELETE trigger rather than by a
-- server function. The trigger is the point: `bulkDeleteClones` is one delete
-- path, an admin with SQL access is another, and a future feature will be a
-- third. A trigger covers the ones nobody has written yet.

create table if not exists public.hosting_teardowns (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately NOT a foreign key. The clone is already gone by the time this
  -- row is processed; the id is kept so an operator can correlate it with the
  -- audit log, and a constraint would delete the very row that does the work.
  clone_id uuid,
  clone_name text,
  clone_slug text,
  provider_slug text not null default 'vercel',
  project_id text,
  project_name text,
  team_id text,
  domain text,
  zone_id text,
  -- Cloudflare record ids captured before the cascade takes edge_dns_records.
  dns_record_ids text[] not null default '{}',
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','skipped')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  worker_started_at timestamptz,
  error_message text,
  result jsonb not null default '{}'::jsonb,
  requested_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists hosting_teardowns_claim_idx
  on public.hosting_teardowns (status, next_attempt_at)
  where status in ('queued','running');

grant select on public.hosting_teardowns to authenticated;
grant all on public.hosting_teardowns to service_role;
alter table public.hosting_teardowns enable row level security;
drop policy if exists "hosting_teardowns_admin_read" on public.hosting_teardowns;
create policy "hosting_teardowns_admin_read" on public.hosting_teardowns
for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "hosting_teardowns_admin_write" on public.hosting_teardowns;
create policy "hosting_teardowns_admin_write" on public.hosting_teardowns
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- ── The capture ─────────────────────────────────────────────────────────────
create or replace function public.capture_hosting_teardown()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep record;
  v_records text[];
  v_zone text;
begin
  select provider_slug, project_id, project_name, team_id, domain
    into v_dep
    from public.clone_deployments
   where clone_id = old.id;

  -- Managed records only. An unmanaged row is one we discovered rather than
  -- created — deleting somebody else's DNS record because a clone was removed
  -- is not cleanup, it is collateral damage.
  select coalesce(array_agg(external_record_id), '{}'), min(zone_id)
    into v_records, v_zone
    from public.edge_dns_records
   where clone_id = old.id
     and managed is true
     and purpose in ('clone_subdomain', 'domain_verification')
     and external_record_id is not null;

  -- Nothing provisioned, nothing to tear down. Writing a row anyway would give
  -- the worker a queue full of no-ops and hide the real ones in it.
  if (v_dep.project_id is null) and (coalesce(array_length(v_records, 1), 0) = 0) then
    return old;
  end if;

  insert into public.hosting_teardowns (
    clone_id, clone_name, clone_slug, provider_slug,
    project_id, project_name, team_id, domain, zone_id, dns_record_ids
  ) values (
    old.id, old.name, old.slug, coalesce(v_dep.provider_slug, 'vercel'),
    v_dep.project_id, v_dep.project_name, v_dep.team_id,
    coalesce(v_dep.domain, old.subdomain_fqdn), v_zone, coalesce(v_records, '{}')
  );

  return old;
end;
$$;

revoke all on function public.capture_hosting_teardown() from public;

drop trigger if exists clones_capture_hosting_teardown on public.clones;
create trigger clones_capture_hosting_teardown
  before delete on public.clones
  for each row execute function public.capture_hosting_teardown();

comment on table public.hosting_teardowns is
  'Work that must outlive the clone it belongs to. Filled by a BEFORE DELETE '
  'trigger on clones, because every table holding the provider references '
  'cascades on that same delete. No FK to clones on purpose.';

-- Finished teardowns are a record of what was removed and worth keeping longer
-- than the events table: "why did this domain stop resolving" is asked months
-- later. A year, then gone.
create or replace function public.purge_hosting_teardowns()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted integer;
begin
  delete from public.hosting_teardowns
   where status in ('done','skipped')
     and completed_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.purge_hosting_teardowns() from public;
grant execute on function public.purge_hosting_teardowns() to service_role;
