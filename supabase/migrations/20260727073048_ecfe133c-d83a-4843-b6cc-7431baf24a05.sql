ALTER TABLE public.codex_remediations
  ADD COLUMN IF NOT EXISTS cascade_event_id uuid NULL
    REFERENCES public.cascade_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_codex_remediations_cascade_event
  ON public.codex_remediations(cascade_event_id)
  WHERE cascade_event_id IS NOT NULL;