# The LLM enrichment stage

The canonical prompt, output schema and theme vocabulary for the model that sits
between the Make webhook and Airtable. This file is the source of truth: the
scenario holds a copy, and a copy in a scenario is not reviewable, diffable or
testable, so changes belong here first.

---

## What it is for, and what it must never do

Free-text feedback arrives as prose. Prose does not aggregate. Nobody can answer
"what are people unhappy about this quarter" from four hundred paragraphs, and
nobody reads four hundred paragraphs. The model turns each answer into a small
set of typed fields that Airtable can group, filter and chart.

**The model is strictly additive.** It is not permitted to change whether a row
is written, and it is not permitted to change the raw answers. Those two rules
are what make it safe to put a non-deterministic component on a delivery path:

- Every raw field is written to Airtable **from the webhook payload**, not from
  the model output. If the model hallucinates, it corrupts an analysis column,
  never the customer's actual words.
- The Airtable write is routed so that a failed, slow or malformed LLM call
  **still produces a complete row** with the enrichment columns left empty.
  §3.4 of [the Make guide](./feedback-make-airtable.md) is how that is wired,
  and it is not optional.

The failure to design around is not "the model is wrong sometimes". It is "the
model was down for an hour and we silently lost an hour of customer feedback."

---

## Skipping the call

Do not call the model when `has_free_text` is `false`. A ratings-only submission
has nothing to summarise, and paying a model to read four nulls returns four
nulls with extra steps. Roughly half of submissions are ratings-only, so this is
also most of the cost.

`free_text_chars` is provided for a second, optional guard: under about 25
characters ("all good", "n/a", "fine") there is no theme to extract and the
model will invent one to fill the field.

---

## Output schema

Strict JSON, no prose, no markdown fence. Every field is required — the model
must emit `null` or `[]` rather than omitting a key, because a missing key and a
deliberate "nothing here" are different facts and the scenario cannot tell them
apart after the fact.

```json
{
  "sentiment": "positive | neutral | negative | mixed",
  "sentiment_confidence": 0.0,
  "summary": "one sentence, max 200 chars, plain past tense",
  "themes": ["reporting", "speed-performance"],
  "pain_points": ["short phrase", "short phrase"],
  "feature_requests": ["short phrase"],
  "priority": "none | low | medium | high",
  "churn_risk": "none | low | medium | high",
  "contains_pii": false,
  "language": "en",
  "most_valuable_clean": "…or null",
  "biggest_frustration_clean": "…or null",
  "feature_request_clean": "…or null",
  "additional_comments_clean": "…or null"
}
```

### Field notes

| Field                              | Rule                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sentiment`                        | `mixed` is a real answer and the most common one for engaged customers. Do not collapse it to `neutral` — "the reports are superb but it is unusably slow" is not a neutral opinion, and treating it as one hides the two things worth knowing.                                     |
| `sentiment_confidence`             | Below 0.6, treat the sentiment as unreviewed. Surfaced so a human can filter to the ambiguous ones rather than trusting all of them equally.                                                                                                                                        |
| `summary`                          | Describes what the customer said, not what we should do. "Wants bulk export from the deal pipeline", never "We should add bulk export".                                                                                                                                             |
| `themes`                           | **Controlled vocabulary only** — see below.                                                                                                                                                                                                                                         |
| `pain_points` / `feature_requests` | Max 3 each, max 60 chars each, lifted from what was written rather than invented. Empty array when there are none.                                                                                                                                                                  |
| `priority`                         | How urgently a human should look, judged on impact and tone. A frustrated Scale customer describing a blocker is `high`; a passing "would be nice" is `low`.                                                                                                                        |
| `churn_risk`                       | `high` only on an explicit signal — mentions of cancelling, of evaluating a competitor, or of the product not being worth the cost. Not "sounds annoyed".                                                                                                                           |
| `contains_pii`                     | True if the raw text contains a person's name, email, phone, address, or an identifiable client or property. Drives the redaction below and flags the row for care.                                                                                                                 |
| `*_clean`                          | The same answer with PII replaced by `[name]`, `[email]`, `[phone]`, `[address]`, `[client]`, and obvious typos fixed. **Meaning must not change and length must not shrink materially** — this is redaction and tidying, not summarising. `null` when the source field was `null`. |

### Why both raw and `_clean` are stored

The raw column is the record of what the customer actually wrote — it is
evidence, and paraphrasing evidence destroys it. The `_clean` column is what can
safely be pasted into a Slack channel, a board deck or a support thread without
leaking a third party's name. Keeping only one of the two forces a choice
between fidelity and shareability, and both are wanted.

---

## Theme vocabulary

**Closed list.** The model must pick only from these, and return `["other"]`
rather than inventing a label. This is the single most important constraint in
the prompt: an open-ended theme field produces `reporting`, `Reporting`,
`reports`, `report-quality` and `reporting-issues` inside a month, and an
Airtable multi-select built on it becomes unfilterable — which is the only
reason the field exists.

```
reporting            data-accuracy        speed-performance    reliability
usability            navigation           onboarding           support
pricing              integrations         mobile               search-filtering
client-management    document-handling    automation           ai-features
compliance           notifications        permissions          exports
other
```

Max 4 themes per submission. Beyond that they stop discriminating: a row tagged
with eight themes groups with everything and therefore with nothing.

> Adding a term is a deliberate act. Change it **here**, then in the scenario,
> then add the option in Airtable. Adding it only in the prompt produces values
> Airtable silently drops.

---

## System prompt

Paste verbatim into the model module.

```text
You classify product feedback for Aurixa Systems, an Australian property
operations platform used by property firms.

Return ONLY a JSON object matching the schema below. No markdown, no code fence,
no commentary before or after. Every key must be present; use null or [] for
"nothing here" rather than omitting the key.

Schema:
{
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "sentiment_confidence": number between 0 and 1,
  "summary": string, max 200 characters,
  "themes": array of 0-4 strings from the allowed list,
  "pain_points": array of 0-3 strings, max 60 chars each,
  "feature_requests": array of 0-3 strings, max 60 chars each,
  "priority": "none" | "low" | "medium" | "high",
  "churn_risk": "none" | "low" | "medium" | "high",
  "contains_pii": boolean,
  "language": ISO 639-1 code,
  "most_valuable_clean": string or null,
  "biggest_frustration_clean": string or null,
  "feature_request_clean": string or null,
  "additional_comments_clean": string or null
}

Allowed themes — use ONLY these, and use "other" if nothing fits. Never invent a
theme:
reporting, data-accuracy, speed-performance, reliability, usability, navigation,
onboarding, support, pricing, integrations, mobile, search-filtering,
client-management, document-handling, automation, ai-features, compliance,
notifications, permissions, exports, other

Rules:
- Report what the customer said, not what we should do about it. Write
  "wants bulk export" and never "we should add bulk export".
- "mixed" is correct when praise and complaint appear together. Do not flatten
  that to "neutral".
- Set churn_risk above "none" only on an explicit signal: cancelling, comparing
  us to a competitor, or saying it is not worth the money. Irritation alone is
  not churn risk.
- The *_clean fields are the SAME text with personal information replaced by
  [name], [email], [phone], [address] or [client], and obvious typos corrected.
  Do not shorten, summarise, soften or reword them. If a source field is null,
  its _clean field is null.
- Judge only the free text. The numeric ratings are given for context and must
  not by themselves drive sentiment — a 5-star rating attached to an angry
  paragraph usually means the scale was misread, and the words are the truth.
- If the text is empty, unintelligible, or says nothing (for example "n/a",
  "none", "test"), return sentiment "neutral", confidence 0, themes [], empty
  arrays, priority "none", churn_risk "none", and copy the source text
  unchanged into the _clean fields.
```

## User message

```text
Plan: {{plan_name}}
Overall rating: {{overall_rating}}/5
Would recommend: {{recommend_score}}/10
Module ratings: {{module_ratings_summary}}

Most valuable:
{{most_valuable}}

Biggest frustration:
{{biggest_frustration}}

Feature request:
{{feature_request}}

Additional comments:
{{additional_comments}}
```

Module ratings are passed as the pre-rendered summary line, and the payload also
carries `module_ratings_labelled` keyed by human labels. Neither exposes our
slugs to the model: given `{"deal-pipeline": 2}` it has to guess what that
product is, and it guesses confidently and wrongly.

---

## Model settings

| Setting         | Value                                   | Why                                                                                                                                              |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model           | `gpt-4o-mini` or equivalent small model | This is classification against a closed vocabulary, not reasoning. A frontier model costs more and agrees with the small one.                    |
| Temperature     | `0`                                     | The same feedback must classify the same way every time, or quarter-on-quarter theme counts measure model variance rather than customer opinion. |
| Response format | JSON object / JSON mode                 | Removes the single most common failure — a markdown fence around the JSON that then fails to parse.                                              |
| Max tokens      | `800`                                   | Comfortably above the largest valid output; low enough that a runaway generation is capped.                                                      |
| Timeout         | `30s`                                   | Past this the row should be written raw rather than delayed further.                                                                             |

---

## When the model misbehaves

Handled in the scenario, not by hoping:

| Failure                        | Handling                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API error, rate limit, timeout | Error handler resumes with an empty enrichment bundle. **Row is still written.**                                                                                                     |
| Output is not valid JSON       | Parse module's error handler resumes with empty. **Row is still written.**                                                                                                           |
| A theme outside the vocabulary | Airtable multi-select rejects unknown options; the rest of the row lands. Worth checking quarterly — a recurring invention usually means the vocabulary is genuinely missing a term. |
| Confident nonsense             | Not preventable. It is why raw text is stored alongside and why `sentiment_confidence` is recorded.                                                                                  |

The one thing that must never happen is a customer's feedback being absent from
Airtable because a model call failed. Every branch above ends in a written row.
