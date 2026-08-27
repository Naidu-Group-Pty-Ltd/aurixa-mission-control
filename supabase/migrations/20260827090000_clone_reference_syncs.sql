-- Reference-data seeding: the step between "the clone has 641 tables" and
-- "the clone can render a report".
--
-- `provisionCloneBackend` promises "Structure only — no data ever leaves the
-- prime", which is why a fresh clone holds 641 tables and nothing in them. That
-- default is right for tenant data and wrong for the seeded catalogue: the 500
-- Investment Compass masters and 43 voice templates in
-- `template_library_entries` are DATA, and no document can be drawn without
-- them. So is the suburb directory, and so are the depreciation comparables.
--
-- The allow-list itself lives in `src/server/referenceTables.pure.ts` and
-- nowhere else. This table only records how far a clone has got, per table, so
-- a copy that outlives one invocation can be resumed rather than restarted —
-- the same reason the investment-report generator banks a section index.
--
-- WHY A SEPARATE CLAIM COLUMN. `clone_backends.worker_started_at` is the fleet
-- migration sync's claim. Sharing it would mean each worker's release clears
-- the other's claim, and the failure is invisible: two runs copying the same
-- page concurrently is idempotent (`on conflict do nothing`), so it would look
-- like it worked while quietly doubling the prime's read load. Reference
-- seeding gets its own column, and both workers still require `status =
-- 'ready'`, so neither one runs against a schema that is mid-migration.

-- ── Per-clone, per-table progress ───────────────────────────────────────────
create table if not exists public.clone_reference_syncs (
  clone_id uuid not null references public.clones(id) on delete cascade,
  table_name text not null,
  -- Keyset cursor: the last `pageKey` copied, as text. NULL means "not started".
  -- Text rather than the source type because the allow-list pages uuid, bigint
  -- and text keys through one column, and `::text` ordering is stable for all
  -- three as long as the copier orders by the same expression — which it does.
  cursor text,
  rows_copied integer not null default 0,
  -- What the prime held when the copy last counted. Nullable because a table
  -- the clone does not have is never counted, and 0 would read as "empty on the
  -- prime", which is a different fact with a different remedy.
  source_rows integer,
  status text not null default 'pending'
    check (status in ('pending', 'copying', 'complete', 'skipped', 'failed')),
  detail text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (clone_id, table_name)
);

comment on table public.clone_reference_syncs is
  'Per-clone, per-table progress of the prime->clone reference-data copy. The '
  'set of tables that may be copied is NOT here — it is the allow-list in '
  'src/server/referenceTables.pure.ts. A row here is a record of work, never a '
  'grant of permission.';

create index if not exists clone_reference_syncs_clone_idx
  on public.clone_reference_syncs (clone_id);
create index if not exists clone_reference_syncs_incomplete_idx
  on public.clone_reference_syncs (clone_id) where status <> 'complete';

grant select on public.clone_reference_syncs to authenticated;
grant all on public.clone_reference_syncs to service_role;
alter table public.clone_reference_syncs enable row level security;
drop policy if exists "clone_reference_syncs_read" on public.clone_reference_syncs;
create policy "clone_reference_syncs_read" on public.clone_reference_syncs
for select to authenticated using (public.is_admin(auth.uid()));
drop policy if exists "clone_reference_syncs_write" on public.clone_reference_syncs;
create policy "clone_reference_syncs_write" on public.clone_reference_syncs
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- ── The claim ───────────────────────────────────────────────────────────────
alter table public.clone_backends
  add column if not exists reference_sync_started_at timestamptz;

comment on column public.clone_backends.reference_sync_started_at is
  'Claim held by the reference-data seeding worker. Deliberately NOT '
  'worker_started_at, which the fleet migration sync owns — sharing one column '
  'lets each worker''s release clear the other''s claim.';

-- ── Schedule ────────────────────────────────────────────────────────────────
-- Hourly, not every few minutes. Seeding a clone is a one-off that finishes and
-- then costs one cheap "already complete" read per tick forever after; the only
-- work it picks up later is a NEW clone, and a clone that has just been
-- provisioned is not rendering reports in its first hour.
--
-- 120s rather than the fleet sync's 60s: a page of `template_library_entries`
-- is ~440 KB and the worker deliberately runs to a wall-clock budget and gets
-- resumed, so the request is expected to be long rather than expected to be
-- quick. The budget inside the handler is set below this, so the worker stops
-- itself rather than being cut off mid-page.
--
-- The secret is read from the vault INSIDE the command, per run, like every
-- other healthy job here — a rotation needs no reschedule and a missing secret
-- surfaces as a 401 in net._http_response rather than as a job that quietly
-- declined to schedule.
DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'reference-data-sync-hourly' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('reference-data-sync-hourly')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reference-data-sync-hourly');
    PERFORM cron.schedule(
      'reference-data-sync-hourly',
      '43 * * * *',
      format(
        $f$SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'Lovable-Context','cron',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
          ),
          body := jsonb_build_object('source','pg_cron'),
          timeout_milliseconds := 120000
        )$f$,
        v_base || '/hooks/reference-data-sync'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'reference-data-sync-hourly', v_base;
  END IF;
END $$;
