# Customer texting — Twilio behind `sundial-sms`

**Status:** built 2026-09-15 (D-072 amendment 6). Harmon starts on Constructive Ops' A2P-registered number and moves to its own line once its registration is approved — a secret edit, not a deploy.

Twilio is the carrier; nothing in the portal says so (the client-facing product is Sundial). This page is the runbook: what to create, what to paste where, how a text finds its job, and what to check when it does not.

## What it does

| Direction | Trigger | What happens |
|---|---|---|
| Out | Office presses **Send text** on a job's Communications panel | `POST /service/jobs/{id}/sms` → Twilio `Messages` API from the tenant's number → row in `sundial_sms_messages` (`queued`) → broadcast → Twilio's status callback flips it to `sent` / `delivered` / `undelivered` / `failed` |
| In | Customer replies (or texts the number cold) | Twilio → `POST /sms/inbound` → signature check → tenant by the number it hit → job by the matching rules below → row (`received`) → broadcast to the job page |

The job page subscribes to `tenant:{tenantId}:sundial_service_job:{jobId}` (event `sms`), so a reply appears without a refresh.

## One-time setup (Tim)

1. **Secrets Manager `sundial/twilio`** (the Lambda's role needs `secretsmanager:GetSecretValue` on it, like the other `sundial/*` secrets):
   ```json
   { "accountSid": "AC…", "authToken": "…", "fromNumber": "+1480…",
     "tenantNumbers": {}, "defaultTenant": "harmon" }
   ```
   `fromNumber` is the shared Constructive Ops line. When Harmon's number is approved, add `"tenantNumbers": { "harmon": "+1602…" }` — sends switch within five minutes (the secret is cached that long) and inbound texts to the new number route to Harmon by the number itself.
2. **Create the Lambda** `sundial-sms` in the console with the same runtime / role / architecture / timeout as `sundial-service-board`, then `.\deploy.ps1 sundial-sms`.
3. **Env var** `SMS_WEBHOOK_BASE = https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod`. Twilio signs the *exact* URL it calls, so this must match what you paste into Twilio character for character (no trailing slash).
4. `.\scripts\wire-sms-routes.ps1` — adds the four routes and the invoke permissions, deploys the API.
5. **Supabase SQL editor:** run `sql/sundial_sms_messages.sql`.
6. **Twilio console → Phone Numbers → the number → Messaging → "A message comes in":** Webhook, `POST`, `https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/sms/inbound`. Nothing to set for status callbacks — each outbound message carries its own callback URL.
7. Redeploy `sundial-auth-proxy` (the new `service.sms.send` action lives in `lib/access.js`).

Test with the ZZ test job and your own mobile before pointing any real customer at it.

## How a reply finds its job

1. **The conversation we started** — the most recent outbound text *to that number* names the job. A reply belongs to the thing it answers, even if the customer has a newer job.
2. **The job's phone snapshot** — the tenant's jobs whose `Primary_Phone_at_Creation__c` ends in the same ten digits; open ones (not Closed / Cancelled) first, newest first.
3. **The customer hub** — `Sundial_Customer__c.Primary_Phone__c`, then that customer's latest open job.
4. **No match** — stored with no job (`GET /service/sms/unmatched`), logged as `matched=none`. Never dropped: a new customer texting the number for the first time is a lead, not noise. Surfacing that list in the portal is a follow-up (TASKS.md).

## Security

- The two webhooks are public routes with **no JWT**; the *only* gate is `X-Twilio-Signature` — base64 HMAC-SHA1 of the full URL plus the sorted form fields, keyed with the auth token — compared in constant time. No secret → every webhook is refused (fail closed), same discipline as the Aurora doorbell and the comment-mention route.
- The auth token is never logged; neither is a message body or a full phone number (last four digits only, in the tenant-routing warning).
- `sundial_sms_messages` has RLS on with `anon` and `authenticated` revoked: the browser cannot read it; the Lambda (service role) filters on `client_sf_id` on every read.

## When it does not work

| Symptom | Look at |
|---|---|
| Every inbound is 401 | `SMS_WEBHOOK_BASE` vs the URL in the Twilio console (scheme, host, `/prod`, no trailing slash). The log line names the URL the Lambda rebuilt. |
| "Texting isn't set up yet" in the portal | The secret is missing `accountSid` / `authToken`, or the role cannot read it. |
| "No sending number is configured" | Neither `tenantNumbers[slug]` nor `fromNumber` is set. |
| Sent but status stays "Sending…" | The status callback is not reaching `/sms/status` — same URL checks; or Twilio rejected the callback URL (must be https). |
| A reply landed on the wrong job | The matching order above; the office can see the row on the job it matched and the true job's page will show the next outbound. Re-keying a row is manual for now. |
| Text to a customer fails with code 30003 / 30005 | Twilio's side: unreachable / unknown destination. The row is kept as `failed` with the code so the office sees it. |
