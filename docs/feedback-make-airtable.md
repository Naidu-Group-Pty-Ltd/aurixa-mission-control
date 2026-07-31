# Feedback → Make.com → Airtable

Everything on the Aurixa side is built, verified and shipped. What remains is
the Make scenario and the Airtable table, which have to be created in those
products' own UIs.

```
Mission Control ──POST (signed)──▶ Make webhook ──▶ LLM enrichment ──▶ Airtable
       │                                                  │            "NPC Emails"
       │                                              (skippable,      / Product Feedback
       │                                               never blocking)
       └── retry sweep every 10 min for anything that did not land
```

Three things make this safe to run unattended, and each is covered below:
delivery is **replayable** (§5), the webhook is **signed** (§4), and the LLM is
**strictly additive** (§3.4).

---

## 1. Airtable — new table in the **NPC Emails** base

Create a table named **`Product Feedback`**.

### 1a. Raw fields — written from the webhook, always

| Field name            | Type                | Notes                                                                                            |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `Submission ID`       | Single line text    | **Primary field.** De-duplication key.                                                           |
| `Submitted At`        | Date (include time) | ISO 8601 from the webhook                                                                        |
| `Campaign`            | Single select       | `onboarding`, `2026-Q1` … `2026-Q4`. Let Make add new options, or add each quarter as it starts. |
| `Workspace`           | Single line text    | Display name                                                                                     |
| `Workspace ID`        | Single line text    | Mission Control tenant UUID                                                                      |
| `Workspace Ref`       | Single line text    | e.g. `prime:dduzbchuswwbefdunfct`                                                                |
| `Clone ID`            | Single line text    | Empty for Prime                                                                                  |
| `User ID`             | Single line text    | Who answered, as their workspace knows them                                                      |
| `User Name`           | Single line text    | May be empty                                                                                     |
| `Source`              | Single line text    | `handoff`, `storefront_uid`, `prime_dashboard`                                                   |
| `Plan`                | Single line text    | Plan name when they answered                                                                     |
| `Plan Slug`           | Single line text    |                                                                                                  |
| `Overall Rating`      | Number, 0 dp        | 1–5, may be empty                                                                                |
| `Recommend Score`     | Number, 0 dp        | 0–10, may be empty                                                                               |
| `Modules Rated`       | Number, 0 dp        | How many module scores were given                                                                |
| `Module Ratings Avg`  | Number, 1 dp        | Mean of those scores, empty when none                                                            |
| `Module Ratings`      | Long text           | Human-readable summary line                                                                      |
| `Module Ratings JSON` | Long text           | Raw object, for analysis                                                                         |
| `Most Valuable`       | Long text           | **Verbatim.** Never overwritten by the model.                                                    |
| `Biggest Frustration` | Long text           | Verbatim                                                                                         |
| `Feature Request`     | Long text           | Verbatim                                                                                         |
| `Additional Comments` | Long text           | Verbatim                                                                                         |
| `Credits Granted`     | Number, 0 dp        | 100 or 0 — see below                                                                             |
| `Attempt`             | Number, 0 dp        | 1 on first delivery; >1 means it was replayed                                                    |

> **`Credits Granted` of 0 is normal and not an error.** The reward is one per
> workspace per campaign. The first colleague to answer earns 100; everyone
> after them shows 0 and their response still counts.

### 1b. Enrichment fields — written by the LLM, may be empty

Every one of these must tolerate being blank. A row with all of them empty is a
row where the model was unavailable, and that is a working outcome, not a fault.

| Field name                    | Type             | Notes                                                                                                                                                            |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sentiment`                   | Single select    | `positive`, `neutral`, `negative`, `mixed`                                                                                                                       |
| `Sentiment Confidence`        | Number, 2 dp     | Below 0.6 means "a human should check"                                                                                                                           |
| `Summary`                     | Long text        | One sentence                                                                                                                                                     |
| `Themes`                      | Multiple select  | **Pre-create every option** from the closed vocabulary in [`feedback-llm-enrichment.md`](./feedback-llm-enrichment.md). Airtable silently drops unknown options. |
| `Pain Points`                 | Long text        | Newline-joined                                                                                                                                                   |
| `Feature Requests`            | Long text        | Newline-joined                                                                                                                                                   |
| `Priority`                    | Single select    | `none`, `low`, `medium`, `high`                                                                                                                                  |
| `Churn Risk`                  | Single select    | `none`, `low`, `medium`, `high`                                                                                                                                  |
| `Contains PII`                | Checkbox         |                                                                                                                                                                  |
| `Language`                    | Single line text | ISO 639-1                                                                                                                                                        |
| `Most Valuable (clean)`       | Long text        | Redacted + tidied, safe to paste elsewhere                                                                                                                       |
| `Biggest Frustration (clean)` | Long text        |                                                                                                                                                                  |
| `Feature Request (clean)`     | Long text        |                                                                                                                                                                  |
| `Additional Comments (clean)` | Long text        |                                                                                                                                                                  |
| `Enriched`                    | Checkbox         | False = the model did not run. Makes the gap queryable instead of ambiguous.                                                                                     |

**Create the `Themes` options before turning the scenario on.** This is the one
step whose omission produces silent, partial data rather than an error.

---

## 2. Airtable — recommended views

Not required, but this is where the table stops being a log and starts being
useful:

- **Needs attention** — `Priority` is `high` or `Churn Risk` is not `none`,
  sorted newest first.
- **Unreviewed low confidence** — `Sentiment Confidence` < 0.6.
- **Contains PII** — `Contains PII` is checked. Use the `(clean)` columns when
  quoting from these anywhere.
- **Not enriched** — `Enriched` unchecked. If this fills up, the model stage is
  broken and nothing else will tell you.
- **By theme** — grouped by `Themes`, the quarter-on-quarter view.

---

## 3. Make.com — the scenario

Six modules. Build them in this order.

### 3.1 — Webhooks › Custom webhook _(instant trigger)_

Name it `Aurixa Product Feedback`. Copy the URL. Leave it listening and send a
test (§6) so Make learns the data structure — without that, every field mapping
below will be empty.

### 3.2 — Tools › Set variable · signature check

See §4. Build the rest first and add this once the pipeline works, so you are
not debugging two things at once.

### 3.3 — Router with two routes

**Route A — enrich** · filter: `has_free_text` **equals** `true`
**Route B — straight through** · set as the **fallback route**

Route B exists because a ratings-only submission has nothing to summarise. It
skips to 3.6 and writes the row with the enrichment columns empty.

### 3.4 — OpenAI › Create a Chat Completion _(Route A only)_

Prompts, model and settings: [`feedback-llm-enrichment.md`](./feedback-llm-enrichment.md).
Temperature `0`, JSON response format, max tokens `800`.

> **Set the error handler now, not later.** Right-click the module →
> **Add error handler** → **Resume**, with an output of `{}`.
>
> This single setting is what makes the model additive rather than load-bearing.
> Without it, an OpenAI outage stops the scenario before the Airtable write and
> every submission during that window is lost — the exact failure this
> architecture is built to avoid. With it, an outage costs analysis columns and
> nothing else.

Add the same **Resume → `{}`** error handler to the JSON parse in 3.5.

### 3.5 — JSON › Parse JSON _(Route A only)_

Parse the model's response into fields. Error handler: **Resume** with `{}`.

### 3.6 — Airtable › Search Records → Create/Update

Search `Product Feedback` where `{Submission ID} = ` the incoming
`submission_id`.

- **Nothing found** → Create a Record
- **Found** → Update that record

This is not optional. Mission Control replays undelivered submissions (§5), and
a replay carries the same `submission_id`; without the search, a Make outage
would be repaired into duplicate rows. The `Attempt` field tells the two apart.

#### Field mapping — raw

| Airtable field      | Webhook value            |
| ------------------- | ------------------------ |
| Submission ID       | `submission_id`          |
| Submitted At        | `submitted_at`           |
| Attempt             | `attempt`                |
| Campaign            | `campaign`               |
| Workspace           | `workspace_name`         |
| Workspace ID        | `workspace_id`           |
| Workspace Ref       | `workspace_ref`          |
| Clone ID            | `clone_id`               |
| User ID             | `user_id`                |
| User Name           | `user_name`              |
| Source              | `source`                 |
| Plan                | `plan_name`              |
| Plan Slug           | `plan_slug`              |
| Overall Rating      | `overall_rating`         |
| Recommend Score     | `recommend_score`        |
| Modules Rated       | `modules_rated`          |
| Module Ratings Avg  | `module_ratings_average` |
| Module Ratings      | `module_ratings_summary` |
| Module Ratings JSON | `module_ratings`         |
| Most Valuable       | `most_valuable`          |
| Biggest Frustration | `biggest_frustration`    |
| Feature Request     | `feature_request`        |
| Additional Comments | `additional_comments`    |
| Credits Granted     | `credits_granted`        |

#### Field mapping — enrichment (Route A only)

| Airtable field              | Parsed value                             |
| --------------------------- | ---------------------------------------- |
| Sentiment                   | `sentiment`                              |
| Sentiment Confidence        | `sentiment_confidence`                   |
| Summary                     | `summary`                                |
| Themes                      | `themes`                                 |
| Pain Points                 | `join(pain_points; newline)`             |
| Feature Requests            | `join(feature_requests; newline)`        |
| Priority                    | `priority`                               |
| Churn Risk                  | `churn_risk`                             |
| Contains PII                | `contains_pii`                           |
| Language                    | `language`                               |
| Most Valuable (clean)       | `most_valuable_clean`                    |
| Biggest Frustration (clean) | `biggest_frustration_clean`              |
| Feature Request (clean)     | `feature_request_clean`                  |
| Additional Comments (clean) | `additional_comments_clean`              |
| Enriched                    | `if(length(sentiment) > 0; true; false)` |

Map the raw fields **from the webhook module**, never from the parsed model
output — even where the names look interchangeable. That is what guarantees a
hallucination can never overwrite what the customer actually wrote.

Turn the scenario **on**.

---

## 4. Verifying the signature

A Make webhook URL is a bearer credential in a query string. It travels through
address bars, scenario exports and support threads, and it never expires.
Anyone holding one can post whatever they like into your Airtable.

Mission Control signs every request:

| Header                 | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `x-mc-signature`       | `HMAC-SHA256(FEEDBACK_MAKE_WEBHOOK_SECRET, raw_body)`, hex |
| `x-mc-idempotency-key` | The `submission_id`, constant across every retry           |
| `x-mc-event`           | `feedback.submitted`                                       |

Set the secret on Mission Control:

```
FEEDBACK_MAKE_WEBHOOK_SECRET=<48+ random bytes>
```

Then in the scenario, after the webhook, add **Tools › Set variable**:

```
sha256(<raw body>; hex; <the same secret>)
```

and a filter allowing through only where it equals `x-mc-signature`. Enable
**"Get request headers"** on the webhook module so the header is available.

If the secret is unset, Mission Control sends the payload **unsigned** rather
than failing — an unsigned delivery beats a lost one — and the scenario should
then not enforce the filter. Set it on both sides or neither; enforcing a filter
against an unset secret rejects everything.

---

## 5. Delivery is replayable

The webhook is called **after** the submission is saved and the credits granted.
Make is a reporting destination, not the system of record. If it is down the
customer has still given feedback and still earned their credits.

What is new is that the row is no longer stranded when that happens:

| Piece             | Behaviour                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `next_forward_at` | Per-submission due time                                                                                               |
| Backoff           | 1m → 2m → 4m … capped at 6h                                                                                           |
| Ceiling           | 20 attempts ≈ 3 days, then it stops and stays visible as undelivered                                                  |
| Sweep             | `POST /hooks/feedback-forward-retry`, pg_cron every 10 minutes                                                        |
| Health            | `select public.feedback_delivery_health();`                                                                           |
| Force a retry     | `select public.feedback_retry_now();` — clears the wait after Make is fixed, rather than sitting out a 6-hour backoff |

A replay rebuilds its payload through the same code path as the original, so it
cannot drift into a different shape. It carries the same `submission_id`, which
is why the de-duplicating search in 3.6 matters.

**Required for the sweep to run:** Vault entries `cron_secret` and
`app_public_url` in Mission Control's database. If `cron_secret` is missing the
migration raises a warning and schedules nothing — deliberately loud, because an
unscheduled sweep is invisible.

---

## 6. Wire it up and test

```
FEEDBACK_MAKE_WEBHOOK_URL=https://hook.eu2.make.com/xxxxxxxxxxxxxxxx
FEEDBACK_MAKE_WEBHOOK_SECRET=<48+ random bytes>
```

Until the URL is set, submissions are still recorded in full and credits still
granted — they are marked `make_webhook_not_configured` and replayed once the
URL exists. Nothing is lost.

Then submit a real one and check:

1. Airtable has the row, raw fields populated.
2. If free text was given: `Enriched` checked, `Sentiment` and `Themes` set.
3. **Billing → Catalog → Product feedback** shows it as `sent`.
4. The workspace balance is 100 credits higher.

### Test the failure paths too — they are the ones that matter

| Test                                                   | Expected                                                  |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Disable the OpenAI module, submit                      | Row still created, enrichment blank, `Enriched` unchecked |
| Submit ratings only, no text                           | Route B, row created, no model call                       |
| Turn the scenario off, submit, turn it on, wait 10 min | Row appears via the sweep, `Attempt` = 2                  |
| Replay the same submission twice                       | One row, updated not duplicated                           |

The third and fourth are the two worth doing properly. They are the difference
between a pipeline that works and one that only works when nothing is wrong.

---

## What the webhook receives

```json
{
  "schema_version": 2,
  "submission_id": "0f9a…",
  "submitted_at": "2026-07-29T04:15:22.113Z",
  "attempt": 1,
  "campaign": "2026-Q3",
  "workspace_id": "aac277a5-4ed1-464f-8bb8-b16474f39d03",
  "workspace_ref": "prime:dduzbchuswwbefdunfct",
  "workspace_name": "Prime",
  "clone_id": null,
  "user_id": "8c2f…",
  "user_name": "Dana Whitfield",
  "source": "handoff",
  "plan_slug": "scale",
  "plan_name": "Scale",
  "overall_rating": 5,
  "recommend_score": 9,
  "module_ratings": { "core.reports": 5, "deal-pipeline": 4 },
  "module_ratings_labelled": { "Generated reports": 5, "Deal Pipeline": 4 },
  "module_ratings_summary": "Deal Pipeline: 4/5 · Generated reports: 5/5",
  "modules_rated": 2,
  "module_ratings_average": 4.5,
  "most_valuable": "The comparison reports save us hours every week.",
  "biggest_frustration": null,
  "feature_request": null,
  "additional_comments": null,
  "has_free_text": true,
  "free_text_chars": 48,
  "credits_granted": 100
}
```

`schema_version` is pinned so the scenario can branch if this shape ever
changes, rather than silently mapping absent fields into empty Airtable cells.

Module ratings are sent three ways on purpose. `module_ratings` is the raw
object for analysis; `module_ratings_summary` is pre-rendered because Airtable
has no good column type for a key–value map and building that string in a Make
formula puts the formatting somewhere nobody can review; and
`module_ratings_labelled` exists for the model, which cannot be expected to know
what `deal-pipeline` is and will guess confidently and wrongly if asked to.
