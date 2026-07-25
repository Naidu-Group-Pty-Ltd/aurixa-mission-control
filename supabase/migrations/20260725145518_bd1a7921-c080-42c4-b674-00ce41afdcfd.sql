
CREATE TABLE IF NOT EXISTS public.payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL,
  stripe_setup_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  brand TEXT,
  last4 TEXT,
  exp_month INTEGER,
  exp_year INTEGER,
  funding TEXT,
  card_fingerprint TEXT,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','detached')),
  origin_user_id UUID,
  origin_username TEXT,
  origin_source TEXT NOT NULL DEFAULT 'unknown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  detached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_priority_active_uidx
  ON public.payment_methods (tenant_id, priority)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_fingerprint_active_uidx
  ON public.payment_methods (tenant_id, card_fingerprint)
  WHERE status = 'active' AND card_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_session_active_uidx
  ON public.payment_methods (stripe_checkout_session_id)
  WHERE status = 'active' AND stripe_checkout_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_methods_tenant_status_idx
  ON public.payment_methods (tenant_id, status);
CREATE INDEX IF NOT EXISTS payment_methods_stripe_pm_idx
  ON public.payment_methods (stripe_payment_method_id);

GRANT ALL ON public.payment_methods TO service_role;

ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_payment_methods"
  ON public.payment_methods
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER update_payment_methods_updated_at
  BEFORE UPDATE ON public.payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.reorder_payment_methods(
  _tenant_id UUID,
  _ordered_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _existing_count INT;
  _incoming_count INT := COALESCE(array_length(_ordered_ids, 1), 0);
  _id UUID;
  _i INT;
BEGIN
  IF _incoming_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_order');
  END IF;
  IF _incoming_count > 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_ids');
  END IF;

  -- Serialize concurrent reorders for this tenant.
  PERFORM pg_advisory_xact_lock(hashtextextended('payment_methods_reorder:' || _tenant_id::text, 0));

  SELECT COUNT(*) INTO _existing_count
    FROM public.payment_methods
   WHERE tenant_id = _tenant_id AND status = 'active';

  IF _existing_count <> _incoming_count THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_mismatch',
      'expected', _existing_count, 'received', _incoming_count);
  END IF;

  -- Validate every id belongs to this tenant + active.
  IF EXISTS (
    SELECT 1 FROM unnest(_ordered_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.payment_methods pm
       WHERE pm.id = u.id AND pm.tenant_id = _tenant_id AND pm.status = 'active'
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_id');
  END IF;

  -- Two-phase rewrite: shift to negative slots to dodge the unique index,
  -- then assign final 1..N ordering.
  _i := 1;
  FOREACH _id IN ARRAY _ordered_ids LOOP
    UPDATE public.payment_methods
       SET priority = -_i, updated_at = now()
     WHERE id = _id;
    _i := _i + 1;
  END LOOP;

  _i := 1;
  FOREACH _id IN ARRAY _ordered_ids LOOP
    UPDATE public.payment_methods
       SET priority = _i, updated_at = now()
     WHERE id = _id;
    _i := _i + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'count', _incoming_count);
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_payment_methods(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_payment_methods(UUID, UUID[]) TO service_role;
