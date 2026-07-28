-- Repair the storefront catalog push.
create extension if not exists supabase_vault with schema vault;

do $$
declare
  v_url   constant text := 'https://moeyytuduycrvvncdtme.supabase.co/functions/v1/catalog-sync';
  v_token constant text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vZXl5dHVkdXljcnZ2bmNkdG1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjU0MjUsImV4cCI6MjA5OTYwMTQyNX0.gt65ttGRZJDRPuBlIkBP5RrJHHz1Mex94O62bKPdU8w';
begin
  if not exists (select 1 from vault.secrets where name = 'storefront_catalog_sync_url') then
    perform vault.create_secret(v_url, 'storefront_catalog_sync_url', 'Aurixa Systems catalog-sync endpoint.');
  end if;
  if not exists (select 1 from vault.secrets where name = 'storefront_catalog_sync_token') then
    perform vault.create_secret(v_token, 'storefront_catalog_sync_token', 'Aurixa Systems publishable (anon) key.');
  end if;
end $$;

create or replace function public.notify_storefront_catalog_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url   text;
  v_token text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'storefront_catalog_sync_url' limit 1;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'storefront_catalog_sync_token' limit 1;

  if v_url is null or v_token is null then
    raise warning using
      message = 'storefront catalog push skipped: vault secret '
                || case when v_url is null then 'storefront_catalog_sync_url' else '' end
                || case when v_url is null and v_token is null then ' and ' else '' end
                || case when v_token is null then 'storefront_catalog_sync_token' else '' end
                || ' is not set',
      hint    = 'The storefront pricing page will lag until the reconcile cron runs. Set the secrets in Vault.';
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body    := '{}'::jsonb
  );
  return null;
end;
$$;

do $$
declare
  missing text[];
begin
  select array_agg(name order by name) into missing
  from unnest(array['storefront_catalog_sync_url','storefront_catalog_sync_token']) as name
  where not exists (
    select 1 from vault.decrypted_secrets s where s.name = name and s.decrypted_secret is not null
  );
  if missing is not null then
    raise exception 'storefront catalog push still unconfigured: % unreadable', missing;
  end if;
end $$;

update public.topup_packs set updated_at = updated_at where false;