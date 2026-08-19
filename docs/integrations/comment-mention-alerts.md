# Comment @-mention email alerts

> When someone @-mentions you in a comment, you get an email — even if the person who
> typed it closed the tab a second later.
>
> Lambda: `lambdas/sundial-comment-notify` · Route: `POST /webhooks/comment-mention` ·
> Migrations: `sql/sundial_user_preferences.sql`, `sql/sundial_comment_mention_notify.sql` ·
> Decision: **D-056**

---

## Why the database sends this, not the browser

Comments are **not a backend feature**. harmon-crm's `CommentThread.tsx` inserts into
`comments` and then into `comment_mentions` **directly from the browser** under RLS.
There is no server anywhere in that path, and the mention insert is explicitly
best-effort in that component.

That is the entire argument for this design. If the client also owned the
notification, then a closed tab, a flaky network, or a navigation mid-flight would
silently lose **somebody else's** alert. The person who suffers is not the person who
caused it, and neither of them ever finds out. Once the mention row is **committed**,
the notification becomes the database's problem — which is a thing that cannot navigate
away.

```
browser (RLS)                 Postgres                        AWS
─────────────                 ────────                        ───
CommentThread.tsx
  insert comments ──────────► comments
  insert comment_mentions ──► comment_mentions
                                 │ AFTER INSERT trigger
                                 ▼
                              notify_comment_mention()
                                 │ pg_net (async, post-commit)
                                 └──────────────────────────► POST /webhooks/comment-mention
                                                                 sundial-comment-notify
                                                                   │ read mention + comment
                                                                   │ read user_preferences
                                                                   │ read auth.users
                                                                   ├─► SES  (lib/email.js)
                                                                   └─► stamp notified_at
```

**pg_net posts AFTER the transaction commits** (its worker drains
`net.http_request_queue`, which is itself transactional). That is what makes the call
non-blocking, and it is also why the Lambda can safely `SELECT` the row it was told
about — by the time the request goes out, the insert is visible.

---

## Files

| File | Role |
|---|---|
| `sql/sundial_user_preferences.sql` | The `user_preferences` table + RLS |
| `sql/sundial_comment_mention_notify.sql` | `pg_net`, `notified_at`, the trigger |
| `lambdas/sundial-comment-notify/index.js` | Route, shared-secret gate |
| `…/notify.js` | The flow and every skip condition |
| `…/content.js` | Link map + subject/body (pure) |
| `…/config.js` | Secrets Manager / env resolution |
| `…/test.js` | 33 tests (`npm test`) |
| `scripts/wire-comment-mention-route.ps1` | API Gateway wiring |

---

## `user_preferences`

```sql
user_id              uuid primary key references auth.users(id) on delete cascade
comment_email_alerts boolean not null default true
default_list_view    text    not null default 'list' check (in ('list','board'))
updated_at           timestamptz not null default now()
```

Written **directly from the browser** under RLS, like comments. No Lambda has to exist
for the Settings toggle to work.

### Why not columns on `profiles`

`profiles` is **server-owned**: `sundial-auth-proxy` upserts `tenant_id` / `role` /
`email` into it on every `/auth/me`, and RLS on the cache tables resolves tenancy from
it. It is the row that decides what data a session can see.

A self-serve toggle there would mean granting the client `UPDATE` on that row — and
**Postgres RLS is row-level, not column-level**. A policy permitting "update your
preferences" permits updating `tenant_id` and `role` in the same statement. That is
privilege escalation and a tenant-isolation hole in one, and no amount of client-side
care closes it, because in that threat model the client *is* the attacker.
(Column-level `GRANT`s can narrow it, but they are a second mechanism that has to stay
in sync with the policy forever. A separate table has no such edge to keep sharp.)

Here, the worst a malicious user can do is turn off their own email alerts.

### Absence means alerts ON

Every existing user has **no row**, and that is the intended steady state for anyone
who never opens Settings. **There is no backfill, deliberately** — nobody should have
to opt in to keep working the way they do today. Every reader applies the default
itself:

- the Lambda: `maybeSingle()` → `null` → send
- harmon-crm: same default in the Settings page

Do not "fix" this by inserting rows for existing users.

### `'list'`, not `'table'`

harmon-crm's internal `ViewMode` union is `'table' | 'board'`, but `'table'` is a
detail of one component. The **stored** value is the durable cross-repo contract and
matches the user-facing word. harmon-crm maps it in exactly one place. Renaming a React
type must never require a data migration.

---

## The trigger

`AFTER INSERT … FOR EACH ROW` on `comment_mentions`. A comment mentioning three people
inserts three rows and fires three times — right, because each recipient has their own
preference, their own address, and their own `notified_at`.

**It can never block or fail the insert.** The `net.http_post` call is wrapped in an
exception handler that swallows and `RAISE WARNING`s. Posting a comment is the user's
actual job; alerting somebody about it is not. (Same philosophy as the Aurora
write-back and the Supabase ban retry.)

`SECURITY DEFINER` because `net.http_post` is not granted to `authenticated`, with
`search_path` pinned so a caller cannot shadow `net` or `pg_catalog`.

Body: `{ mention_id, comment_id, mentioned_user_id }`. Header:
`X-Sundial-Comment-Secret`.

### Configuration is in database settings, not in the file

```sql
alter database postgres set sundial.comment_notify_url =
  'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/webhooks/comment-mention';
alter database postgres set sundial.comment_notify_secret = '<the shared secret>';
```

> ⚠️ `ALTER DATABASE … SET` applies to **new connections only**. Supabase pools, so it
> can take a minute before the trigger sees the values.

Verify:

```sql
select current_setting('sundial.comment_notify_url', true) as url,
       coalesce(nullif(current_setting('sundial.comment_notify_secret', true), ''), null)
         is not null as secret_set;
```

**An unset setting is LOUD.** `current_setting(…, true)` returns NULL rather than
erroring, and a silent no-op is exactly how a notification path rots unnoticed — the
comments keep working, so nobody investigates. The trigger `RAISE WARNING`s on every
mention until the values are set.

**Why not Supabase Vault:** vault is the better home for a secret, but it is a second
extension to depend on and its read path inside a `SECURITY DEFINER` trigger is
fiddlier. The exposure here is bounded — a database setting is readable by the
`postgres` superuser role, which can already read every comment directly, so the secret
grants that role nothing it did not already have. Moving to vault is a change to
`notify_comment_mention()` alone.

**Why not a Supabase Dashboard Database Webhook:** it would do the same job in two
clicks and live nowhere in this repo. We were already burned once by a load-bearing
untracked dashboard setting (the Supabase auth email templates). This file is
reviewable, diffable and re-runnable; a dashboard toggle is none of those.

---

## The Lambda

**Auth:** `X-Sundial-Comment-Secret`, constant-time compared via the shared
`lib/secure-compare.js`. **Not a portal JWT** — the caller is Postgres, which has no
Sundial user and no Supabase session. **An unset secret rejects everything (401)**; this
route emails comment bodies to addresses derived from caller-supplied ids, so it is the
last place to be lenient.

This is the **third** public non-JWT route, after the Aurora doorbell and the Retell
webhook, and follows the same discipline as both.

### Flow

1. Load the mention row (by `mention_id`, or by `comment_id` + `mentioned_user_id` for
   a manual replay).
2. **`notified_at` set → `already_notified`**, stop.
3. Load the comment.
4. **Self-mention** → skip.
5. Load `user_preferences`. **A missing row means alerts ON.**
6. **Tenant guard** (below).
7. Resolve the recipient's address from **`auth.users`** via the service role.
8. Build the subject, body and link.
9. **`isEmailConfigured()` false** → `email_not_configured`, stop.
10. Send, then stamp `notified_at`.

### Every skip is a success

| Outcome | HTTP | `reason` | Stamped? |
|---|---|---|---|
| Sent | 200 | — | ✅ |
| Recipient has alerts off | 200 | `alerts_disabled` | ❌ |
| Recipient is the comment author | 200 | `self_mention` | ❌ |
| Recipient has no email address | 200 | `no_recipient_email` | ❌ |
| SES not wired yet | 200 | `email_not_configured` | ❌ |
| Cross-tenant (should never happen) | 200 | `cross_tenant` | ❌ |
| Already notified | 200 | `already_notified` | (was) |
| Mention / comment row missing | 404 | — | ❌ |
| Send failed, DB read failed, auth lookup failed | 502 | — | ❌ |

pg_net does not retry a 200, which is what we want — redelivering a mention whose
recipient has alerts off achieves nothing but log noise. **Nothing stamps `notified_at`
on a skip**, so a recipient who turns alerts back on, or an SES that comes online later,
is still reachable by a replay.

### Idempotency

`comment_mentions.notified_at`, stamped **only after a successful send**. pg_net can
redeliver and a human can replay; neither should double-email.

If the send succeeds but the stamp fails, the call still returns **200** with
`stamped: false` — the email *has* been delivered, and reporting failure would invite a
replay and a duplicate.

### `email_not_configured` ships the feature early

`lib/email.js` is a scaffold; `EMAIL_FROM` is not set anywhere yet. Rather than block,
the Lambda evaluates every other condition, logs, and returns a degraded success —
mirroring the Design Request behaviour. **The whole feature can be deployed and the
trigger enabled before SES lands**, and because nothing is stamped, the backlog is
replayable once it does:

```sql
select id, comment_id, mentioned_user_id, created_at
  from comment_mentions where notified_at is null order by created_at desc;
```

### The tenant guard

Defence in depth, and not in the original spec. The mention was inserted by a browser
under RLS, which already scopes it — but this path **emails a comment body**, so a
cross-tenant mention would be a data leak nobody ever sees. It skips only when both
tenants are known **and** differ; a missing profile (a user who has never hit
`/auth/me`) must not block a real alert. It should never fire.

---

## Email content

**Subject:** `{author} mentioned you on {record label}`

The label is looked up **from the Supabase cache**, never Salesforce — a subject line is
not worth a Salesforce API call, and a stale customer name in a subject is harmless in a
way a stale contract value is not. First non-empty column wins; a cache miss falls back
to `{object} {id}`.

| Object | Cache table | Columns tried, in order |
|---|---|---|
| `customer` | `sundial_customer_cache` | `customer_name`, `name` |
| `solar` | `sundial_solar_cache` | `customer_name_at_creation`, `project_name`, `address_at_creation` |
| `roofing` | `sundial_roofing_cache` | same as solar |

**Body:** the commenter's name, the comment text **in full**, and a link. The text is
not truncated — this is a notification whose whole job is to save the reader a trip to
the portal, and a clipped body sends them there anyway. It is HTML-escaped.

### The link map

`${PORTAL_BASE_URL}` + one of:

| `comments.record_object` | Path |
|---|---|
| `customer` | `/customers/{id}` |
| `solar` | `/projects/solar/{id}` |
| `roofing` | `/projects/roofing/{id}` |
| **anything else** | **`/dashboard`** + a `WARN` |

**Never guess a path.** A link built from an unknown key would 404, and a 404 from a
notification email reads as "the portal is broken" rather than "we don't support that
link yet" — the reader cannot tell the difference. The dashboard always exists, and the
email keeps everything except the shortcut.

**When the Service module lands it gets one entry** in `RECORD_PATHS` in `content.js`.
Until then, service comments log a warning naming exactly that.

### Logging rules

Per the header of `lib/email.js`: **never log a comment body or a full recipient
address.** Identifiers are logged (mention id, comment id, the recipient's auth uuid),
because without them nothing here is diagnosable.

---

## Configuration

| Setting | Where | Resolution | Required |
|---|---|---|---|
| `COMMENT_NOTIFY_SECRET` | Secrets Manager `sundial/comment-notify` (fields `comment_notify_secret`, `webhook_secret`, `secret`) or env | **secret first**, env second | **Yes** — unset ⇒ 401 on everything |
| `PORTAL_BASE_URL` | env (or the same secret) | **env first** | No — defaults to `https://sundial.harmonelectric.net` |
| `EMAIL_FROM`, `SES_REGION`, `EMAIL_REPLY_TO`, `EMAIL_CONFIG_SET` | env | — | `EMAIL_FROM` needed to actually send |

Credentials resolve **secret-first** so they rotate without a redeploy (D-045);
`PORTAL_BASE_URL` is an address, not a credential, so the env var is the per-tenant knob.

```powershell
aws secretsmanager create-secret --name sundial/comment-notify --region us-west-1 `
  --secret-string '{"comment_notify_secret":"<generate a long random string>"}'

# ⚠️ update-function-configuration REPLACES the whole Variables map.
aws lambda get-function-configuration --function-name sundial-comment-notify `
  --region us-west-1 --query 'Environment.Variables'

aws lambda update-function-configuration --function-name sundial-comment-notify --region us-west-1 `
  --environment "Variables={PORTAL_BASE_URL=https://sundial.harmonelectric.net}"
```

**IAM:** the execution role needs `secretsmanager:GetSecretValue` for
`sundial/comment-notify` (confirm the existing `sundial/*` pattern covers it) and
`ses:SendEmail` for the send step.

---

## Deploy order

**Wire and verify the route BEFORE applying the trigger migration.** The trigger starts
posting the moment the database settings are set, and a 404 from an unwired route is a
silently lost notification — the trigger swallows it by design.

1. `sql/sundial_user_preferences.sql` (independent of everything else; unblocks the
   harmon-crm Settings UI immediately)
2. Create the Lambda, `.\deploy.ps1 sundial-comment-notify`
3. Secret + env vars
4. `.\scripts\wire-comment-mention-route.ps1`
5. **Verify it fails closed:** an unsecreted POST must return 401
6. `sql/sundial_comment_mention_notify.sql`
7. `alter database postgres set …` for the URL and secret
8. Post a test comment mentioning someone and check `net._http_response`

---

## Operating

```sql
-- Recent pg_net attempts and what came back. A 401 here means the secret drifted
-- between the database setting and Secrets Manager.
select id, status_code, error_msg, created
  from net._http_response order by created desc limit 20;

-- Mentions still awaiting a notification.
select id, comment_id, mentioned_user_id, created_at
  from comment_mentions where notified_at is null order by created_at desc;

-- Pause notifications without dropping anything (e.g. during a mail incident):
alter database postgres reset sundial.comment_notify_url;
```

CloudWatch: `/aws/lambda/sundial-comment-notify`. Every skip logs its reason with the
mention id.

---

## Testing

`npm test` — 33 tests in `lambdas/sundial-comment-notify/test.js`. The ones that matter
most are the ones deciding whether a real person gets an email they should not, or
misses one they should: a **missing preferences row sends** (the whole contract of the
no-backfill design), alerts-off / self-mention / already-notified do not, an unknown
`record_object` links to `/dashboard` and still sends, `email_not_configured` degrades
without stamping, a failed send returns 502 without stamping, and the secret gate
rejects before any work.

**Not verified end to end** — that needs the migrations applied, the route wired, and
`EMAIL_FROM` set.
