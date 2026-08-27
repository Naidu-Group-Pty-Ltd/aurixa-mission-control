-- Client agreements — Service Level Agreements sent for signature via
-- DocuSign, mirroring the prime repo's manage-agency-agreements lifecycle
-- (draft → sent → delivered → signed / declined / voided).
--
-- Two inherited rules are load-bearing:
--   * status and docusign_status are TEXT — DocuSign's envelope vocabulary
--     is theirs to extend, and a stale CHECK constraint silently failing a
--     status write is the exact bug the voice ledger's history warns about.
--   * the agreement is linked to the CRM (contact + account), because the
--     whole point is that a converted lead's paperwork lives on the same
--     client timeline as their calls and journey.

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'agreement_signed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'agreement_declined';

CREATE TABLE IF NOT EXISTS public.client_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_org TEXT,
  service_tier TEXT,
  commencement_date DATE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  docusign_envelope_id TEXT UNIQUE,
  docusign_status TEXT,
  docusign_sent_at TIMESTAMPTZ,
  docusign_signed_at TIMESTAMPTZ,
  docusign_voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_agreements TO authenticated;
ALTER TABLE public.client_agreements ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_client_agreements_contact ON public.client_agreements (contact_id);
CREATE INDEX IF NOT EXISTS idx_client_agreements_account ON public.client_agreements (account_id);
CREATE INDEX IF NOT EXISTS idx_client_agreements_status ON public.client_agreements (status);
CREATE INDEX IF NOT EXISTS idx_client_agreements_created ON public.client_agreements (created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_agreements']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_operator_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_operator_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()))',
      t || '_operator_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) WITH CHECK (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()))',
      t || '_operator_write', t);
  END LOOP;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_agreements']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'set_updated_at_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
      'set_updated_at_' || t, t);
  END LOOP;
END $$;
