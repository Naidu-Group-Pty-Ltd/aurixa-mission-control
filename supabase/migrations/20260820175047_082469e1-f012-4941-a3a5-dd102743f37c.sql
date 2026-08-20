DO $$
DECLARE
  v_secret text := 'iI72oBceNCF2Jz0Wez_ILtarakQ7NryQYsgmwk0mmxf35gDbJi5NbhW6UaEL2Rbl';
  v_url text := 'https://mission-control.aurixasystems.com.au';
BEGIN
  BEGIN
    EXECUTE format('ALTER ROLE postgres IN DATABASE %I SET app.settings.public_app_url = %L', current_database(), v_url);
    EXECUTE format('ALTER ROLE postgres IN DATABASE %I SET app.settings.cron_secret = %L', current_database(), v_secret);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'role-level GUCs not permitted; relying on vault';
  END;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault') THEN
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_secret') THEN
      PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'cron_secret'), v_secret);
    ELSE
      PERFORM vault.create_secret(v_secret, 'cron_secret', 'Shared bearer token for pg_cron -> Mission Control hooks');
    END IF;
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'public_app_url') THEN
      PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'public_app_url'), v_url);
    ELSE
      PERFORM vault.create_secret(v_url, 'public_app_url', 'Mission Control public base URL for cron HTTP calls');
    END IF;
  END IF;
END $$;