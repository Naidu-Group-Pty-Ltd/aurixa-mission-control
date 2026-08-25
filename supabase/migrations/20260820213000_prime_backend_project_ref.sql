-- The prime BACKEND has never had a configured address.
--
-- `prime_config` names the prime REPO — github_owner/github_repo — and every
-- path that reads migrations from GitHub resolves through it correctly. But
-- the clone pipeline also needs the prime's *Supabase project*: the live
-- catalogue that `replicateSchemaByIntrospection` copies onto a new clone,
-- and the ledger that `stampMigrationLedgerFromPrime` copies from.
--
-- No column held it. `getPrimeProjectRef()` derived one from `SUPABASE_URL`
-- instead — which is THIS deployment's own project, the database holding
-- `clones`, `prime_config` and `cascade_events`. Introspection is the DEFAULT
-- strategy, so a clone provisioned through it would receive Mission Control's
-- own admin schema rather than the product schema its application expects,
-- and a ledger of Mission Control's migration IDs that no product migration
-- can ever match.
--
-- The column is nullable on purpose. A deployment that has not set it must
-- FAIL provisioning with a message naming the setting, which is what
-- `resolvePrimeBackendRef()` does — never fall back to a ref that happens to
-- be reachable. A wrong database is worse than no database.
alter table public.prime_config
  add column if not exists supabase_project_ref text;

comment on column public.prime_config.supabase_project_ref is
  'Supabase project ref of the PRIME PRODUCT backend (e.g. the project holding the cloned application''s schema). Source for catalogue introspection and migration-ledger stamping. Never this deployment''s own project — see resolvePrimeBackendRef().';

-- A project ref is 20 lowercase alphanumerics — the same shape the existing
-- SUPABASE_URL parser accepts. Constraining it here stops a full URL or a
-- display name being pasted into the settings field and only failing later,
-- mid-provision, against the Management API. Deliberately no stricter than
-- the platform: rejecting a ref Supabase considers valid would be worse than
-- accepting a malformed one, which the Management API rejects anyway.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'prime_config_supabase_project_ref_shape'
  ) then
    alter table public.prime_config
      add constraint prime_config_supabase_project_ref_shape
      check (supabase_project_ref is null or supabase_project_ref ~ '^[a-z0-9]{20}$');
  end if;
end $$;
