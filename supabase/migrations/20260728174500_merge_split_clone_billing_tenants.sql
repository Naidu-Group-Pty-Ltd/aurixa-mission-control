-- Reunite top-up credits with the balance the workspace actually spends from.
--
-- A clone meters under `prime:<its-supabase-project-ref>` — that tenant_ref is
-- baked into every clone's token client — but `?uid=`-scoped checkout resolved
-- its tenant with `ensureTenant(clone_id, 'clone:<slug>')`. `ensureTenant`
-- matches on (external_ref, clone_id), so that provisioned a SECOND tenant for
-- the clone and credited the top-up there, while the clone kept reserving and
-- spending against the first. Stripe took the money, the ledger row landed,
-- and the workspace's balance never moved.
--
-- The code fix (billing-tenant.server.ts) makes future purchases reuse the
-- clone's existing tenant. This migration repairs the ones already split.
--
-- Deliberately conservative. A duplicate tenant is only merged when it is
-- *provably* an artefact of the bug rather than a workspace in its own right:
--
--   • the clone has exactly one metering tenant (`prime:%`) — no ambiguity
--     about where the credits belong, and
--   • the duplicate has NO reserve/debit/release history — nothing was ever
--     metered against it, so it exists only because checkout created it, and
--   • the duplicate holds credit worth moving.
--
-- Anything else is left alone and reported via RAISE NOTICE, because a
-- duplicate with real spend history is a genuine second workspace and merging
-- it would corrupt two balances instead of fixing one.
--
-- Ledger rows keep their identity: they are re-pointed, not recreated, and
-- stamped with a metadata marker that makes the move auditable and the
-- migration idempotent.

DO $$
DECLARE
  _dup     RECORD;
  _target  UUID;
  _moved   INTEGER;
  _targets INTEGER;
BEGIN
  FOR _dup IN
    SELECT t.id, t.clone_id, t.external_ref, t.display_name
      FROM public.tenants t
     WHERE t.clone_id IS NOT NULL
       AND t.external_ref NOT LIKE 'prime:%'
       -- Nothing was ever metered here → not a workspace, just a checkout artefact.
       AND NOT EXISTS (
         SELECT 1 FROM public.token_ledger l
          WHERE l.tenant_id = t.id
            AND l.kind IN ('reserve', 'debit', 'release')
       )
       -- Only worth touching if it actually holds credit.
       AND EXISTS (
         SELECT 1 FROM public.token_ledger l
          WHERE l.tenant_id = t.id
            AND l.kind IN ('grant', 'topup', 'refund', 'adjustment')
       )
  LOOP
    SELECT COUNT(*) INTO _targets
      FROM public.tenants p
     WHERE p.clone_id = _dup.clone_id
       AND p.external_ref LIKE 'prime:%';

    IF _targets <> 1 THEN
      RAISE NOTICE 'Skipping tenant % (clone %): found % metering tenants, expected exactly 1.',
        _dup.id, _dup.clone_id, _targets;
      CONTINUE;
    END IF;

    SELECT p.id INTO _target
      FROM public.tenants p
     WHERE p.clone_id = _dup.clone_id
       AND p.external_ref LIKE 'prime:%'
     LIMIT 1;

    UPDATE public.token_ledger
       SET tenant_id = _target,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'merged_from_tenant_id', _dup.id::text,
                  'merged_from_external_ref', _dup.external_ref,
                  'merged_reason', 'split_clone_billing_tenant',
                  'merged_at', now()
                )
     WHERE tenant_id = _dup.id
       AND (metadata ->> 'merged_reason') IS DISTINCT FROM 'split_clone_billing_tenant';
    GET DIAGNOSTICS _moved = ROW_COUNT;

    -- Re-point the purchase and job history too, so the ledger and the
    -- receipts a customer can see agree on who bought what.
    UPDATE public.purchases   SET tenant_id = _target WHERE tenant_id = _dup.id;
    UPDATE public.report_jobs SET tenant_id = _target WHERE tenant_id = _dup.id;

    -- The emptied tenant is retired rather than deleted: its id may appear in
    -- Stripe metadata on past sessions, and a dangling reference that resolves
    -- to nothing is harder to diagnose than one that resolves to a marked row.
    UPDATE public.tenants
       SET display_name = COALESCE(display_name, '') || ' (merged)',
           external_ref = _dup.external_ref || ':merged:' || _dup.id::text
     WHERE id = _dup.id
       AND external_ref NOT LIKE '%:merged:%';

    PERFORM public.recompute_token_balance(_target);
    PERFORM public.recompute_token_balance(_dup.id);

    RAISE NOTICE 'Merged % ledger rows from tenant % (%) into metering tenant %.',
      _moved, _dup.id, _dup.external_ref, _target;
  END LOOP;
END;
$$;
