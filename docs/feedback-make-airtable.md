# Feedback → Make.com → Airtable

Everything on the Aurixa side is built and deployed by the PRs this document
ships with. What remains is the Make.com scenario and the Airtable table, which
have to be created in those products' own UIs.

Mission Control posts each submission to one webhook. Nothing else is required
of Make beyond receiving it and writing a row.

---

## 1. Airtable — new table in the **NPC Emails** base

Create a table named **`Product Feedback`** with these fields. Types matter
where noted; everything else can be Single line text.

| Field name | Type | Notes |
|---|---|---|
| `Submission ID` | Single line text | **Set as the primary field.** Also used for de-duplication. |
| `Submitted At` | Date (include time) | ISO 8601 arrives from the webhook |
| `Campaign` | Single select | Options: `onboarding`, `2026-Q1` … `2026-Q4`. Allow Make to add new options, or add each quarter as it comes. |
| `Workspace` | Single line text | Display name |
| `Workspace ID` | Single line text | Mission Control tenant UUID |
| `Workspace Ref` | Single line text | e.g. `prime:dduzbchuswwbefdunfct` |
| `Clone ID` | Single line text | Empty for Prime |
| `User ID` | Single line text | Who answered, as their workspace knows them |
| `User Name` | Single line text | May be empty |
| `Source` | Single line text | `handoff`, `storefront_uid`, `prime_dashboard` |
| `Plan` | Single line text | Plan name at time of answering |
| `Plan Slug` | Single line text | |
| `Overall Rating` | Number (integer, 0 dp) | 1–5, may be empty |
| `Recommend Score` | Number (integer, 0 dp) | 0–10, may be empty |
| `Module Ratings` | Long text | Human-readable summary line |
| `Module Ratings JSON` | Long text | Raw object, for analysis |
| `Most Valuable` | Long text | |
| `Biggest Frustration` | Long text | |
| `Feature Request` | Long text | |
| `Additional Comments` | Long text | |
| `Credits Granted` | Number (integer, 0 dp) | 100 or 0 — see below |

> **`Credits Granted` of 0 is normal and not an error.** The reward is one per
> workspace per campaign. The first colleague to answer earns 100; everyone
> after them shows 0 and their response still matters.

---

## 2. Make.com — the scenario

**Two modules. That is the whole scenario.**

### Module 1 — Webhooks › Custom webhook

1. Add a **Custom webhook**, name it `Aurixa Product Feedback`.
2. Copy the URL it gives you.
3. Leave it listening and send a test (step 3 below) so Make learns the data
   structure — otherwise the field mapping in module 2 will be empty.

### Module 2 — Airtable › Create a Record

- **Base:** NPC Emails · **Table:** Product Feedback
- Map fields from the webhook payload:

| Airtable field | Webhook value |
|---|---|
| Submission ID | `submission_id` |
| Submitted At | `submitted_at` |
| Campaign | `campaign` |
| Workspace | `workspace_name` |
| Workspace ID | `workspace_id` |
| Workspace Ref | `workspace_ref` |
| Clone ID | `clone_id` |
| User ID | `user_id` |
| User Name | `user_name` |
| Source | `source` |
| Plan | `plan_name` |
| Plan Slug | `plan_slug` |
| Overall Rating | `overall_rating` |
| Recommend Score | `recommend_score` |
| Module Ratings | `module_ratings_summary` |
| Module Ratings JSON | `module_ratings` |
| Most Valuable | `most_valuable` |
| Biggest Frustration | `biggest_frustration` |
| Feature Request | `feature_request` |
| Additional Comments | `additional_comments` |
| Credits Granted | `credits_granted` |

**Recommended:** insert an **Airtable › Search Records** between the two,
filtering `{Submission ID} = <submission_id>`, and route to Create only when it
finds nothing. Mission Control never sends the same submission twice on the
happy path, but a retried delivery would otherwise duplicate a row.

Turn the scenario **on**.

---

## 3. Wire it up and test

Set the webhook URL on Mission Control:

```
FEEDBACK_MAKE_WEBHOOK_URL=https://hook.eu2.make.com/xxxxxxxxxxxxxxxx
```

Until that variable is set, submissions are still recorded in full and credits
are still granted — they are simply marked as not delivered, and
**Billing → Catalog → Product feedback** says so. Nothing is lost, and a
submission can be replayed once the URL exists.

Then send a real one: open a workspace, use the feedback prompt, submit. Check

- Airtable has the row,
- **Billing → Catalog → Product feedback** shows the response marked `sent`,
- the workspace balance is 100 credits higher.

---

## What the webhook receives

```json
{
  "submission_id": "0f9a…",
  "submitted_at": "2026-07-29T04:15:22.113Z",
  "campaign": "onboarding",
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
  "module_ratings_summary": "Deal Pipeline: 4/5 · Generated reports: 5/5",
  "most_valuable": "The comparison reports save us hours every week.",
  "biggest_frustration": null,
  "feature_request": null,
  "additional_comments": null,
  "credits_granted": 100
}
```

`module_ratings` is sent both as an object and as a pre-rendered summary line
on purpose. Airtable has no good column type for an arbitrary key–value map,
and asking Make to build that string would put the formatting in a scenario
nobody can review or test.

---

## Why delivery is not on the critical path

The webhook is called **after** the submission is saved and the credits are
granted. Make is a reporting destination, not the system of record. If it is
down, the customer has still given feedback and still earned their credits, and
the row is replayable from `feedback_submissions`.

Reversing that order would let an outage at Make cost a customer their reward,
which is the one failure mode worth designing around.
