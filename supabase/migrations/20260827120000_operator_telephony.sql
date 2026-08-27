-- Operator telephony — the human softphone beside the AI fleet.
--
-- Operators make and receive real phone calls from the browser at
-- /voice/phone, carried by Twilio Voice (the number arrives later; every
-- credential is a Worker env secret and the whole feature reports itself
-- "not configured" until they exist). Two lessons carried over from the
-- voice fleet are load-bearing here:
--   * status is TEXT, not an enum — Twilio's call lifecycle vocabulary
--     (queued, initiated, ringing, in-progress, completed, busy, failed,
--     no-answer, canceled) is theirs to extend, and a stale CHECK constraint
--     silently failing webhook upserts is the exact bug call_outcome's
--     history warns about.
--   * inbound ringing is resolved from a registration table, not a config
--     list — a browser that minted a token recently and left ringing enabled
--     is dialable; anything else is not. Registrations are heartbeat-kept,
--     so a closed laptop stops ringing on its own.

-- ============ NOTIFICATIONS ============
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'phone_missed_call';

-- ============ CALL LEDGER ============
CREATE TABLE IF NOT EXISTS public.phone_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_call_sid TEXT UNIQUE,
  parent_call_sid TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  operator_user_id UUID,
  operator_identity TEXT,
  contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  account_id UUID REFERENCES public.crm_accounts(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'initiated',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  recording_sid TEXT,
  recording_url TEXT,
  recording_duration_seconds INTEGER,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.phone_calls TO authenticated;
CREATE INDEX IF NOT EXISTS idx_phone_calls_contact ON public.phone_calls (contact_id);
CREATE INDEX IF NOT EXISTS idx_phone_calls_account ON public.phone_calls (account_id);
CREATE INDEX IF NOT EXISTS idx_phone_calls_created ON public.phone_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_calls_status ON public.phone_calls (status);
CREATE INDEX IF NOT EXISTS idx_phone_calls_phone ON public.phone_calls (phone_number);

-- ============ BROWSER REGISTRATIONS ============
-- One row per operator softphone identity. Minting a token upserts the row;
-- the phone page heartbeats it; inbound TwiML dials every identity whose
-- heartbeat is fresh and whose ringing is enabled.
CREATE TABLE IF NOT EXISTS public.telephony_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity TEXT UNIQUE NOT NULL,
  user_id UUID NOT NULL,
  display_name TEXT,
  ring_enabled BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telephony_registrations TO authenticated;
CREATE INDEX IF NOT EXISTS idx_telephony_registrations_user ON public.telephony_registrations (user_id);
CREATE INDEX IF NOT EXISTS idx_telephony_registrations_seen ON public.telephony_registrations (last_seen_at DESC);

-- ============ RLS ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['phone_calls','telephony_registrations']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
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

-- ============ updated_at ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['phone_calls','telephony_registrations']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'set_updated_at_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
      'set_updated_at_' || t, t);
  END LOOP;
END $$;
