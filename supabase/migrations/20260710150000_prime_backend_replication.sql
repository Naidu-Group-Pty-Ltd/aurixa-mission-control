-- Prime backend replication report columns.
-- Clone backends are now structural replicas of the prime repo's Supabase
-- architecture; record what was replicated and from where.
ALTER TABLE public.clone_backends
  ADD COLUMN IF NOT EXISTS source_repo text,
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS source_sha text,
  ADD COLUMN IF NOT EXISTS migrations_applied jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS edge_functions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS secret_shells jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.clone_backends.source_repo IS 'Prime repo the backend architecture was replicated from (owner/repo)';
COMMENT ON COLUMN public.clone_backends.source_sha IS 'Prime commit SHA of the replicated snapshot';
COMMENT ON COLUMN public.clone_backends.migrations_applied IS 'Replay results for each prime migration (id, name, success, skipped, error)';
COMMENT ON COLUMN public.clone_backends.edge_functions IS 'Deploy results for each prime edge function (slug, success, error)';
COMMENT ON COLUMN public.clone_backends.secret_shells IS 'Empty-shell secret names created on the clone project — names only, never values';

-- Refresh the credential-free projection with the new report columns.
-- (secret_shells holds names only; still excludes anon/service_role/db_pass.)
--
-- DROP then CREATE, not CREATE OR REPLACE. Replace can only APPEND columns to
-- an existing view; this one inserts six in the middle, so against the June
-- definition it fails with "cannot change name of view column". That aborted
-- migration replay at this file — and `applyPrimeMigrations` halts on the first
-- failure, so every clone backend provisioned since stopped here with 75 of the
-- schema's tables and none of the 123 migrations that follow.
drop view if exists public.clone_backends_safe cascade;
create view public.clone_backends_safe
with (security_invoker = true)
as
select
  id,
  clone_id,
  supabase_project_ref,
  supabase_url,
  region,
  admin_email,
  migration_version,
  status,
  error_message,
  status_detail,
  source_repo,
  source_ref,
  source_sha,
  migrations_applied,
  edge_functions,
  secret_shells,
  created_at,
  updated_at
from public.clone_backends;

grant select on public.clone_backends_safe to authenticated;
