# Rotating `CRON_SECRET`

**This is required, not optional, and editing the repository does not do it.**

## What happened

Migration `20260820175047_082469e1-f012-4941-a3a5-dd102743f37c.sql` was committed
carrying the live `CRON_SECRET` as a string literal:

```sql
v_secret text := 'iI72oB…2Rbl';   -- 64 characters, the real value
```

It was pushed to `main` in commit `6221443` and is present in the history of
every clone, fork and CI checkout taken since. The literal has been removed from
the working tree, and `npm run check:migration-secrets` now fails CI on the
class — but **a value that has been pushed cannot be un-pushed.** Removing the
line changes what future readers see; it changes nothing about who already has
it.

## What that secret does

`src/server/cron-auth.server.ts` accepts it as the bearer token on every
`/hooks/*` route. Anyone holding it can invoke, at will:

| Worker | What invoking it does |
| --- | --- |
| `/hooks/api-usage-settle` | closes billing periods and pushes charges onto tenants' Stripe invoices |
| `/hooks/cascade-drain` | executes queued cascades — writes code into clone repositories |
| `/hooks/deployment-drain` | drives Vercel project creation, domain attachment and DNS |
| `/hooks/backend-provisioning-drain` | drives Supabase project provisioning |
| the rest | drift scans, parity refreshes, digests, purges |

These are workers, not read endpoints. The exposure is write access to
billing, repositories and infrastructure, not information disclosure.

## Rotate it

1. **Generate a new value.**
   ```bash
   openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-64
   ```

2. **Set it where the application reads it** — the `CRON_SECRET` environment
   variable on the Mission Control deployment. Do this *first*: the application
   accepts the new value before anything starts sending it.

3. **Set it where the database sends it from.** Both readers are mirrored by
   `20260820175047`, so the Vault entry is the only one you have to write:
   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'cron_secret'),
     '<new value>'
   );
   ```
   Every scheduled job reads the token from `vault.decrypted_secrets` **at fire
   time**, not from the command string, so this re-points all of them at once —
   there is nothing to reschedule. (Verified by replay: every `/hooks/` job's
   command contains a `decrypted_secrets` lookup rather than a literal.)

4. **Mirror it into the GUC**, which the migrations read with
   `current_setting()`:
   ```sql
   alter role postgres in database postgres
     set app.settings.cron_secret = '<new value>';
   ```

5. **Confirm delivery** after one cycle. `last_run_status` is pg_cron reporting
   that it queued an HTTP call, not that anyone answered it:
   ```sql
   select jobname, last_run_status, last_http_status, delivered
     from public.cron_delivery_health(24) order by jobname;
   ```
   `delivered = false` with a **401** means step 3 or 4 did not take.

## Also worth doing

The exposure window is from `6221443` (2026-08-20) to whenever you rotate.
Anything a holder of that token could have caused is worth a look:

- `integration_outbox.attempts` and `net._http_response.status_code` for hook
  calls you did not schedule
- `api_usage_charges` and Stripe invoices for settlements outside the daily run
- `cascade_events` for cascades nobody initiated
- `audit_log` around the window

## What is NOT affected

Five migrations contain a Supabase JWT. All five decode to `role: "anon"` —
the publishable key that ships in every client bundle and is what RLS is
designed to be safe against. No `service_role` key is committed anywhere in the
corpus; `npm run check:migration-secrets` decodes each JWT and fails only on a
non-anon role, so that stays true.
