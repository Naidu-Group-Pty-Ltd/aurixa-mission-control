-- The per-report token cost index.
--
-- `report_credit_costs` has existed since 20260519 but was never seeded, and
-- clones only consulted it when a caller happened to pass a `report_slug`
-- hint. Everything else fell back to the cost table hard-coded in each clone's
-- `_shared/tokenEstimator.ts`, so changing what a report costs meant editing
-- and redeploying every repository.
--
-- This makes the table the actual index: one row per report type a clone can
-- meter, keyed by the SAME string the clone's token client sends as `kind`.
-- The clone resolves its reserve amount from this row, so a value changed here
-- reaches every clone without a deploy.
--
-- Seeded values are exactly what the clones charge today, so nothing moves on
-- deploy — the point of this migration is to make the numbers editable, not to
-- reprice anything. One exception is called out below.

-- ── 1. Seed the index ───────────────────────────────────────────────────────
-- slug == the clone's TokenKind. `metadata.token_kind` restates it so the
-- link survives a slug rename, and `metadata.default_credit_cost` records the
-- shipped default so an operator can always see how far they have drifted.
INSERT INTO public.report_credit_costs
  (slug, name, category, description, credit_cost, sort_order, metadata)
VALUES
  ('report.investment.compass', 'Investment Report — Compass', 'report',
   'Full Compass-40 property investment report.', 12, 10,
   '{"token_kind":"report.investment.compass","default_credit_cost":12,"complexity":"high"}'::jsonb),
  ('report.investment.executive', 'Investment Report — Executive', 'report',
   'Executive-tier property investment report.', 8, 20,
   '{"token_kind":"report.investment.executive","default_credit_cost":8,"complexity":"medium"}'::jsonb),
  ('report.investment.financial', 'Investment Report — Financial Analysis', 'report',
   'Financial-analysis tier property investment report.', 5, 30,
   '{"token_kind":"report.investment.financial","default_credit_cost":5,"complexity":"medium"}'::jsonb),
  ('report.investment.snapshot', 'Investment Report — Snapshot', 'report',
   'Short-form property snapshot.', 4, 40,
   '{"token_kind":"report.investment.snapshot","default_credit_cost":4,"complexity":"low"}'::jsonb),
  ('report.suburb.compass', 'Suburb Report — Compass', 'report',
   'Suburb-scope Compass report.', 10, 50,
   '{"token_kind":"report.suburb.compass","default_credit_cost":10,"complexity":"high"}'::jsonb),
  ('report.postcode.compass', 'Postcode Report — Compass', 'report',
   'Postcode-scope Compass report.', 10, 60,
   '{"token_kind":"report.postcode.compass","default_credit_cost":10,"complexity":"high"}'::jsonb),
  ('report.market-intelligence', 'Market Intelligence Report', 'report',
   'Market intelligence / market pulse report.', 6, 70,
   '{"token_kind":"report.market-intelligence","default_credit_cost":6,"complexity":"medium"}'::jsonb),
  ('report.portfolio-review', 'Portfolio Analysis', 'report',
   'Client portfolio review and projections.', 8, 80,
   '{"token_kind":"report.portfolio-review","default_credit_cost":8,"complexity":"medium"}'::jsonb),
  ('report.bulk-item', 'Bulk Report — Per Item', 'report',
   'One item within a bulk generation run.', 8, 90,
   '{"token_kind":"report.bulk-item","default_credit_cost":8,"complexity":"medium"}'::jsonb),
  ('report.chart-analysis', 'Chart Analysis', 'report',
   'AI commentary on a single chart.', 2, 100,
   '{"token_kind":"report.chart-analysis","default_credit_cost":2,"complexity":"low"}'::jsonb),
  ('report.qualitative-regen', 'Qualitative Regeneration', 'report',
   'Re-runs the qualitative sections of an existing report.', 3, 110,
   '{"token_kind":"report.qualitative-regen","default_credit_cost":3,"complexity":"low"}'::jsonb),
  ('aml_identity_check', 'AML — Identity Check', 'compliance',
   'Provider-backed identity verification.', 4, 200,
   '{"token_kind":"aml_identity_check","default_credit_cost":4,"complexity":"low"}'::jsonb),
  ('aml_screening_check', 'AML — Screening Check', 'compliance',
   'Sanctions / PEP / adverse-media screening.', 4, 210,
   '{"token_kind":"aml_screening_check","default_credit_cost":4,"complexity":"low"}'::jsonb),
  -- Present on the live prime but seeded by no migration, so 20260729010000's
  -- "every reviewed slug must exist" assertion could never pass on a fresh
  -- database — and that assertion halts replay, which is how clone backends
  -- stopped receiving the schema. Shipped default 4; that migration reviews it
  -- to 5, exactly as its own comment says.
  ('scenario-model', 'Scenario Model', 'report',
   'Scenario modelling run.', 4, 120,
   '{"token_kind":"scenario-model","default_credit_cost":4,"complexity":"medium"}'::jsonb)
ON CONFLICT (slug) DO UPDATE
  SET name        = EXCLUDED.name,
      category    = EXCLUDED.category,
      description = COALESCE(public.report_credit_costs.description, EXCLUDED.description),
      sort_order  = EXCLUDED.sort_order,
      -- Never clobber a price an operator has set. Only the descriptive
      -- fields and the shipped-default marker are refreshed.
      metadata    = public.report_credit_costs.metadata || EXCLUDED.metadata;

-- `report.investment.financial` is the exception worth naming: the clone emits
-- that kind but never listed it, so it silently used the generic `?? 5`
-- fallback. Seeding 5 keeps today's behaviour exactly — it is now visible and
-- adjustable rather than accidental.

-- ── 2. Only super admins and the High King may reprice ──────────────────────
-- has_role is hierarchy-aware (20260717000200), so the previous
-- has_role(uid,'admin') admitted level 80 as well. Repricing every clone is a
-- platform-wide action; it belongs to level 100+ (super_admin, high_king).
DROP POLICY IF EXISTS "Admins write report_credit_costs" ON public.report_credit_costs;
-- Also drop the name we are about to create: 20260728102159 created it earlier
-- the same day, so on a fresh replay this CREATE collided and halted the run.
DROP POLICY IF EXISTS "Super admins write report_credit_costs" ON public.report_credit_costs;
CREATE POLICY "Super admins write report_credit_costs"
  ON public.report_credit_costs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'::public.app_role));

-- ── 3. Publish history ──────────────────────────────────────────────────────
-- Every cascade is recorded: who published, what the index looked like, and
-- what each clone said when it was notified. Repricing is a money decision
-- across every workspace on the platform, so it needs a paper trail that
-- survives the next edit.
CREATE TABLE IF NOT EXISTS public.report_cost_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        bigint GENERATED ALWAYS AS IDENTITY,
  published_by   uuid,
  note           text,
  -- Full index snapshot at publish time: slug → credit_cost.
  costs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What changed vs the previous revision: slug → { from, to }.
  changes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-clone delivery outcome from the cascade.
  cascade_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_cost_revisions_created_idx
  ON public.report_cost_revisions (created_at DESC);

ALTER TABLE public.report_cost_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read report_cost_revisions" ON public.report_cost_revisions;
CREATE POLICY "Operators read report_cost_revisions"
  ON public.report_cost_revisions FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));
-- Writes go through the publish server function under the service role only.
REVOKE ALL ON public.report_cost_revisions FROM PUBLIC, anon;
GRANT SELECT ON public.report_cost_revisions TO authenticated;
GRANT ALL    ON public.report_cost_revisions TO service_role;

COMMENT ON TABLE public.report_cost_revisions IS
  'Audit trail of report cost index publishes, including the per-clone cascade outcome.';
