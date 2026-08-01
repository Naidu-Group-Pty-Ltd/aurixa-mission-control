-- Per-clone add-on purchases.
--
-- `clones.purchased_addon_slugs` was a placeholder: a text[] an operator kept
-- by hand. It answered "which add-ons does this clone have" and nothing else —
-- not when they were bought, not which Stripe subscription item backs them,
-- not whether one lapsed. A cancellation was indistinguishable from a typo.
--
-- The `purchases` table already exists but records *events*: a row says
-- "this was bought at time T", which is exactly right for revenue and exactly
-- wrong for entitlement. Purchases are never retracted, so a cancelled add-on
-- still has its purchase row and would keep entitling code forever.
--
-- This table is current *state*: one row per add-on a clone holds, with a
-- status lifecycle, so entitlement resolution can ask "what is active right
-- now" and get an answer that survives cancellation and payment failure.
--
-- `stripe-module-sync` already gives every add-on a recurring price and adds it
-- to an existing subscription, so the Stripe columns here are subscription-item
-- shaped. A line-item sync writes them and nothing else in the system changes.

CREATE TABLE IF NOT EXISTS public.clone_addon_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  -- Denormalised from the clone so a Stripe sync keyed on tenant can write
  -- without a second lookup. Nullable: a clone can hold add-ons before its
  -- billing tenant exists.
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,

  -- Priced module slug from the Aurixa catalogue (`addon_modules.slug`).
  addon_slug text NOT NULL,
  -- Snapshot of the display name at purchase time, so renaming a catalogue
  -- entry does not rewrite history.
  addon_name text,

  -- active   — entitles code
  -- pending  — checkout started, not yet confirmed
  -- past_due — payment failed; still entitled during the grace period so a
  --            card problem does not instantly strip a customer's features
  -- cancelled— no longer entitles; kept for history
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending', 'past_due', 'cancelled')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),

  -- ── Stripe linkage ──
  -- Add-ons are recurring items on an existing subscription (see
  -- stripe-module-sync), so the item id is the durable handle, not the
  -- subscription.
  stripe_subscription_id text,
  stripe_subscription_item_id text,
  stripe_price_id text,
  unit_amount_cents integer,
  currency text NOT NULL DEFAULT 'AUD',

  -- ── Lifecycle ──
  purchased_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  current_period_end timestamptz,

  -- Who wrote this row. 'backfill' marks rows lifted from the old text[].
  source text NOT NULL DEFAULT 'operator'
    CHECK (source IN ('operator', 'stripe', 'storefront', 'backfill')),
  -- Idempotency handle for the writer. A replayed Stripe webhook carrying the
  -- same subscription item must update its row, never create a second one.
  external_ref text,

  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A clone holds an add-on at most once while it is live. Cancelled rows are
-- excluded so the same add-on can be re-purchased later without colliding with
-- its own history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clone_addon_live
  ON public.clone_addon_purchases (clone_id, addon_slug)
  WHERE status <> 'cancelled';

-- Webhook replay protection. Partial so the many rows without a ref (operator
-- grants) do not collide on NULL.
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

-- ── Keep the old column as a derived cache ───────────────────────────
--
-- `clones.purchased_addon_slugs` stays, but stops being authored. A trigger
-- recomputes it from this table so existing readers keep working and the two
-- can never drift — the alternative, updating both from application code, is
-- exactly how they would.
--
-- `past_due` counts as entitling: a failed card should not strip features
-- mid-period. Dunning decides when it becomes 'cancelled'.

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

-- ── Backfill ─────────────────────────────────────────────────────────
-- Lift whatever operators set by hand into real rows, so nothing is lost when
-- the column stops being authored. Marked source='backfill' and left without a
-- Stripe link, which is the truth: we know the clone has the add-on, not what
-- pays for it.

INSERT INTO public.clone_addon_purchases (clone_id, addon_slug, addon_name, status, source, notes)
SELECT c.id,
       slug,
       am.name,
       'active',
       'backfill',
       'Lifted from clones.purchased_addon_slugs when the purchase table landed'
  FROM public.clones c
  CROSS JOIN LATERAL unnest(c.purchased_addon_slugs) AS slug
  LEFT JOIN public.addon_modules am ON am.slug = slug
 WHERE c.purchased_addon_slugs IS NOT NULL
   AND array_length(c.purchased_addon_slugs, 1) > 0
ON CONFLICT DO NOTHING;
