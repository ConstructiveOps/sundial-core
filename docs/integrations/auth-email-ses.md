# Auth Email via Supabase Custom SMTP (Amazon SES)

**Status:** setup guide — Tim performs the dashboard/console steps (Claude Code can't
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
   | Port | `465` |
   | Username | *(SES SMTP Username from Part A step 6)* |
   | Password | *(SES SMTP Password from Part A step 6)* |
   | Minimum interval between emails | `60` seconds (default is fine) |

   > Port 465 = implicit TLS and is the most reliable with SES. If Supabase reports a
   > TLS/connection error on 465, switch to **587** (STARTTLS) — SES supports both.

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
| **Site URL** | `https://harmon-crm.vercel.app` |
| **Redirect URLs** (add each) | `https://harmon-crm.vercel.app/reset-password` |
| | `https://harmon-crm.vercel.app/**` |
| | `http://localhost:5173/reset-password` *(local dev)* |
| | `https://*.vercel.app/**` *(only if you test on Vercel preview deploys)* |

Both flows land on `/reset-password`:
- **Invite** redirect is built server-side from `PORTAL_BASE_URL` (defaults to
  `https://harmon-crm.vercel.app`, which is correct — see Part D).
- **Reset** redirect is `window.location.origin + /reset-password` (the domain the
  user is on).

---

## Part D — `PORTAL_BASE_URL` on the invite Lambda (optional, already correct by default)

The `sundial-user-admin` Lambda builds the invite link from `PORTAL_BASE_URL`. It is
currently **unset**, so it falls back to the in-code default
`https://harmon-crm.vercel.app` — which is the real prod URL, so invites already point
to the right place.

Set it explicitly anyway (documents intent; makes a future domain change a config
change, not a code edit). From the repo root:

```powershell
aws lambda update-function-configuration `
  --function-name sundial-user-admin `
  --region us-west-1 `
  --environment "Variables={PORTAL_BASE_URL=https://harmon-crm.vercel.app}"
```

> ⚠️ `update-function-configuration` **replaces** the entire Variables map. If the
> function has other env vars, include them in the same command or they'll be dropped.
> Check first with:
> `aws lambda get-function-configuration --function-name sundial-user-admin --region us-west-1 --query 'Environment.Variables'`
> (At time of writing it returned `null` — no other vars — so the command above is safe.)

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

---

## ⚠️ Deployment ordering (important)

The frontend now **defaults new users to "Send email invite"**
(`harmon-crm/src/pages/settings/UserFormModal.tsx`). Deploy that frontend change
**only after Parts A–C are done and the manual invite test passes** — otherwise every
new user gets an invite that doesn't deliver. Until then, admins can still pick the
temp-password fallback in the create dialog.
