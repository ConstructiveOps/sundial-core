# Auth Email via Supabase Custom SMTP (Amazon SES)

**Status:** ✅ LIVE as of 2026-08-12. Invite and password-reset email deliver through
SES. Setup steps below remain the reference for standing up a new tenant.

---

## ⚠️ Read this first: how this broke, and the two traps

Auth email was dead for weeks. The cause was a **single wrong field**, and both traps
below are easy to fall into again on the next tenant.

**Root cause: the SMTP username was never an SES credential.** Supabase held
`aW5wLWt1NnhraHhzbjdmcTZ1cG9ybXNpbHQ3Nw==` — base64 for
`inp-ku6xkhxsn7fq6upormsilt77`. An SES SMTP username is *always* the 20-character
`AKIA…` access key ID. Neither the raw nor decoded form was AKIA-shaped, and neither
matched any key in AWS account `891377232720`. Host, port, and sender were correct
the whole time, which is exactly why repeated inspection kept missing it.

**Trap 1 — a 200 from `/auth/v1/recover` does NOT mean mail was sent.** It means
Supabase accepted the request. With custom SMTP *disabled*, the built-in sender
returns 200 and then fails to deliver externally. During this incident a `535 → 200`
transition was read as "auth fixed"; it was actually a toggle flip from a broken
custom SMTP to the broken built-in sender. **The only trustworthy signal is SES
itself:**

```bash
aws sesv2 get-account --region us-west-1 --query 'SendQuota.SentLast24Hours'
aws cloudwatch get-metric-statistics --namespace AWS/SES --metric-name Send \
  --start-time <T-1h> --end-time <now> --period 60 --statistics Sum --region us-west-1
```

Both lag ~2 minutes and are otherwise reliable. Zero sends means nothing reached SES,
whatever Supabase reported.

**Trap 2 — SMTP auth failing looks identical to SES being broken.** Bisect by sending
around Supabase entirely before touching its config:

1. `lib/email.js` (SES SDK) → tests identity, production access, delivery.
2. A raw SMTP session → tests the credential, region salt, port, and TLS.

If both pass and Supabase still fails, the problem is Supabase's config, not SES.
`scripts/` has no committed harness for step 2; the throwaway used here connected with
`node:tls` on 465 and `node:net` + STARTTLS on 587, then walked `EHLO → AUTH LOGIN →
MAIL FROM → RCPT TO → DATA`, printing every server reply verbatim. Both ports work.

**Trap 3 — a single-use link can be spent before the human clicks it.** Invite and
reset links reported "expired" when clicked within seconds. Not an expiry problem: a
link redeemed at t=0 works and is good for an hour. Recovery links are **single use**,
and mail security scanners (Defender Safe Links, AV, spam filters) prefetch every URL
in a message — so the scanner's GET spends the token and the human gets
`#error=access_denied&error_code=otp_expired`. Junk-foldered mail is scanned hardest,
which is why this showed up alongside the deliverability problem.

The fix is **deferred redemption**: the email links to *our* page carrying
`?token_hash=…&type=recovery|invite`, and `/reset-password` redeems it (`verifyOtp`)
only on form submit. Loading the page redeems nothing, so neither a fetch-only scanner
nor one that executes the JS can burn it. Verified: the token survived three
prefetches, then verified and set a password. This requires the **email templates** to
emit that shape:

```
{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery   (Reset Password)
{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite     (Invite user)
```

`{{ .RedirectTo }}` only renders if the target is in the Redirect URLs allowlist
(Part C). Never point an auth email at Supabase's `/auth/v1/verify` again — that
endpoint spends the token on GET, which is the whole problem.

### Deliverability (`sundialcrm.com`)

Mail was landing in Junk. Two real causes, one fixed here:

- **SPF did not align.** The apex SPF is `v=spf1 include:spf.protection.outlook.com
  -all` (Outlook only, no SES). SES was falling back to `amazonses.com` as the
  envelope domain, so SPF *passed* but did not **align** with `sundialcrm.com`, which
  is what DMARC checks. The custom MAIL FROM had been set to
  `mail.sundialcrm.com.sundialcrm.com` — a doubled suffix that could never resolve.
  **Fixed:** pointed it at `mail.sundialcrm.com`, whose DNS was already correct
  (`MX → feedback-smtp.us-west-1.amazonses.com`, `TXT "v=spf1 include:amazonses.com
  ~all"`). Now `MailFromDomainStatus: SUCCESS` — SPF aligns, DKIM already passed, so
  DMARC is satisfied on both.
- **Two conflicting DMARC records** at `_dmarc.sundialcrm.com` (`p=quarantine` and
  `p=none`). Publishing more than one is invalid; receivers treat the domain as having
  no usable policy. **Still outstanding** — needs one deleted in GoDaddy DNS.

---

**Setup guide below** — Tim performs the dashboard/console steps (Claude Code can't
reach the Supabase or SES consoles). Follow the parts **in order**.

## Why this exists

Supabase's *built-in* email sender does not reliably deliver to external recipients
(it's meant for demos, and is hard rate-limited to a few messages/hour). That is the
root cause of the provisioning incident:

- **Invite emails** (`inviteUserByEmail`) never arrived → invited users had no way to
  set a password.
- **Password-reset emails** (`resetPasswordForEmail`) never arrived.

The fix is to point Supabase Auth at **our own SMTP relay = Amazon SES**, which is now
verified and out of sandbox for `sundialcrm.com` (us-west-1). Once configured, **both**
invite and reset emails flow through SES and actually get delivered.

> This is ONLY for Supabase **auth** emails (invite / reset / confirm). Application
> transactional email (notifications, etc.) is a separate path via `lib/email.js`
> (SES SDK). They don't overlap.

---

## Part A — Create SES SMTP credentials (AWS Console)

SMTP credentials are **not** your normal AWS access keys. SES derives a dedicated SMTP
username/password from a small IAM user. Create them like this:

1. Sign in to the AWS Console. Top-right region selector → **US West (N. California)
   `us-west-1`**. (Must match where the domain is verified.)
2. Go to **Amazon SES** → left nav **SMTP settings**.
3. Note the **SMTP endpoint** shown: `email-smtp.us-west-1.amazonaws.com`.
4. Click **Create SMTP credentials**.
5. It opens IAM with a suggested user name (e.g. `ses-smtp-user.20260803`). Leave the
   default; it auto-attaches a policy granting `ses:SendRawEmail`. Click **Create user**.
6. On the result screen you get an **SMTP Username** and **SMTP Password**.
   - **Download the CSV** or copy both now — the password is shown **once**.
   - The SMTP password is NOT the IAM secret access key; it's the derived SMTP secret.
     Use exactly what this screen shows.
7. Keep these two values for Part C.

> If you ever lose the password, you can't retrieve it — just create a new SMTP
> credential and update Supabase.

### Sanity check before you leave this step

**The username you paste into Supabase must start with `AKIA` and be 20 characters.**
If it doesn't, it isn't an SES credential and nothing will ever send — that was the
entire root cause of the 2026-08 outage. Confirm the key belongs to *this* account:

```bash
aws iam list-users --query 'Users[].UserName' --output table
aws iam list-access-keys --user-name <the-smtp-user> --output table
```

### Current credential (Harmon)

IAM user **`sundial-ses-smtp`** in `891377232720`, inline policy `SesSmtpSending`
granting `ses:SendRawEmail` + `ses:SendEmail` only. Username is its access key ID.

The SMTP password is derived from the IAM secret, not the secret itself — a SigV4
chain over fixed date `11111111`, service `ses`, terminal `aws4_request`, message
`SendRawEmail`, prefixed with version byte `0x04`, base64-encoded. It is **salted with
the region**, so a password minted for one region fails auth against another region's
endpoint. If you rotate the key, re-derive rather than pasting the raw secret.

### Verify the sender is usable
The sender for auth email is **`harmon@sundialcrm.com`**. Because the whole domain
`sundialcrm.com` is a verified SES identity and out of sandbox, this address can send
to any recipient (harmonelectric.net, gmail, etc.) with no per-address verification.
Nothing to do here unless SES shows the domain as anything other than **Verified**.

---

## Part B — Configure Supabase Custom SMTP

Project: **`qfsdpkwxahakegjnyijj`** (the portal's Supabase project).

1. Supabase Dashboard → this project → **Authentication** → **Emails** →
   **SMTP Settings** (tab may be labeled "SMTP" / "Custom SMTP").
2. Toggle **Enable Custom SMTP** ON.
3. Enter these **exact** values:

   | Field | Value |
   |---|---|
   | Sender email | `harmon@sundialcrm.com` |
   | Sender name | `Harmon Electric` |
   | Host | `email-smtp.us-west-1.amazonaws.com` |
   | Port | `587` |
   | Username | *(SES SMTP Username from Part A step 6 — must be `AKIA…`)* |
   | Password | *(SES SMTP Password from Part A step 6)* |
   | Minimum interval between emails | `60` seconds (default is fine) |

   > Both **587** (STARTTLS) and **465** (implicit TLS) were verified working against
   > SES with a real SMTP session. Harmon runs 587. Either is fine; if one reports a
   > TLS/connection error, switch to the other.

4. **Save**.
5. Raise the auth email rate limit: **Authentication** → **Rate Limits** → set
   **Emails per hour** up from the tiny built-in default (e.g. `100`). The built-in
   cap is why bulk-provisioning silently dropped emails.

---

## Part C — URL Configuration (redirect allowlist)

Invite and reset links only work if the redirect target is allowlisted. Supabase
refuses to redirect anywhere else.

Supabase Dashboard → **Authentication** → **URL Configuration**:

| Field | Value |
|---|---|
| **Site URL** | `https://sundial.harmonelectric.net` |
| **Redirect URLs** (add each) | `https://sundial.harmonelectric.net/reset-password` |
| | `https://sundial.harmonelectric.net/**` |
| | `https://harmon-crm.vercel.app/**` *(retained: old domain now redirects)* |
| | `http://localhost:5173/reset-password` *(local dev)* |
| | `https://*.vercel.app/**` *(only if you test on Vercel preview deploys)* |

Both flows land on `/reset-password`:
- **Invite** redirect is built server-side from `PORTAL_BASE_URL` (see Part D).
- **Reset** redirect is `window.location.origin + /reset-password` (the domain the
  user is on).

> ⚠️ Because the reset flow follows `window.location.origin`, a portal domain change
> breaks password resets the moment users land on the new domain — until the new
> origin is in the allowlist above. The Supabase allowlist is a **dashboard** change;
> it is not covered by any repo deploy (D-053).

---

## Part D — `PORTAL_BASE_URL` on the invite Lambda (set)

The `sundial-user-admin` Lambda builds the invite link from `PORTAL_BASE_URL`. As of
the domain cutover (D-053) it is **set explicitly** to `https://sundial.harmonelectric.net`,
and the in-code default matches, so a lost env var degrades to the same working link
rather than the retired Vercel URL.

To re-apply or point it at a different tenant domain, from the repo root:

```powershell
aws lambda update-function-configuration `
  --function-name sundial-user-admin `
  --region us-west-1 `
  --environment "Variables={PORTAL_BASE_URL=https://sundial.harmonelectric.net}"
```

> ⚠️ `update-function-configuration` **replaces** the entire Variables map. If the
> function has other env vars, include them in the same command or they'll be dropped.
> Check first with:
> `aws lambda get-function-configuration --function-name sundial-user-admin --region us-west-1 --query 'Environment.Variables'`
> (`PORTAL_BASE_URL` is the only variable this function reads; the map was `null`
> before the cutover, so the command above was — and remains — safe.)

---

## Part E — Verify it works

After Parts A–C:

1. **Reset path:** portal `/login` → "Forgot password" → enter a real inbox you
   control → you should receive the email within ~30s (check spam once). The link →
   `/reset-password` → set a new password → lands in the app.
2. **Invite path:** Manage Users → create a user with **Send email invite** to an inbox
   you control → invite email arrives → link → `/reset-password` → set password → app.
3. Confirm the email **From** shows `Harmon Electric <harmon@sundialcrm.com>`.
4. Check SES **Account dashboard** → sending stats increment (and bounce/complaint
   rates stay near zero).

The end-to-end automated check in `scripts/verify-provisioning-e2e.mjs` (Step 5)
exercises the *temp-password* path without needing email; the two manual checks above
cover the *email* path.

### Secure password change interacts with this

The project has Supabase's secure password change enabled
(`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`). Consequences:

- **Password-session updates** (settings menu, and the mandatory first-login change
  after a temp password) **must send `current_password`** or GoTrue returns 400
  `current_password_required`. `ChangePasswordModal` does this.
- **Recovery-session updates are exempt** — the invite and forgot-password links land
  on `/reset-password` with a recovery token, so no current password is required.
  Verified against the live project by minting and redeeming a recovery link, not
  assumed from docs.
- When mapping errors, key on `AuthError.code`, never the message: GoTrue returns
  identical text for a *missing* and an *incorrect* current password, separated only
  by `current_password_required` vs `current_password_invalid`.

`verify-provisioning-e2e.mjs` asserts both directions — that the update succeeds with
`current_password` and is rejected without it — so the control can't be turned off
without the suite noticing.

---

## ⚠️ Deployment ordering (important)

The frontend now **defaults new users to "Send email invite"**
(`harmon-crm/src/pages/settings/UserFormModal.tsx`). Deploy that frontend change
**only after Parts A–C are done and the manual invite test passes** — otherwise every
new user gets an invite that doesn't deliver. Until then, admins can still pick the
temp-password fallback in the create dialog.
