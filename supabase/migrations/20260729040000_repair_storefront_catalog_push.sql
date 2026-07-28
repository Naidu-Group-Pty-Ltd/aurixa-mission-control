-- Repair the storefront catalog push, which has been silently doing nothing.
--
-- Mission Control is the source of truth for the storefront catalog, and a
-- statement trigger on each catalog table is supposed to call the storefront's
-- `catalog-sync` function so the pricing page updates within seconds. A
-- 15-minute reconcile cron on the storefront side is only the backstop.
--
-- At some point the trigger function was rewritten to read its URL and token
-- from Vault instead of carrying them inline — a good change — but the two
-- secrets were never created. The rewritten body treats that as a no-op:
--
--     if v_url is null or v_token is null then
--       return null;                      -- <- every catalog change, silently
--     end if;
--
-- So the push has never fired since, and every price change has taken up to
-- fifteen minutes to reach the pricing page. It was finally visible when the
-- top-up ladder went live at 21:38:46 and the storefront kept advertising the
-- retired packs until the cron ran at 21:45:02. Confirmed rather than assumed:
-- `catalog_sync_state` on the storefront holds runs at 21:15, 21:30 and 21:45
-- and nothing in between, and `net._http_response` has no request at 21:38.
--
-- Two changes here:
--
--   1. Seed the secrets, so the trigger has what it needs. Only when absent,
--      so an operator who has already set a different token keeps it.
--   2. Replace the silent no-op with a warning. A backstop that quietly takes
--      over is indistinguishable from one that is never needed; this one hid a
--      broken push for weeks. The trigger still must not fail the write — a
--      catalog edit is not wrong just because the mirror is behind — so it
--      warns and returns rather than raising.
--
-- The token is the storefront's PUBLISHABLE (anon) key. It ships in the
-- storefront's own browser bundle and is public by design: it satisfies the
-- API gateway's JWT check and authorises nothing. `catalog-sync` only pulls
-- Mission Control's public catalog and writes the storefront mirror; it cannot
-- write back here, so there is no loop and nothing to escalate.

create extension if not exists supabase_vault with schema vault;

do $$
declare
  v_url   constant text := 'https://moeyytuduycrvvncdtme.supabase.co/functions/v1/catalog-sync';
  v_token constant text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vZXl5dHVkdXljcnZ2bmNkdG1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjU0MjUsImV4cCI6MjA5OTYwMTQyNX0.gt65ttGRZJDRPuBlIkBP5RrJHHz1Mex94O62bKPdU8w';
begin
  if not exists (select 1 from vault.secrets where name = 'storefront_catalog_sync_url') then
    perform vault.create_secret(
      v_url,
      'storefront_catalog_sync_url',
      'Aurixa Systems catalog-sync endpoint. Read by notify_storefront_catalog_sync().'
    );
  end if;

  if not exists (select 1 from vault.secrets where name = 'storefront_catalog_sync_token') then
    perform vault.create_secret(
      v_token,
      'storefront_catalog_sync_token',
      'Aurixa Systems publishable (anon) key — gateway JWT only, grants nothing.'
    );
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
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'storefront_catalog_sync_url'
  limit 1;

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'storefront_catalog_sync_token'
  limit 1;

  -- Missing config must not fail the write — a catalog edit is not wrong
  -- because the mirror is behind — but it must not pass unnoticed either.
  -- Silence here is what let the push stay broken for weeks.
  if v_url is null or v_token is null then
    raise warning using
      message = 'storefront catalog push skipped: vault secret '
                || case when v_url is null then 'storefront_catalog_sync_url' else '' end
                || case when v_url is null and v_token is null then ' and ' else '' end
                || case when v_token is null then 'storefront_catalog_sync_token' else '' end
                || ' is not set',
      hint    = 'The storefront pricing page will lag behind by up to 15 minutes '
                || 'until the reconcile cron runs. Set the secrets in Vault.';
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body := '{}'::jsonb
  );
  return null;
end;
$$;

-- Prove the repair rather than assuming it. The precondition that was broken
-- is exactly this: both secrets readable through vault.decrypted_secrets. If
-- they are not, the trigger would go straight back to skipping every push, so
-- fail here instead of shipping a repair that repairs nothing.
do $$
declare
  missing text[];
begin
  select array_agg(name order by name) into missing
  from unnest(array['storefront_catalog_sync_url','storefront_catalog_sync_token']) as name
  where not exists (
    select 1 from vault.decrypted_secrets s
    where s.name = name and s.decrypted_secret is not null
  );

  if missing is not null then
    raise exception 'storefront catalog push still unconfigured: % unreadable', missing;
  end if;
end $$;

-- Fire it once, now. An UPDATE matching no rows still fires a statement-level
-- trigger, so this refreshes the storefront mirror the moment the migration is
-- applied without touching a single row — and it exercises the repaired path
-- for real rather than only asserting its inputs.
update public.topup_packs set updated_at = updated_at where false;
