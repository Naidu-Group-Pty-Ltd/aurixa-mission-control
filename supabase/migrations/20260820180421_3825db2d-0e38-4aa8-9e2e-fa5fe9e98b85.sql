-- Tearing a clone's hosting down when the clone is deleted.
create table if not exists public.hosting_teardowns (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid,
  clone_name text,
  clone_slug text,
  provider_slug text not null default 'vercel',
  project_id text,
  project_name text,
  team_id text,
  domain text,
  zone_id text,
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

  select coalesce(array_agg(external_record_id), '{}'), min(zone_id)
    into v_records, v_zone
    from public.edge_dns_records
   where clone_id = old.id
     and managed is true
     and purpose in ('clone_subdomain', 'domain_verification')
     and external_record_id is not null;

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