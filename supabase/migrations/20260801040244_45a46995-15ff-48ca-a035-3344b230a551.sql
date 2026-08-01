CREATE TABLE IF NOT EXISTS public.pricing_module_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('tier', 'module')),
  source_slug text NOT NULL,
  source_name text NOT NULL,
  mapping_kind text NOT NULL DEFAULT 'unmapped'
    CHECK (mapping_kind IN ('installs', 'entitlement', 'unmapped')),
  module_slugs text[] NOT NULL DEFAULT '{}',
  entitlement_key text,
  confidence text NOT NULL DEFAULT 'suggested'
    CHECK (confidence IN ('exact', 'alias', 'suggested', 'manual')),
  reason text,
  is_override boolean NOT NULL DEFAULT false,
  overridden_by uuid REFERENCES auth.users(id),
  overridden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_slug, source_name)
);

CREATE INDEX IF NOT EXISTS idx_pricing_module_map_source
  ON public.pricing_module_map (source_kind, source_slug);
CREATE INDEX IF NOT EXISTS idx_pricing_module_map_unmapped
  ON public.pricing_module_map (mapping_kind) WHERE mapping_kind = 'unmapped';

ALTER TABLE public.pricing_module_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read pricing_module_map" ON public.pricing_module_map;
CREATE POLICY "Operators read pricing_module_map"
  ON public.pricing_module_map FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators write pricing_module_map" ON public.pricing_module_map;
CREATE POLICY "Operators write pricing_module_map"
  ON public.pricing_module_map FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP TRIGGER IF EXISTS pricing_module_map_updated ON public.pricing_module_map;
CREATE TRIGGER pricing_module_map_updated
  BEFORE UPDATE ON public.pricing_module_map
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.clones
  ADD COLUMN IF NOT EXISTS entitled_plan_slug text,
  ADD COLUMN IF NOT EXISTS entitled_module_slugs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS purchased_addon_slugs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS revoked_module_slugs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS entitlement_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS entitlements_synced_at timestamptz;

COMMENT ON COLUMN public.clones.revoked_module_slugs IS
  'Modules installed but no longer entitled after a downgrade. Files are deliberately left in place — the clone gates them by entitlement, so re-upgrading is instant and no in-flight work breaks on a billing event.';

CREATE INDEX IF NOT EXISTS idx_clones_entitled_plan ON public.clones(entitled_plan_slug);

CREATE TABLE IF NOT EXISTS public.clone_entitlement_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  plan_change_event_id uuid,
  from_plan_slug text,
  to_plan_slug text NOT NULL,
  direction text NOT NULL,
  installed_slugs text[] NOT NULL DEFAULT '{}',
  revoked_slugs text[] NOT NULL DEFAULT '{}',
  unchanged_count integer NOT NULL DEFAULT 0,
  unmapped jsonb NOT NULL DEFAULT '[]'::jsonb,
  cascade_event_id uuid,
  ok boolean NOT NULL DEFAULT true,
  error_message text,
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clone_entitlement_recon_clone
  ON public.clone_entitlement_reconciliations (clone_id, created_at DESC);

ALTER TABLE public.clone_entitlement_reconciliations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read entitlement reconciliations"
  ON public.clone_entitlement_reconciliations;
CREATE POLICY "Operators read entitlement reconciliations"
  ON public.clone_entitlement_reconciliations FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators write entitlement reconciliations"
  ON public.clone_entitlement_reconciliations;
CREATE POLICY "Operators write entitlement reconciliations"
  ON public.clone_entitlement_reconciliations FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

ALTER TABLE public.plan_change_events
  ADD COLUMN IF NOT EXISTS modules_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_id uuid;

CREATE INDEX IF NOT EXISTS idx_plan_change_unreconciled
  ON public.plan_change_events (created_at)
  WHERE modules_reconciled_at IS NULL;

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
    RAISE NOTICE 'Vault entry cron_secret not found; skipping entitlement-drain schedule. Add it and re-run.';
    RETURN;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization','Bearer ' || v_secret
  )::text;

  PERFORM cron.unschedule('entitlement-drain-2min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='entitlement-drain-2min');

  PERFORM cron.schedule(
    'entitlement-drain-2min', '*/2 * * * *',
    format($f$SELECT net.http_post(
      url:='https://aurixa-mission-control.lovable.app/hooks/entitlement-drain',
      headers:=%L::jsonb, body:='{}'::jsonb)$f$, v_headers)
  );
END $$;