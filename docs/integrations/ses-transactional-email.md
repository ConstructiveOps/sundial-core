# Application email via SES (`lib/email.js`)

**Status:** ✅ LIVE as of 2026-08-19. Design Request notifications, signed-agreement /
cancellation notifications, and (once deployed) @-mention alerts all send.

---

## Two email paths, one domain — do not confuse them

Sundial sends email two completely independent ways. They share **only** the verified
SES domain identity. A change or a failure in one says nothing about the other, and
conflating them has already cost real debugging time.

| | **Auth email** | **Application email** |
|---|---|---|
| What | Supabase invite / password reset | Design Request, signed agreement, @-mentions |
| Path | Supabase Auth → **Custom SMTP** → SES | Lambda → `lib/email.js` → **SES SDK** |
| Credential | SES SMTP username/password (IAM user `sundial-ses-smtp`) | Lambda execution role IAM |
| Config lives in | The Supabase dashboard | Lambda environment variables |
| Runbook | `auth-email-ses.md` | **this file** |
| Decision | D-046 | D-047 / D-056 |

Both send **from `sundialcrm.com`**, which is why a deliverability problem (SPF, DKIM,
DMARC, reputation, suppression) affects both at once — and why a bounce/complaint
problem on notification email is a risk to the **login flow**, not just to
notifications. That is the whole reason for the configuration set below.

---

## The identity

**`sundialcrm.com`**, a DOMAIN identity in **us-west-1**. Verified 2026-08-02; out of
the SES sandbox since 2026-08-03 (support case 178572585300376).

```
VerificationStatus:    SUCCESS          DkimAttributes.Status:  SUCCESS (RSA-2048)
ProductionAccessEnabled: true           MailFromDomain:         mail.sundialcrm.com
EnforcementStatus:     HEALTHY          MailFromDomainStatus:   SUCCESS
SendQuota:             50,000 / 24h at 14/sec
```

> **Do NOT create a second identity.** An older TASKS.md entry recommended
> `mail.constructiveoperations.com`; that text predates the auth-email work and was
> never acted on. A second sending domain would split reputation across two domains
> for no gain, and would need its own DKIM/SPF/DMARC to reach the state
> `sundialcrm.com` is already in. If you are reading this because email is broken,
> fix the existing identity — do not start a new domain setup.

**Deliverability state** (see `auth-email-ses.md` for the full history): custom MAIL
FROM makes SPF *align* with the From domain, DKIM signs as `sundialcrm.com`, and a
single `p=quarantine` DMARC record sits at `_dmarc.sundialcrm.com` (a duplicate record
was removed 2026-08-18 — more than one is invalid and receivers treat the domain as
having no policy at all).

`VerificationInfo.ErrorType` may still read `HOST_NOT_FOUND` while
`VerificationStatus` is `SUCCESS`. That is a stale artifact of the old misconfigured
MAIL FROM, not a live fault. Trust `MailFromDomainStatus`.

---

## IAM

The only SES call anywhere in this codebase is **`SESv2 SendEmail` with
`Content.Simple`**, in `lib/email.js`. Consequences:

- `ses:SendEmail` is sufficient.
- **`ses:SendRawEmail` is NOT reached** — there is no raw-MIME path — so it does not
  belong in the policy. (The SMTP credential for *auth* email does need it; that is a
  different IAM principal entirely.)

**Current state (2026-08-19):** `sundial-lambda-execution-role` carries the managed
**`AmazonSESFullAccess`**. None of its three inline policies mentions SES. Sending
therefore works, but with far more privilege than the code uses.

A scoped replacement was drafted and deliberately **not applied** (Tim's call):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "SendTransactionalEmailFromSundialcrmIdentity",
    "Effect": "Allow",
    "Action": "ses:SendEmail",
    "Resource": "arn:aws:ses:us-west-1:891377232720:identity/sundialcrm.com"
  }]
}
```

If you ever tighten this, note that **adding the inline policy alone changes nothing** —
an Allow does not restrict. `AmazonSESFullAccess` has to come off in the same pass, and
the role would then be unable to send from any future identity until the resource ARN
is updated. That is the intended trade, not a surprise.

---

## Per-Lambda environment variables

| Variable | Value |
|---|---|
| `EMAIL_FROM` | `Sundial <no-reply@sundialcrm.com>` |
| `EMAIL_REPLY_TO` | `tim@constructiveoperations.com` |
| `SES_REGION` | `us-west-1` |
| `EMAIL_CONFIG_SET` | `sundial-transactional` |
| `DESIGN_REQUEST_NOTIFY_TO` / `_CC` | aurora-push + aurora-inbound only |

Set on **`sundial-aurora-push`** and **`sundial-aurora-inbound`**.
**`sundial-comment-notify` is not deployed yet** — see the hand-off command below.

### Why `EMAIL_REPLY_TO` is not optional in practice

`no-reply@sundialcrm.com` sends fine, because the whole domain is verified — but **no
mailbox exists behind it.** A Harmon employee who reads a notification and hits Reply
gets a bounce, and nobody finds out. `EMAIL_REPLY_TO` points replies at a monitored
address.

**This is a per-tenant value.** The From is correctly tenant-neutral
(`no-reply@sundialcrm.com` is the platform, not the client); the reply target is not. A
second tenant must override it with their own monitored address, or their customers'
replies land in Constructive Operations' inbox.

### ⚠️ The `update-function-configuration` trap

`--environment` **replaces the entire Variables map.** It does not merge. Every affected
Lambda already carries variables that have nothing to do with email:

- `sundial-aurora-inbound` — `DESIGN_REQUEST_NOTIFY_TO` / `_CC`, and `SUNDIAL_TENANT_SLUG`
  where it is set
- `sundial-comment-notify` — `COMMENT_NOTIFY_SECRET`, `PORTAL_BASE_URL`

**Neither failure announces itself.** A dropped `COMMENT_NOTIFY_SECRET` fails the
webhook closed (every mention alert silently 401s); a dropped `SUNDIAL_TENANT_SLUG`
silently mis-tenants auto-created dealer customers. Always:

1. `get-function-configuration --query 'Environment.Variables'`
2. merge into a JSON file and apply it with `--environment file://env.json`
3. **re-read and diff against what you intended**

Use a JSON file rather than the `Variables={...}` shorthand: `EMAIL_FROM` contains
spaces and angle brackets, and the shorthand treats `,` and `=` as delimiters.

### Hand-off: `sundial-comment-notify` at deploy

Run this **after** creating the function, and merge in whatever it already carries:

```powershell
aws lambda get-function-configuration --function-name sundial-comment-notify `
  --region us-west-1 --query 'Environment.Variables'   # merge these in first!

aws lambda update-function-configuration --function-name sundial-comment-notify `
  --region us-west-1 --query 'Environment.Variables' `
  --environment "Variables={EMAIL_FROM=Sundial <no-reply@sundialcrm.com>,EMAIL_REPLY_TO=tim@constructiveoperations.com,SES_REGION=us-west-1,EMAIL_CONFIG_SET=sundial-transactional,PORTAL_BASE_URL=https://sundial.harmonelectric.net,COMMENT_NOTIFY_SECRET=<value>}"
```

> Prefer the `sundial/comment-notify` **secret** for `COMMENT_NOTIFY_SECRET` — it wins
> over the env var and rotates without a redeploy. The env var is a fallback.

---

## Bounce and complaint tracking

Configuration set **`sundial-transactional`**, with a CloudWatch event destination
`cloudwatch-bounce-complaint` on **BOUNCE, COMPLAINT, DELIVERY, REJECT** and dimension
`configuration-set`.

**Where to look:** CloudWatch → Metrics → **`AWS/SES`** → filter
`configuration-set = sundial-transactional`. Or:

```bash
aws cloudwatch get-metric-statistics --namespace AWS/SES --metric-name Bounce \
  --dimensions Name=configuration-set,Value=sundial-transactional \
  --start-time <T-24h> --end-time <now> --period 3600 --statistics Sum --region us-west-1
```

Reputation metrics are enabled on the set, so bounce/complaint **rates** also appear in
the SES console under Account dashboard.

Deliberately **no SNS→Lambda pipeline**. The requirement is that the signal exists and
someone can look at it — not a bespoke alerting stack. If bounces ever become routine,
the account-level suppression list (`BOUNCE`, `COMPLAINT`) is already on and will stop
repeat sends to a bad address on its own.

---

## Verifying it actually works

Two different claims, and the second is the one that matters:

1. **SES accepts a send** — `lib/email.js` returns `{ ok: true, messageId }`.
2. **The feature path sends** — the consuming Lambda no longer degrades.

A working SES call proves nothing about the feature, because every consumer is
deliberately best-effort: `isEmailConfigured()` returns false when `EMAIL_FROM` is
unset and the caller logs and continues. That is the right design — an email problem
must not fail an Aurora push — and it is exactly why this went unnoticed. **Check the
feature response, not just SES:**

```
# Design Request — the email step in the response body
"email": { "sent": true, "messageId": "…", "recipients": { "to": 1, "cc": 1 } }

# was, before this was wired:
"email": { "sent": false, "reason": "email_not_configured" }
```

On the received message, **"Show original" must report SPF, DKIM and DMARC all PASS,
and SPF must show `mail.sundialcrm.com` — not `amazonses.com`.** The `amazonses.com`
form means SPF passes without *aligning* to the From domain, which is the state the
custom MAIL FROM exists to fix.
