-- Mirror the cron bearer token between Vault and the database GUCs.
--
-- WHAT THIS FILE USED TO DO, AND WHY IT DOES NOT ANY MORE
-- ------------------------------------------------------
-- This migration originally carried the live `CRON_SECRET` as a string literal
-- and wrote it into both the role-level GUC and Vault. That put a working
-- bearer token for every `/hooks/*` worker into a committed file — readable by
-- anyone with repository access, and permanent, because a value that has been
-- pushed cannot be un-pushed by editing the file. That token has to be treated
-- as compromised and rotated; see docs/SECRET_ROTATION.md.
--
-- A migration is the wrong place for a secret VALUE. Migrations are committed,
-- replayed into every clone backend, and copied into forks. What a migration
-- CAN safely do is what this one now does: take a secret the operator has
-- already supplied out of band and make sure both places that read it agree.
--
-- The two readers, and why both exist:
--   * `app.settings.cron_secret` — read by `current_setting()` inside the
--     migrations that build a cron command string.
--   * `vault.decrypted_secrets` — read at fire time by the command string
--     itself, so rotating the Vault entry re-points every job without
--     rescheduling it.
--
-- Fail-soft by design. A database with neither source set is a database whose
-- operator has not finished setup yet, not a broken one — so this raises a
-- NOTICE and changes nothing. Aborting here would make the whole corpus
-- unreplayable on a fresh backend, which is exactly the failure this
-- repository provisions clone backends by avoiding.
DO $$
DECLARE
  v_secret text;
  v_url    text;
  v_have_vault boolean := EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault');
BEGIN
  -- Prefer Vault, fall back to the GUC. Whichever exists is the source.
  IF v_have_vault THEN
    SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1;
  END IF;

  v_secret := COALESCE(v_secret, NULLIF(current_setting('app.settings.cron_secret', true), ''));
  v_url    := COALESCE(v_url,    NULLIF(current_setting('app.settings.public_app_url', true), ''));

  IF v_secret IS NULL THEN
    RAISE NOTICE
      'cron_secret not configured. Set it once, out of band, then re-run this migration:'
      '  SELECT vault.create_secret(''<CRON_SECRET>'', ''cron_secret'');';
  END IF;

  -- Mirror into the role GUCs so current_setting() sees the same value.
  IF v_secret IS NOT NULL OR v_url IS NOT NULL THEN
    BEGIN
      IF v_url IS NOT NULL THEN
        EXECUTE format('ALTER ROLE postgres IN DATABASE %I SET app.settings.public_app_url = %L',
                       current_database(), v_url);
      END IF;
      IF v_secret IS NOT NULL THEN
        EXECUTE format('ALTER ROLE postgres IN DATABASE %I SET app.settings.cron_secret = %L',
                       current_database(), v_secret);
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'role-level GUCs not permitted here; Vault remains the source';
    END;
  END IF;

  -- Mirror the other way, so a GUC-only deployment still has a Vault entry for
  -- the cron command strings to read at fire time.
  IF v_have_vault AND v_secret IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_secret') THEN
      PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'cron_secret'), v_secret);
    ELSE
      PERFORM vault.create_secret(v_secret, 'cron_secret',
        'Shared bearer token for pg_cron -> Mission Control hooks');
    END IF;
  END IF;

  IF v_have_vault AND v_url IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'public_app_url') THEN
      PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'public_app_url'), v_url);
    ELSE
      PERFORM vault.create_secret(v_url, 'public_app_url',
        'Mission Control public base URL for cron HTTP calls');
    END IF;
  END IF;
END $$;
