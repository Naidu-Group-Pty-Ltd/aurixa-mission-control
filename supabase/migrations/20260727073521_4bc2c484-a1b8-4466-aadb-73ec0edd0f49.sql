ALTER TABLE public.prime_config
  ADD COLUMN IF NOT EXISTS codex_nightly_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS codex_nightly_cron TEXT NOT NULL DEFAULT '0 7 * * *',
  ADD COLUMN IF NOT EXISTS codex_pr_scan_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS codex_post_merge_revalidate BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS codex_scan_dedup_hours INTEGER NOT NULL DEFAULT 6;

ALTER TABLE public.clones
  ADD COLUMN IF NOT EXISTS codex_nightly_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_codex_scan_jobs_target_kind_created
  ON public.codex_scan_jobs(target_kind, clone_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_codex_scan_jobs_repo_created
  ON public.codex_scan_jobs(repo_full_name, created_at DESC);

DO $$
DECLARE
  v_secret TEXT;
  v_headers TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'Vault entry cron_secret not found; skipping codex-nightly schedule. Add it and re-run.';
    RETURN;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization','Bearer ' || v_secret
  )::text;

  PERFORM cron.unschedule('codex-security-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='codex-security-nightly');

  PERFORM cron.schedule(
    'codex-security-nightly', '0 7 * * *',
    format($f$SELECT net.http_post(
      url:='https://aurixa-mission-control.lovable.app/hooks/codex-nightly',
      headers:=%L::jsonb, body:='{}'::jsonb)$f$, v_headers)
  );
END $$;