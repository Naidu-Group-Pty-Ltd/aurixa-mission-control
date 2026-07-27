-- Bridge columns
ALTER TABLE public.security_findings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'partner',
  ADD COLUMN IF NOT EXISTS codex_finding_id uuid REFERENCES public.codex_findings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS remediation_pr_url text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_security_findings_codex_mirror
  ON public.security_findings(assessment_id, codex_finding_id)
  WHERE codex_finding_id IS NOT NULL;

-- Keep Codex state aligned when partner triages the mirrored finding
CREATE OR REPLACE FUNCTION public.sync_codex_from_security_finding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.codex_finding_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('resolved', 'accepted_risk', 'false_positive') THEN
    UPDATE public.codex_findings
       SET state = CASE NEW.status
                     WHEN 'resolved'       THEN 'resolved'::codex_finding_state
                     WHEN 'false_positive' THEN 'false_positive'::codex_finding_state
                     WHEN 'accepted_risk'  THEN 'dismissed'::codex_finding_state
                     ELSE state
                   END,
           resolved_at = COALESCE(resolved_at, now()),
           updated_at  = now()
     WHERE id = NEW.codex_finding_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_codex_from_security_finding ON public.security_findings;
CREATE TRIGGER trg_sync_codex_from_security_finding
AFTER INSERT OR UPDATE OF status ON public.security_findings
FOR EACH ROW EXECUTE FUNCTION public.sync_codex_from_security_finding();