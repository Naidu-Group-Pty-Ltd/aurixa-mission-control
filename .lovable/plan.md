## Client Fit Analysis — AI compatibility engine

A pre-contract gate that scores every lead/account against what Aurixa Systems actually delivers, before a deal reaches Contract/SLA stage.

### Where it lives

| Surface | What it does |
|---|---|
| `/crm/fit` (new nav item under **Clients**) | Queue of all fit analyses — score, grade, verdict, stale flag, re-run |
| Account Hub → new **Fit** tab | Full report for that account: score breakdown, evidence, risks, recommended modules |
| Leads page → row action | "Run fit analysis" on an unconverted lead; result shown before conversion |
| Deals board | Grade badge on each card; Contract stage blocked without a current analysis |

### How the engine works

```text
Lead / Account record
        |
   1. Normalise + validate input   (email domain, ABN/entity, website reachable)
        |
   2. Enrich                        (fetch public site copy, extract what they do)
        |
   3. Capability corpus             (Aurixa modules, sub-modules, tiers, pricing catalog
                                     — pulled live from addon_modules / seat_roles /
                                     setup_packages, not hardcoded)
        |
   4. AI analysis (Lovable AI)      structured JSON output, no free-form prose scoring
        |
   5. Persist + score               weighted rubric -> 0-100 -> letter grade
        |
   6. Surface                       report card, notification, deal gate
```

**Scoring rubric** (weights configurable in DB, so you can tune without a deploy):

| Dimension | Weight | Signal |
|---|---|---|
| Problem–solution fit | 30 | Do their stated bottlenecks map to our modules? |
| Segment fit | 15 | Entity classification vs our ICP |
| Scale fit | 15 | Transaction volume vs tier capacity |
| Technical fit | 15 | Their stack vs our integration surface |
| Commercial fit | 15 | Volume/tier implies viable contract value |
| Risk / red flags | 10 | Unverifiable entity, regulated edge cases, churn signals |

Grade bands: A ≥ 85, B 70–84, C 55–69, D 40–54, F < 40. Verdict: `strong_fit` / `fit` / `conditional` / `poor_fit` / `decline`.

The AI returns evidence per dimension (quoted from their input or their site), a confidence level, and explicitly flags anything it could **not** verify — so a high score built on unverified claims is visible rather than hidden.

### Output the report contains

- Score /100 + letter grade + verdict
- Per-dimension score, weight, rationale, evidence
- Company research summary (what they actually do, size signals, verified vs claimed)
- Correlation map: their pain point → our module/sub-module → expected outcome
- Recommended tier + add-on modules + setup package (priced from the live catalog)
- Risks & blockers, open questions for the discovery call
- Data-validation report: which submitted fields were confirmed, contradicted, or unverifiable

### Build phases

**Phase 1 — Data model + scoring core**
`crm_fit_analyses` (versioned, one row per run, linked to lead or account), `crm_fit_rubric` (tunable weights/bands), `crm_fit_evidence`. RLS + GRANTs, operator read, admin write.

**Phase 2 — Engine**
`src/server/fit-analysis.server.ts`: capability corpus builder (reads the live pricing catalog), website enrichment fetch, prompt assembly, Lovable AI call with a strict JSON schema, deterministic scoring in code (the model supplies dimension scores + evidence; the weighted total is computed server-side so it can't drift), persistence, audit log.
`src/lib/fit-analysis.functions.ts`: `runFitAnalysis`, `getFitAnalysis`, `listFitAnalyses`, `overrideFitVerdict`.

**Phase 3 — UI**
`/crm/fit` queue, Account Hub Fit tab, report card component (score dial, dimension bars, evidence accordions, recommendation panel), lead row action, deal card badge.

**Phase 4 — Workflow integration**
Auto-run on lead qualification and on lead→account conversion; deal stage guard before Contract/SLA; notification on completion; re-run when key inputs change; staleness flag after 90 days; manual operator override with reason (recorded, never silently replaces the AI score).

### Technical notes

- Model: Lovable AI Gateway, `google/gemini-3.6-flash` for standard runs, escalating to `google/gemini-2.5-pro` for high-value leads. Runs through the existing `callAi` helper so usage is logged to `ai_usage_log`.
- All AI calls are server-side only; the model never sees credentials, only the lead payload + capability corpus.
- Website enrichment is best-effort and time-boxed; failure degrades the confidence score rather than failing the run.
- Every run is immutable and versioned, so you can see how a client's fit changed over time.
