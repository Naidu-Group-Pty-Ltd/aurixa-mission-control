ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS application_id TEXT;

COMMENT ON COLUMN public.waitlist_leads.application_id IS
  'Public application reference issued at Stage 1 (AX-XXXXXXXXXX). The join key across Stage 1/2/3 and the Airtable operations record.';

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_application_id_key
  ON public.waitlist_leads (application_id)
  WHERE application_id IS NOT NULL;

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS form_version           TEXT,
  ADD COLUMN IF NOT EXISTS role                   TEXT,
  ADD COLUMN IF NOT EXISTS primary_areas          TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS additional_notes       TEXT,
  ADD COLUMN IF NOT EXISTS privacy_acknowledged   BOOLEAN,
  ADD COLUMN IF NOT EXISTS privacy_notice_version TEXT,
  ADD COLUMN IF NOT EXISTS marketing_consent      BOOLEAN;

COMMENT ON COLUMN public.waitlist_leads.primary_areas IS
  'Stage 1 "Primary Areas to Improve" slugs (max 3). Slugs are stable; labels may be reworded.';
COMMENT ON COLUMN public.waitlist_leads.marketing_consent IS
  'Optional marketing opt-in, recorded separately from the application itself. NULL means the submission predates consent capture — treat as "no".';

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS landing_page  TEXT,
  ADD COLUMN IF NOT EXISTS referrer      TEXT,
  ADD COLUMN IF NOT EXISTS utm_source    TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium    TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
  ADD COLUMN IF NOT EXISTS utm_term      TEXT,
  ADD COLUMN IF NOT EXISTS utm_content   TEXT;

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage SMALLINT NOT NULL DEFAULT 1
    CONSTRAINT waitlist_leads_stage_range CHECK (stage BETWEEN 1 AND 3);

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage_dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_stage_dedupe_key
  ON public.waitlist_leads (stage_dedupe_key)
  WHERE stage_dedupe_key IS NOT NULL;

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage2_status       TEXT,
  ADD COLUMN IF NOT EXISTS stage2_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage2_access_mode  TEXT,
  ADD COLUMN IF NOT EXISTS stage2_next_step    TEXT,
  ADD COLUMN IF NOT EXISTS stage2_investment   TEXT,
  ADD COLUMN IF NOT EXISTS stage2_timeline     TEXT;

COMMENT ON COLUMN public.waitlist_leads.stage2_next_step IS
  'The applicant''s own "Preferred Next Step" answer — the strongest buying signal Stage 2 collects.';

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage3_status        TEXT,
  ADD COLUMN IF NOT EXISTS stage3_booked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage3_session_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage3_session_end   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage3_access_mode   TEXT,
  ADD COLUMN IF NOT EXISTS stage3_time_zone     TEXT;

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS airtable_record_id TEXT,
  ADD COLUMN IF NOT EXISTS airtable_status    TEXT,
  ADD COLUMN IF NOT EXISTS synced_at          TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_airtable_record_id_key
  ON public.waitlist_leads (airtable_record_id)
  WHERE airtable_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_waitlist_leads_stage
  ON public.waitlist_leads (stage DESC, created_at DESC);

UPDATE public.waitlist_leads
   SET application_id = upper(metadata #>> '{applicationId}')
 WHERE application_id IS NULL
   AND metadata #>> '{applicationId}' ~ '^[Aa][Xx]-[A-Za-z0-9]{10}$'
   AND NOT EXISTS (
     SELECT 1 FROM public.waitlist_leads other
      WHERE other.application_id = upper(waitlist_leads.metadata #>> '{applicationId}')
   );

UPDATE public.waitlist_leads
   SET form_version           = COALESCE(form_version, metadata #>> '{formVersion}'),
       role                   = COALESCE(role, metadata #>> '{role}'),
       additional_notes       = COALESCE(additional_notes, metadata #>> '{additionalNotes}'),
       privacy_notice_version = COALESCE(privacy_notice_version, metadata #>> '{privacyNoticeVersion}'),
       privacy_acknowledged   = COALESCE(privacy_acknowledged, (metadata #> '{privacyAcknowledged}')::boolean),
       marketing_consent      = COALESCE(marketing_consent, (metadata #> '{marketingConsent}')::boolean),
       landing_page           = COALESCE(landing_page, metadata #>> '{landingPage}'),
       referrer               = COALESCE(referrer, metadata #>> '{referrer}'),
       utm_source             = COALESCE(utm_source, metadata #>> '{utmSource}'),
       utm_medium             = COALESCE(utm_medium, metadata #>> '{utmMedium}'),
       utm_campaign           = COALESCE(utm_campaign, metadata #>> '{utmCampaign}'),
       utm_term               = COALESCE(utm_term, metadata #>> '{utmTerm}'),
       utm_content            = COALESCE(utm_content, metadata #>> '{utmContent}')
 WHERE metadata <> '{}'::jsonb;

UPDATE public.waitlist_leads
   SET primary_areas = ARRAY(
         SELECT jsonb_array_elements_text(metadata #> '{primaryAreasToImprove}')
       )
 WHERE primary_areas = '{}'
   AND jsonb_typeof(metadata #> '{primaryAreasToImprove}') = 'array';

CREATE OR REPLACE FUNCTION public.crm_convert_lead(_lead_id UUID, _owner UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _lead public.waitlist_leads%ROWTYPE; _account_id UUID;
BEGIN
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator required';
  END IF;

  SELECT * INTO _lead FROM public.waitlist_leads WHERE id = _lead_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'lead_not_found'); END IF;
  IF _lead.account_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'account_id', _lead.account_id);
  END IF;

  INSERT INTO public.crm_accounts (name, classification, lifecycle_stage, owner_user_id, source, created_by, metadata)
  VALUES (
    COALESCE(NULLIF(_lead.entity_name, ''), _lead.first_name || ' ' || _lead.last_name),
    _lead.entity_classification,
    'opportunity',
    COALESCE(_owner, auth.uid()),
    COALESCE(_lead.source, 'waitlist'),
    auth.uid(),
    jsonb_strip_nulls(jsonb_build_object(
      'lead_id',                _lead.id,
      'application_id',         _lead.application_id,
      'transaction_volume',     _lead.transaction_volume,
      'tech_stack_bottlenecks', _lead.tech_stack_bottlenecks,
      'role',                   _lead.role,
      'primary_areas',          to_jsonb(_lead.primary_areas),
      'form_version',           _lead.form_version,
      'marketing_consent',      _lead.marketing_consent,
      'stage_reached',          _lead.stage,
      'stage2_status',          _lead.stage2_status,
      'stage2_completed_at',    _lead.stage2_completed_at,
      'stage2_next_step',       _lead.stage2_next_step,
      'stage2_investment',      _lead.stage2_investment,
      'stage2_timeline',        _lead.stage2_timeline,
      'stage3_status',          _lead.stage3_status,
      'stage3_session_start',   _lead.stage3_session_start,
      'attribution', jsonb_strip_nulls(jsonb_build_object(
        'landing_page', _lead.landing_page,
        'referrer',     _lead.referrer,
        'utm_source',   _lead.utm_source,
        'utm_medium',   _lead.utm_medium,
        'utm_campaign', _lead.utm_campaign,
        'utm_term',     _lead.utm_term,
        'utm_content',  _lead.utm_content
      ))
    ))
  )
  RETURNING id INTO _account_id;

  INSERT INTO public.crm_contacts (account_id, first_name, last_name, email, phone, is_primary, marketing_consent)
  VALUES (_account_id, _lead.first_name, _lead.last_name, _lead.email, _lead.mobile_number, true,
          COALESCE(_lead.marketing_consent, false));

  INSERT INTO public.crm_activities (account_id, kind, title, body, occurred_at, actor_user_id, entity_type, entity_id, metadata)
  VALUES (_account_id, 'system',
          'Stage 1 — priority access application' ||
            COALESCE(' (' || _lead.application_id || ')', ''),
          _lead.first_name || ' ' || _lead.last_name || ' · ' || _lead.email,
          COALESCE(_lead.submitted_at, _lead.created_at),
          auth.uid(), 'waitlist_lead', _lead.id,
          jsonb_strip_nulls(jsonb_build_object('application_id', _lead.application_id, 'stage', 1)));

  IF _lead.stage2_completed_at IS NOT NULL THEN
    INSERT INTO public.crm_activities (account_id, kind, title, body, occurred_at, actor_user_id, entity_type, entity_id, metadata)
    VALUES (_account_id, 'system', 'Stage 2 — business readiness questionnaire completed',
            concat_ws(' · ',
              NULLIF('Next step: ' || COALESCE(_lead.stage2_next_step, ''), 'Next step: '),
              NULLIF('Investment: ' || COALESCE(_lead.stage2_investment, ''), 'Investment: '),
              NULLIF('Timeline: ' || COALESCE(_lead.stage2_timeline, ''), 'Timeline: ')),
            _lead.stage2_completed_at, auth.uid(), 'waitlist_lead', _lead.id,
            jsonb_strip_nulls(jsonb_build_object('application_id', _lead.application_id, 'stage', 2)));
  END IF;

  IF _lead.stage3_booked_at IS NOT NULL THEN
    INSERT INTO public.crm_activities (account_id, kind, title, body, occurred_at, actor_user_id, entity_type, entity_id, metadata)
    VALUES (_account_id, 'meeting', 'Stage 3 — strategic review booked',
            concat_ws(' · ',
              NULLIF('Session: ' || COALESCE(_lead.stage3_session_start::text, ''), 'Session: '),
              NULLIF('Status: ' || COALESCE(_lead.stage3_status, ''), 'Status: ')),
            _lead.stage3_booked_at, auth.uid(), 'waitlist_lead', _lead.id,
            jsonb_strip_nulls(jsonb_build_object('application_id', _lead.application_id, 'stage', 3)));
  END IF;

  INSERT INTO public.crm_deals (account_id, name, stage, owner_user_id)
  VALUES (_account_id, COALESCE(NULLIF(_lead.entity_name, ''), _lead.email) || ' — new business',
          CASE WHEN _lead.stage3_booked_at IS NOT NULL THEN 'demo'::crm_deal_stage
               ELSE 'discovery'::crm_deal_stage END,
          COALESCE(_owner, auth.uid()));

  UPDATE public.waitlist_leads
     SET account_id = _account_id,
         status = CASE WHEN status = 'new' THEN 'qualified'::lead_status ELSE status END
   WHERE id = _lead_id;

  RETURN jsonb_build_object('ok', true, 'account_id', _account_id);
END $$;