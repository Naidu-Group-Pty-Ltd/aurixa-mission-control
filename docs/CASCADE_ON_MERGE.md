# Prime merges, the clone follows

Read this before touching `/hooks/github`, `cascade-trigger.server.ts`,
`processClone` in `cascade-engine.server.ts`, or
`server/cascade/syncExclusions.pure.ts`.

## The pipeline was never broken. It had nowhere to go.

`/hooks/github` has verified an HMAC signature and accepted every push to
prime's default branch since **2026-04-23**, and asked for a cascade each time.
Measured in the live database:

```sql
select metadata->>'reason', count(*), min(created_at), max(created_at)
  from audit_log where action = 'webhook.skipped' group by 1;

 "No clones registered" | 1553 | 2026-04-23 03:24 | 2026-08-26 04:43
```

**1,553 deliveries, one reason, four months, and `cascade_events` had zero
rows.** `createCascadeForAllClones` selects from `clones`, finds nothing, and
returns `"No clones registered"`; the webhook records the skip and answers 200,
so GitHub sees a healthy endpoint and nothing anywhere reports a problem. That
is why 159 files of drift accumulated between the prime and
`npc-client-dashboard` and had to be carried across by hand.

The lesson is the one this platform keeps relearning in different clothes: a
green signal about the wrong question. The webhook was asked "did the delivery
succeed?" and it always had.

## Three things had to be true, not one

**1 · Something to cascade to.** `clones` is the registry. Registering
`npc-client-dashboard` is what turns 1,553 skips into work.

**2 · A scope that can express "the whole application".** The engine cascades
the file globs of the modules INSTALLED on a clone. A mirror has no modules — it
*is* the prime with one build flag flipped — so a registered mirror with an
empty `clone_modules` still skips, now saying "No installed modules".
`clones.sync_scope` adds `mirror`, which diffs the two repositories by **git
blob SHA** instead.

Blob SHAs matter for cost, not elegance. The module path re-reads both sides'
*content* to decide whether a file changed: two API calls per file, fine for a
module and impossible for a tree of several thousand against an hourly budget of
5,000. Git already hashed every file, so `prime[path] !== clone[path]` is the
same answer for two calls total, and content is fetched only for what actually
differs.

**3 · A list of what must never be written.** This is the safety-critical part
and the reason the other two are not enough on their own.

## A clone's identity is not a file the cascade owns

Inside the mirrored tree are files whose entire purpose is to differ. The worst
of them is `src/integrations/supabase/env.ts`, which names the Supabase project
the deployment talks to. Its own header records what happened the last time it
resolved to prime's: **the deployed client dashboard served the PRIME's
production database, and signing in authenticated against real staff accounts.**

A cascade that overwrites that file does not fail. It succeeds, reports green,
and asks the hosting layer to redeploy. Nothing downstream of the commit can
distinguish it from a correct sync — which is exactly why the decision is made
before the blob is written, from `clone_sync_exclusions`, a table an operator can
read.

Two reasons, both withheld, only one silent:

| reason | meaning | in the pull request |
| --- | --- | --- |
| `protected` | the clone owns this file outright — config, identity, the fail-closed workflow guards | counted, not listed |
| `manual_reconcile` | the clone's version is a deliberate **superset** of prime's | listed by name, with why |

`src/App.tsx` is the second kind. The clone carries route gates prime does not,
so taking prime's copy would revert real work — but skipping it *silently* means
the clone never learns about a new upstream route. Both failure modes are real;
only one of them is quiet, so that one gets a section in every pull request.

## The rules that carry it

**Fail closed.** An exclusion set that could not be READ is not an empty one.
`requireExclusions` throws when the query errored or returned nothing, and the
engine records the throw as a failed cascade result. A cascade that ran without
its guard rails cannot be undone by noticing afterwards.

**An empty policy is legitimate for a module clone and never for a mirror.** A
module-scoped clone receives only what it installed and contests none of it. A
mirror with no exclusions means "overwrite everything", and that state is
reachable by ordinary means — register a mirror, forget to seed it.
`assertMirrorPolicy` refuses, and the refusal names the fix.

**One glob implementation.** `globToRegex` decides which files the cascade READS
out of prime and which it must NOT WRITE into a clone. Two implementations
answering the same question differently is how an exclusion silently stops
excluding, so it lives in `lib/module-globs` and both sides import it.

**Exclusions apply in both scopes.** A module glob that grows to cover
`src/integrations/**` would otherwise reach the clone's identity by a different
route than the one this was written for.

**A cascade never deletes.** A path present in the clone and absent from prime
is left alone — the clone legitimately carries files of its own (its isolation
spec, its transfer scripts), and a mirror that pruned them would remove the very
things that make it a clone rather than a copy. Prime-side deletions are counted
and named in the pull request, never acted on.

**A truncated tree is an error, not a small one.** A partial tree read as
complete looks exactly like a clone that is already in sync.

## One cascade per prime commit

A merged pull request delivers **two** webhooks that both mean "prime moved":
`pull_request.closed` with `merged: true`, and the `push` the merge itself
makes. They carry the same head SHA — `pull_request.merge_commit_sha` equals
`push.after` — so the SHA is what decides, not which delivery arrives first.

- `createCascadeForAllClones` looks for an existing `commit` cascade on that SHA
  and stands down if it finds one.
- `uq_cascade_events_commit_sha` is the backstop underneath for two deliveries
  racing, and a violation there is read as "already cascaded" rather than as an
  error, because it means the other delivery won.
- The index covers `commit` only. A **manual** re-run of the same SHA is how an
  operator retries a cascade after correcting an exclusion; a unique index that
  refused it would turn a repair into a constraint violation.
- A read that FAILED is not an absence: reporting "no existing cascade" on a
  database fault is how you get the duplicate this exists to stop.

A closed-but-unmerged pull request changes nothing on prime and does not
cascade. Direct pushes — this prime takes them from Lovable constantly — still
cascade on their own, because they simply find no earlier event.

## What lands on the clone

`prime_config.default_cascade_mode` is `pr`, so a cascade opens a pull request
on the clone rather than pushing to its default branch. The clone's own CI then
decides whether the change is safe, which is the point: the mirror runs the same
gates the prime does, and a cascade that would break it is caught there rather
than in production.

`auto_merge` and `notify` still behave as they did.
