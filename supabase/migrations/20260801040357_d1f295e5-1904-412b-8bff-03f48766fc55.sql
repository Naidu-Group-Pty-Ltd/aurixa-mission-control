CREATE TABLE IF NOT EXISTS public.clone_addon_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  addon_slug text NOT NULL,
  addon_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending', 'past_due', 'cancelled')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  stripe_subscription_id text,
  stripe_subscription_item_id text,
  stripe_price_id text,
  unit_amount_cents integer,
  currency text NOT NULL DEFAULT 'AUD',
  purchased_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  current_period_end timestamptz,
  source text NOT NULL DEFAULT 'operator'
    CHECK (source IN ('operator', 'stripe', 'storefront', 'backfill')),
  external_ref text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clone_addon_live
  ON public.clone_addon_purchases (clone_id, addon_slug)
  WHERE status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS uq_clone_addon_external_ref
  ON public.clone_addon_purchases (external_ref)
  WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clone_addon_stripe_item
  ON public.clone_addon_purchases (stripe_subscription_item_id)
  WHERE stripe_subscription_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clone_addon_clone
  ON public.clone_addon_purchases (clone_id, status);
CREATE INDEX IF NOT EXISTS idx_clone_addon_slug
  ON public.clone_addon_purchases (addon_slug) WHERE status = 'active';

ALTER TABLE public.clone_addon_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read clone_addon_purchases" ON public.clone_addon_purchases;
CREATE POLICY "Operators read clone_addon_purchases"
  ON public.clone_addon_purchases FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators write clone_addon_purchases" ON public.clone_addon_purchases;
CREATE POLICY "Operators write clone_addon_purchases"
  ON public.clone_addon_purchases FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP TRIGGER IF EXISTS clone_addon_purchases_updated ON public.clone_addon_purchases;
CREATE TRIGGER clone_addon_purchases_updated
  BEFORE UPDATE ON public.clone_addon_purchases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.sync_clone_purchased_addons()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_clone uuid;
BEGIN
  target_clone := COALESCE(NEW.clone_id, OLD.clone_id);

  UPDATE public.clones c
     SET purchased_addon_slugs = COALESCE((
           SELECT array_agg(DISTINCT p.addon_slug ORDER BY p.addon_slug)
             FROM public.clone_addon_purchases p
            WHERE p.clone_id = target_clone
              AND p.status IN ('active', 'past_due')
         ), '{}')
   WHERE c.id = target_clone;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS clone_addon_purchases_sync ON public.clone_addon_purchases;
CREATE TRIGGER clone_addon_purchases_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.clone_addon_purchases
  FOR EACH ROW EXECUTE FUNCTION public.sync_clone_purchased_addons();

COMMENT ON COLUMN public.clones.purchased_addon_slugs IS
  'DERIVED — maintained by the clone_addon_purchases trigger. Do not write directly; insert a purchase row instead.';

INSERT INTO public.clone_addon_purchases (clone_id, addon_slug, addon_name, status, source, notes)
SELECT c.id,
       unnested_slug,
       am.name,
       'active',
       'backfill',
       'Lifted from clones.purchased_addon_slugs when the purchase table landed'
  FROM public.clones c
  CROSS JOIN LATERAL unnest(c.purchased_addon_slugs) AS t(unnested_slug)
  LEFT JOIN public.addon_modules am ON am.slug = unnested_slug
 WHERE c.purchased_addon_slugs IS NOT NULL
   AND array_length(c.purchased_addon_slugs, 1) > 0
ON CONFLICT DO NOTHING;