# Notifications — the bell, browser pop-ups and Web Push (`lib/notify.js` + `sundial-notify`)

**Status:** built 2026-09-21 (D-074). Two audiences, seven categories, one notifier.

This page is the runbook: what to create, what to paste where, who hears what, and what to check when somebody says they were not told.

## Who hears what

| Audience | Category | Fires when | Where it lands |
|---|---|---|---|
| Tech | `schedule` | the office puts a call on their board, moves it, gives it to someone else, cancels it | `/tech/calls/{id}` (or `/tech`) |
| Tech | `reminder` | ~5 pm the day before (tomorrow's calls in one line); one hour before each call | `/tech` / the call |
| Tech | `customer_text` | the customer texts back on a job the tech is on today (live, or scheduled for today) | `/tech/jobs/{id}` |
| Tech + office | `mention` | someone @-mentions them in a note (after the same guards the email has) | the record |
| Office | `tech_activity` | a tech clocks in, completes, marks a no-show — or a call is still `Scheduled` 30 minutes past its start | the job |
| Office | `money` | approved / declined online, deposit or invoice paid, a card failed, club join / ended / past due / cancellation scheduled | the estimate / job / membership |
| Office | `customer_message` | an inbound text (matched or not), a website call-me, an online booking | the job (or `/service`) |

"The office" = everyone in the tenant whose `profiles.access_scope` is `tenant`, minus whoever did the thing. **"On my way" does not ring the office** — the board's live blocks carry it; seven techs a morning would be noise.

Each person can switch a category off in **Settings → Notifications** (a missing switch is ON), and can turn browser pop-ups off separately. The `mention` bell is independent of the "Email me when I'm @-mentioned" switch.

## The three deliveries

1. **The bell** — a row in `sundial_notifications`, read by the browser under RLS (own rows). Always.
2. **An open tab** — the Lambda broadcasts on `user:{profile_id}:notify`; the portal prepends the row at once and, if the tab is open but not in front, shows a native browser notification (the `browser` switch).
3. **Push** — every device the person turned push on (`sundial_push_subscriptions`), through the Web Push service of that browser (Apple / Google / Mozilla), no tab needed. A push and a pop-up for the same event collapse by `tag`.

Recipients are Supabase auth uuids. A Salesforce `Sundial_User__c` id (a call's `Tech__c`) is translated through `profiles.sundial_user_id`, which `sundial-auth-proxy` writes on every `/auth/me` — **a tech who has never signed in to Sundial has no profile and gets nothing.**

## One-time setup (Tim)

1. **Supabase SQL editor:** run `sql/sundial_notifications.sql` (two tables + `user_preferences.notify_prefs`; re-runnable).
2. **VAPID keys → Secrets Manager `sundial/push`.** From the `sundial-core` folder (after `npm install`):
   ```powershell
   node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
   ```
   Paste the output into a new secret `sundial/push` and add a subject:
   ```json
   { "publicKey": "B…", "privateKey": "…", "subject": "mailto:support@constructiveoperations.com" }
   ```
   The private key goes there and nowhere else. The Lambda roles that notify need `secretsmanager:GetSecretValue` on it, like the other `sundial/*` secrets (`sundial-lambda-execution-role` already has the wildcard). Rotating the pair later orphans every subscription — everyone turns push on again.
3. **Create the Lambda** `sundial-notify` in the console like `sundial-sms` (Node 22.x, `index.handler`, role `sundial-lambda-execution-role`, 30 s timeout), then `.\deploy.ps1 sundial-notify`. Optional env: `SERVICE_TIMEZONE` (default `America/Phoenix`), `REMINDER_HOUR` (default `17`).
4. `.\scripts\wire-notify-routes.ps1` — the four `/notify/*` routes, the invoke permission, **and** the EventBridge rule `sundial-notify-sweep` (`rate(5 minutes)`) that runs the reminder sweep; deploys the API.
5. **Redeploy the emitters:** `sundial-auth-proxy` (the new `notify.self` action in `lib/access.js`), `sundial-service-board`, `sundial-sms`, `sundial-service-estimate`, `sundial-service-public`, `sundial-comment-notify`.
6. Push the portal (Vercel). Then, in the portal: bell → gear → **Turn on** → **Send me a test**. On a phone: open the tech app from the Home Screen and tap **Turn on** on the banner.

## Devices

- **Desktop Chrome / Edge / Firefox:** works from the tab. Safari on Mac 16+: works.
- **iPhone / iPad:** push works **only from the Home-Screen app** (Share → Add to Home Screen, iOS 16.4+). The banner and Settings say so instead of failing. The tech app already asks to be installed.
- **Android:** works from Chrome, better from the installed app.
- A device that uninstalled / cleared site data answers 404 / 410 to the push service — the subscription row is deleted on the next send. Any other failure is stamped on the row (`failed_at`, `fail_reason`) and retried next time.
- Sign-out / sign-in on a shared device: the endpoint is unique per browser install, so re-subscribing moves the row to whoever is signed in now.

## When somebody says they were not told

1. **Is there a row?** Supabase → `sundial_notifications` where `profile_id` = their auth uuid, newest first. No row → the emitter did not fire (CloudWatch on the Lambda that owned the event: `notify: <category>/<kind> → N of M (K opted out, P pushes)`), or the category is off (`user_preferences.notify_prefs`), or — for a tech — `profiles.sundial_user_id` is empty (they have never signed in).
2. **Row but no push?** `pushed_at` empty + `push_error` names the push service's answer. No subscription row → push is off on that device (Settings shows "Off"). `sundial/push` missing → CloudWatch `push disabled`.
3. **Row, pushed, nothing on the phone?** iPhone from a Safari tab (not installed); notifications off for the site in the browser / OS settings; Focus mode.
4. **Rang twice?** It should not: check the `dedupe_key` — two rows with different keys are two events (a genuine second move carries a new start time).
5. **Reminders missing?** EventBridge → `sundial-notify-sweep` → last invocation; CloudWatch `notify sweep: {"oneHour":…}`; `REMINDER_HOUR` in the right zone.

## Security

- The recipient / owner of every subscription is the verified JWT subject; the browser cannot subscribe anyone else or read anyone's endpoints (no browser policy on `sundial_push_subscriptions` at all).
- The private VAPID key is only ever in Secrets Manager and Lambda memory; the public key is public by design.
- A notification body is customer data: the module logs counts and categories, never a title, a body, an endpoint or a key.
- `sundial_notifications`: `SELECT` own rows, `UPDATE (read_at)` own rows, nothing for `anon`; every insert comes from the service role.
