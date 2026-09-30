# Demo tenant seed

`scripts/seed-demo-tenant.mjs` fills the **demo tenant** (`conops-demo`) with plausible,
entirely fictional data so Sundial can be shown to a prospect without a client's records
on screen. It writes to the **production** Salesforce org and the **production** Supabase
project, so it is built to be boring: it checks everything against the live org before it
writes one record, reads back the first record of each kind — and, for customers and solar
projects, the first record in each stage — before writing more, and can be run again after
any failure.

The code is in `scripts/demo-seed/`. The plan (what to write) is pure and deterministic;
the writing is separate. The tests run against a fake org and never touch anything real.

---

## What it creates

Counts are for one run; calls, tech days and activity rows vary by a few with the day of
the week the seed is first applied.

| Where | What | How many |
|---|---|---|
| Salesforce | `Sundial_Tenant__c` (`conops-demo`) | 1 |
| | `Sundial_Dealer__c` — Constructive Solar (in-house), Saguaro Ridge Solar, Copperline Energy | 3 |
| | `Sundial_User__c` — the eleven demo people listed under [The demo logins](#the-demo-logins) | 11 |
| | `Sundial_Customer__c` — leads, opportunities, customers, service-only customers | 100 |
| | `Sundial_Solar__c` — at least one in **33 of the 34** live stages; all 34 with `--with-sold-pending-review` | 50 |
| | `Sundial_Roofing__c` — three tied to a solar re-roof | 10 |
| | `Sundial_Price_Book_Item__c` | 28 |
| | `Sundial_Estimate__c` (45 with a job, 6 without) + `Sundial_Service_Line__c` | 51 + ~180 |
| | `Sundial_Service_Job__c` — every one of the 12 statuses | 45 |
| | `Sundial_Service_Call__c` — two weeks of history, today, a week ahead | ~90–95 |
| | `Sundial_Service_Invoice__c` / `Sundial_Service_Payment__c` | 10 / 12 |
| | `Sundial_Tech_Day__c` — this payroll week and last | ~21–23 |
| Supabase | 11 logins + `profiles` | 11 |
| | `comments` (no mentions) | ~76 |
| | `sundial_service_activity` | ~750–775 |
| | `sundial_sms_messages` (fake `DEMO…` ids, nothing is sent) | ~54 |
| | `sundial_notifications` — five bell rows each for Avery and Dana, of the kinds the portal itself writes | 10 |
| Secrets Manager | `sundial/demo-users` — the demo logins' passwords, plus the seed's own run record (`_run`: anchor date, seed, options — see [If the id-map is lost](#if-the-id-map-is-lost)) | 1 secret |
| S3 (only with `--with-files`) | sample PDFs stamped "SAMPLE - DEMO DATA" | 25 |
| Your PC | `migration/demo/id-map.json` (what was created) and `plan.json` (the preview) | 2 files |

**It never writes:** Commercial projects, purchase orders, Service Club plans or
memberships, comment mentions (a trigger emails on those), any Acumatica / Aurora /
Sunbase / Housecall Pro / Dropbox / mirror field, a Stripe id, or a value that names a
Harmon person or dealer.

**Everything is fake.** Phones are in the reserved fictional range (602/480/623 +
`555-01xx`), emails are `firstname.lastname@example.com`, every customer's notes start
with "DEMO DATA".

### The demo logins

The logins are `tim+demo-<firstname>@constructiveoperations.com` — plus-addresses of your
own mailbox, so a reset email reaches you and nobody else. Exactly these eleven:

| Login | Person | Access level | What they are for |
|---|---|---|---|
| `tim+demo-avery@constructiveoperations.com` | Avery Collins | **Executive**, and the tenant's **super admin** | Owner. Tenant-wide access, including payroll. |
| `tim+demo-dana@constructiveoperations.com` | Dana Kim | **Admin** | Office manager and **dispatcher**. Service department; sees payroll; every job is assigned to her. |
| `tim+demo-jordan@constructiveoperations.com` | Jordan Reyes | Manager | Solar project manager. |
| `tim+demo-casey@constructiveoperations.com` | Casey Tran | Manager | Roofing project manager (every roofing job is hers). |
| `tim+demo-sam@constructiveoperations.com` | Sam Whitaker | Sales Rep | In-house rep, dealer Constructive Solar. Sees only his own customers. |
| `tim+demo-elena@constructiveoperations.com` | Elena Marsh | Sales Rep | In-house rep, dealer Constructive Solar. |
| `tim+demo-tyler@constructiveoperations.com` | Tyler Brooks | Sales Dealer | Dealer manager, Saguaro Ridge Solar. Sees that dealer's deals. |
| `tim+demo-nadia@constructiveoperations.com` | Nadia Flores | Sales Rep | Rep at the dealer Copperline Energy. |
| `tim+demo-marcus@constructiveoperations.com` | Marcus Bell | Technician | Dispatch board column 1. The tech who is clocked in on a call. |
| `tim+demo-priya@constructiveoperations.com` | Priya Nair | Technician | Dispatch board column 2. The tech who is on the way. |
| `tim+demo-diego@constructiveoperations.com` | Diego Alvarez | Technician | Dispatch board column 3. |

There is no `tim+demo-admin` login. For "the admin", log in as **Dana** (Admin) or
**Avery** (Executive + super admin).

### Keep `migration/demo/id-map.json`

That file is the record of what the seed created. Every update the script makes is
limited to ids in it, and it is what makes a second run continue instead of duplicate.
The folder is git-ignored, so **it lives only on the PC you ran the seed from** — copy it
somewhere safe after the first `--apply`, and again after each `--freshen`. If it is lost
anyway, read [If the id-map is lost](#if-the-id-map-is-lost) before running anything.

---

## Before the first run: two things the demo tenant needs in Secrets Manager

The seed does not create these, and the demo works without them — but two things a
prospect will ask to see do **not** work until you add them. Both are per-tenant blocks;
the shared (Harmon) values are never used for another tenant.

1. **Texting.** A tenant that does not own a Twilio number gets **"Texting isn't set up"**
   instead of a sent text — the shared line belongs to Harmon and is not lent to the
   demo. Demo texts, and therefore `--demo-phone`, only work after you add a number
   for the demo in Secrets Manager **`sundial/twilio`**:

   ```json
   "tenantNumbers": { "conops-demo": "+1XXXXXXXXXX" }
   ```

   (a Twilio number on the Constructive Ops account that is not Harmon's; runbook
   `docs/integrations/sms-twilio.md`). Without it, the seeded text threads still show —
   they are rows only — but nothing can be sent or received.

2. **Customer emails and links** (estimates, invoices, job reports, the "pay / approve
   online" link). These need the demo's own company name and address. Add a
   **`conops-demo`** block to Secrets Manager **`sundial/brand`** with at least:

   ```json
   "conops-demo": { "companyName": "Constructive Operations", "portalUrl": "https://sundial.constructiveoperations.com" }
   ```

   Without `portalUrl` the portal refuses to send a link (`PORTAL_URL_NOT_CONFIGURED`) or
   sends the message without one; without `companyName` it has no company name to put in
   the message. Harmon's name and address are never substituted.

Neither is needed for the seed itself to run.

---

## Running it

Open PowerShell in the `sundial-core` folder. The script uses the same AWS sign-in as the
other scripts in `scripts/` (it reads the Salesforce and Supabase credentials from Secrets
Manager).

### 1. Dry run (writes nothing to Salesforce or Supabase)

```powershell
node scripts/seed-demo-tenant.mjs
```

This describes the live org, builds the whole plan, checks every field, picklist value
and lookup, and prints the counts by object and by stage. The last line is either
`Preflight passed` or a complete list of problems. It writes one local file,
`migration/demo/plan.json`, which you can open to read exactly what would be written.

**Read three things in the output before going further:**

1. `PREFLIGHT FAILED` — stop. Nothing can be written until each listed problem is fixed.
2. `Optional fields left out` — fields the org does not have; the seed goes on without
   them. Expected today, exactly these five (all belong to the roofing-revamp package,
   which is written but not deployed):

   ```text
   - dropped on 10 record(s) — Sundial_Roofing__c.Deposit_Received__c: the org has no such field
   - dropped on 10 record(s) — Sundial_Roofing__c.Deposit_Amount__c: the org has no such field
   - dropped on 10 record(s) — Sundial_Roofing__c.Deposit_Received_Date__c: the org has no such field
   - dropped on 10 record(s) — Sundial_Roofing__c.Notes__c: the org has no such field
   - dropped on 10 record(s) — Sundial_Customer__c.Linked_Roofing_Project__c: the org has no such field
   ```

   Anything else in that list is new — read it before going on.
3. `Fields the ORG will fill with its own default` — fields the seed does not write but
   Salesforce will fill. Check that none of them is a client's number.

### 2. Apply

**Decide the options now, and pass them on the first `--apply`** — whichever form of it you
use (all at once, or one phase at a time). They are stored with the first apply and the
seed never rewrites a record to change them later:

- `--demo-phone +1XXXXXXXXXX` and `--demo-email you@constructiveoperations.com` put **your**
  phone and email on the three "live demo" customers (the dry run names them), so a demo
  text or an estimate email reaches you. The phone is only useful once the demo tenant has
  its own Twilio number (see the prerequisites above).
- `--with-sold-pending-review` — see [Two other flags](#two-other-flags-for-deliberate-use);
  leave it out unless you have done the check described there.

```powershell
node scripts/seed-demo-tenant.mjs --apply --demo-phone +1XXXXXXXXXX --demo-email you@constructiveoperations.com
```

Or with fake details everywhere:

```powershell
node scripts/seed-demo-tenant.mjs --apply
```

It runs the phases in order — `tenant`, `dealers`, `users`, `customers`, `solar`,
`roofing`, `pricebook`, `service`, `supabase` — about **1,050 Salesforce API calls** (613
creates, 120 updates, about 300 reads of which 180 are canary read-backs, 14 describes;
the exact number moves by a few with the day of the week), several minutes. It finishes
with a count of what was written and a **NEXT STEPS** block.

**If it stops part-way**, read the `STOPPED:` line, fix the cause, and run the *same
command* again. It continues where it stopped; nothing is written twice.

**If you forgot the phone / email on the first apply:** they are still accepted on a later
run **as long as the three live-demo customers have not been created yet** (that is, until
the `customers` phase has run). After that, a different value is refused, and the message
names the three customer records — change the phone or email on those three by hand in
the portal instead.

### 3. One phase at a time (optional)

To go slowly the first time, run the phases one by one, in the order above. The options go
on the **first** command:

```powershell
node scripts/seed-demo-tenant.mjs --apply --phase tenant --demo-phone +1XXXXXXXXXX --demo-email you@constructiveoperations.com
```

```powershell
node scripts/seed-demo-tenant.mjs --apply --phase dealers
```

```powershell
node scripts/seed-demo-tenant.mjs --apply --phase users
```

…and so on through `customers`, `solar`, `roofing`, `pricebook`, `service`, `supabase`.
The later commands do not need the options again. A phase run before one it depends on
stops with a message naming the phase to run first. Going phase by phase costs more
read-only API calls — every run describes the org, re-checks the tenant and verifies what
already exists — about 1,350 in total instead of 1,050.

### 4. Sample files (optional)

```powershell
node scripts/seed-demo-tenant.mjs --apply --phase files --with-files
```

`--phase files` on its own is refused: the PDFs go to S3, which the script cannot clean up,
so they are uploaded only when `--with-files` is on the command line.

### 5. Pull the records into the portal's lists

The list pages read the Supabase cache, not Salesforce. One incremental sync covers every
cached object and only reads records changed since the last sync. Run it soon after the
seed — an object that has never been synced only looks back 24 hours:

```powershell
aws lambda invoke --function-name sundial-cache-sync --region us-west-1 --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload "{}" out-cache-sync.json
```

`--cli-read-timeout 0` is there on purpose. The AWS CLI waits 60 seconds for an answer and
then **sends the request again**; a sync that takes longer than that would be started a
second time while the first is still running. With `0` the CLI simply waits.

### 6. The passwords

```powershell
node scripts/seed-demo-tenant.mjs --show-passwords
```

This is the only command that prints them. They live in Secrets Manager
`sundial/demo-users`, never in a file.

If that secret is ever lost — or loses one entry — run the `users` phase again:

```powershell
node scripts/seed-demo-tenant.mjs --apply --phase users
```

New passwords are generated for whatever is missing, stored, **and set on the logins that
already exist**, so the secret always opens every login. Logins whose password is still in
the secret are not touched.

### 7. Freshen (before a demo on a later day)

The dispatch board, "today" and the payroll week are anchored to the day of the first
`--apply`. A week later the board looks stale. Preview what freshen would change:

```powershell
node scripts/seed-demo-tenant.mjs --freshen
```

Then do it:

```powershell
node scripts/seed-demo-tenant.mjs --freshen --apply
```

Freshen moves the still-open calls into today and the next seven days, redraws today's
picture (one tech on a job, one on the way, one scheduled), adds finished calls with clock
data for the **current payroll week only**, and adds the matching tech days. Its limits:

- It adds records each time (calls and tech days); it cannot remove old ones.
- The new finished calls are added to jobs already In Progress, so those jobs collect
  calls over repeated freshens.
- Solar and roofing dates, comments, texts and notifications are **not** moved.
- Earlier weeks' payroll stays as it was; weeks skipped between freshens are empty.
- It refuses to start — before reading or changing anything — if the tenant in Salesforce
  is not the one the id-map belongs to, or if the id-map is missing (rebuild it first:
  [If the id-map is lost](#if-the-id-map-is-lost)).

Run the cache sync (step 5) afterwards, and copy `id-map.json` to your safe place again.

---

## The canary, and when it stops

A **canary** is a record that is read back in full straight after it is written. If a
field the script did not write has a value — and it is not a formula, an auto-number or a
default the org declares — or a field it did write reads back differently, the script
stops there. That usually means a Flow or a field default the describe does not show.

Which records are canaries:

- the **first record of every object**;
- on **customers** and **solar projects** — the two objects with stage-driven automation —
  also the **first record in every stage**: each solar `Stage__c`, each customer status /
  stage pair (and each status for customers with no stage), and each `Service_Stage__c`.
  A Flow that only fires on "Install Scheduled" is invisible to a canary written in
  "Permit Submitted"; this way it is caught on the first project that reaches that stage,
  with exactly one record written in it. About 80 read-backs in all.

Look at the record in Salesforce. If the extra value is harmless, accept it and carry on:

```powershell
node scripts/seed-demo-tenant.mjs --apply --accept-canary Sundial_Solar__c
```

`--accept-canary` accepts **exactly the field(s) the failed canary named**, on that object:
the record is read back again, and the same field is tolerated on every later canary of
the object (so one harmless default does not stop the run 34 times). A *different* field
still stops the run. The object name must be one the script seeds — a typo is an error
that lists the valid names, not a silent no-op.

If the difference is not harmless (for example a client's number filled in by a default),
stop and fix the seed or the org first. The canary can see field changes only — **it
cannot see an email alert or an outbound message** fired by a Flow.

### The "modified by something else" note

Automation that acts *later* (a scheduled path, another integration) is invisible to a
canary. So the final check of every `--apply` and every `--freshen --apply` also asks
Salesforce for the `LastModifiedDate` of every record in the id-map, and lists the ones
modified **more than 5 seconds after this script's own last write** to them. It is a note,
never a stop, and each change is reported once. If you or a prospect edited those records
in the portal, that is the explanation. If nobody did, something in the org is reacting
to demo records — find out what before the next demo.

### Two other flags, for deliberate use

- `--allow-unaccounted` — the tenant holds records the seed did not create (for example
  ones you made while demoing). Without the flag the seed refuses; with it they are left
  untouched. It never overrides the refusals described under
  [If the id-map is lost](#if-the-id-map-is-lost).
- `--with-sold-pending-review` — **"Sold - Pending Review"** is the stage a fresh sale
  lands in, on the customer *and* on the solar project. Harmon's Salesforce alerts fire on
  the customer stage, and any record-triggered Flow for a new sale acts on one or the
  other. This script cannot see Flows, so it cannot tell whether yours are limited to
  Harmon's tenant. By default it therefore keeps
  **both** demo records out of that stage: the newly sold demo customer sits in
  "Processing Documents", the demo project that would have been there sits in the next
  stage, "Audit", and the dry run prints that **33 of the 34 solar stages are covered**
  and why. The flag puts that one customer and that one project in the real stage (34 of
  34).

  **Before you use it, confirm in Salesforce Setup** that every record-triggered Flow,
  workflow rule and email alert on **`Sundial_Customer__c`** and on **`Sundial_Solar__c`**
  that reacts to "Sold - Pending Review" is limited to the Harmon tenant (an entry
  condition on `Client__c`, or on a Harmon-only field). If one is not, a demo record in
  that stage sends Harmon's staff an alert about a customer who does not exist — and the
  canary cannot see an email. If you are not sure, leave the flag off: the pipeline board
  is simply missing a card in its first column.

  Like the other options, pass it on the first `--apply`.

---

## If the id-map is lost

`migration/demo/id-map.json` lives on one PC. If that PC is replaced, or the folder is
cleaned, the script no longer knows which records are its own — nor the **anchor date**
and **random seed** the plan was built from. A plan built from today's date has different
calls, payments and tech days, and seeding it would pile duplicates onto records the
integration user cannot delete.

**The best fix is the boring one: put your copy of `id-map.json` back** in
`migration/demo/` and run as usual.

If you have no copy, the script can rebuild it — this is what it does, and where it stops.

**What makes a rebuild possible.** On the first `--apply`, *before the first record is
written*, the anchor, the seed, the options and (once it exists) the tenant's id are also
saved in Secrets Manager, inside `sundial/demo-users`, under the key `_run`. Every
`--freshen --apply` adds its date. `_run` is not a login; `--show-passwords` never prints it.

**To rebuild:**

```powershell
node scripts/seed-demo-tenant.mjs
```

The dry run says `id-map: NOT FOUND … but tenant "conops-demo" exists`, restores the
anchor and seed from the secret, rebuilds the *original* plan and matches every record
under the tenant back to it. Read what it reports, then save the rebuilt id-map:

```powershell
node scripts/seed-demo-tenant.mjs --apply
```

When the seed had finished, this creates and changes nothing in Salesforce and adds
nothing in Supabase — it saves the file. When the seed had stopped half-way, it continues
from where it stopped.

**How each kind of record is recognised:**

| Records | Recognised by |
|---|---|
| Dealers, users, price-book items | name / login email / item code |
| Customers | name + street |
| Solar, roofing | their customer |
| Estimates, lines, jobs, invoices | their customer + scope; their estimate + line order; their estimate; their job |
| Payments | their job + type + amount + time received |
| Tech days | tech + date |
| Service calls | exactly as planned — or, because `--freshen` and the dispatch board change a call's time, tech and status, by **the order they were created in under their job** (the seed writes a job's calls first, in plan order, before anyone can add one) |
| Calls and tech days added by `--freshen` | their own key, which freshen writes into their clock / day log |

It also re-reads which follow-up updates were already made (so nothing is sent twice) and
which login each demo user is bound to.

**Where it refuses — on purpose, and `--allow-unaccounted` does not change it:**

- **A record's identifying field was edited** (a customer renamed, an estimate's scope
  rewritten, a payment's amount corrected, a job's calls that no longer line up). The
  planned record is "not found" while an unrecognised record sits right beside it; creating
  the planned one would make a duplicate. The message names the planned record, the
  value it expected and the unrecognised record's id. Put the field back the way the
  message shows, run again, and change it back afterwards if you want — or restore your
  copy of `id-map.json`. Nothing is saved by a refused rebuild.
- **The secret is gone too** (no `_run`), or its `_run` is for a different tenant record.
  The original anchor date cannot be known, so the plan cannot be rebuilt. The script
  stops with "has been seeded before … but there is no id-map … AND no run record". The
  only ways forward are your copy of `id-map.json`, or removing the demo tenant (below)
  and seeding it afresh.

**What a rebuild cannot bring back:** the canary history (so the next *new* record of each
object and stage is read back again — records that already exist are not), the
"last written by this script" times (the first final check after a rebuild takes what
Salesforce shows as the baseline), and the list of uploaded sample PDFs (a later
`--with-files` run uploads them again over themselves). Records you made by hand while
demoing are left alone as before; if there are any, the rebuild asks for
`--allow-unaccounted` like any other run.

After a rebuild, `--freshen` works again and continues from the date of the last freshen.

---

## What to check afterwards

1. **The count.** The final block lists every object with "verified" — each record was
   re-read and carries the demo tenant.
2. **Log in as Dana, the demo Admin** (`tim+demo-dana@constructiveoperations.com`; or as
   Avery, the Executive and super admin): Customers, Solar, Roofing, Service jobs and
   estimates all have rows, and none of them is a Harmon record.
3. **Log in as a Harmon test user** (a ZZ TEST account, never a live user): no demo
   record is visible.
4. **Solar pipeline board:** every stage has at least one card — except the first column,
   "Sold - Pending Review", which is empty unless you seeded with
   `--with-sold-pending-review`.
5. **Dispatch board:** three techs, today has one call In Progress and one En Route.
6. **A solar project's Budget tab:** press Recalculate. The numbers must come from the
   made-up rates below, not from Harmon's.
7. **Payroll** (as Dana or Avery): this week and last week show hours for three techs.
8. **The notification bell** for Dana and Avery: five rows each — a completed call, a tech
   clocked in, an estimate approved online, a deposit received, a text from a customer.
   Each opens the job (or the estimate) it is about. See also the note about "late"
   reminders below.
9. **The last lines of the seed's own output:** `all records verified`, and either "no
   record was modified after this script's own last write" or a list to read.

---

## Removing the demo tenant

The script does not delete anything, and **the integration user cannot delete** dealers,
estimates, jobs, calls, price book items, invoices, payments or tech days. Removal is an
admin job in Salesforce.

1. **Salesforce** (Data Loader or the Developer Console, as an admin): delete by
   `Client__c = '<demo tenant id>'`, children first —
   `Sundial_Service_Payment__c`, `Sundial_Service_Invoice__c`, `Sundial_Service_Line__c`,
   `Sundial_Service_Call__c`, `Sundial_Tech_Day__c`, `Sundial_Service_Job__c`,
   `Sundial_Estimate__c`, `Sundial_Price_Book_Item__c`, `Sundial_Roofing__c`,
   `Sundial_Solar__c`, `Sundial_Customer__c`, `Sundial_User__c`, `Sundial_Dealer__c`,
   then the `Sundial_Tenant__c` row itself. **Check the filter twice**: the same objects
   hold Harmon's records.
2. **Supabase** (SQL editor) — the script prints these with the real tenant id at the end
   of an apply; it never runs them. One statement per table the seed wrote
   (`profiles`, `comments`, `sundial_service_activity`, `sundial_sms_messages`,
   `sundial_notifications`, `sundial_file_metadata`), each of the form
   `delete from <table> where <tenant column> = '<demo tenant id>';`
3. **Supabase logins:** Authentication → Users → delete the eleven
   `tim+demo-…@constructiveoperations.com` users.
4. **Cache:** clear the deleted rows from the list cache:

   ```powershell
   Set-Content -Encoding ascii payload-reconcile.json '{"mode":"reconcile"}'
   ```

   ```powershell
   aws lambda invoke --function-name sundial-cache-sync --region us-west-1 --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload file://payload-reconcile.json out-cache-reconcile.json
   ```

5. **Secrets Manager:** delete `sundial/demo-users`. Do not skip this: it also holds the
   seed's run record, and a record left behind from a removed tenant makes the next seed
   stop and ask about it. (If you added them, also remove the `conops-demo` entries from
   `sundial/twilio` and `sundial/brand`.)
6. **S3** (only if `--with-files` was used): the keys are listed in `id-map.json` under
   `files`.
7. Delete `migration/demo/id-map.json` on your PC.

---

## The made-up budget rates

Several budget inputs have field defaults in the org that are Harmon's real numbers. A
demo project that left them blank would show Harmon's pricing. So the seed writes every
input the budget calculator reads, with round invented values. They are in
`scripts/demo-seed/budget-rates.js` — change them there **before** the first `--apply`.

| Input | Value |
|---|---|
| Blended labor rate | $30 / hour |
| Battery labor rate | $40 / hour |
| Labor burden rate | 50 % |
| Commission burden rate | 10 % |
| Audit hours / QA-commissioning hours | 2 h / 2 h |
| Install hours per module | 1 h |
| Battery install hours | 8 h (0 without a battery) |
| Module cost | $0.30 / W |
| Microinverter unit cost | $150 each |
| Combiner | $500 × 1 |
| Battery unit cost / price | $8,000 / $12,000 |
| Expansion pack unit cost / price | $1,000 (qty 0) / $6,000 |
| BOS solar / BOS electrical | $0.10 / W each |
| Penetrations per module | 2 |
| Roof material per penetration / roofing labor per penetration | $5 / $10 |
| Material — other | $250 |
| Constructive Ops fee | $500 |
| Permit pass-through | $300 |
| Dealer fee | $0 |
| Sales manager commission / overhead commission | $0.05 / W / $0.02 / W |
| Geo (setter) commission | $100 flat |
| Non-standard adder markup | 25 % |
| Roofing labor per square — shingle / tile / modified / recoat | $150 / $200 / $100 / $125 |
| Roofing material unit costs | $10, $20, $25, $40, $50, $75, $100 repeating; misc $100 |

Adder prices (cost in brackets where the calculator has one): sub panel $500 ($250),
derate $500 ($250), heat detector $250 ($100), 225A upgrade $2,000 ($1,000), 400A upgrade
$4,000 ($2,000), 225A underground $3,000 ($1,250), gateway $3,500 ($2,000), site audit
$300, travel $1,000, structural $500 ($250), small system 10–12 $1,000, small system
13–15 $750, software fee $50, active monitoring $150, battery warranty $750, referral fee
$250; per watt — conduit in attic $0.10 ($0.05), flat roof $0.10 ($0.05), roof tile $0.05
($0.01), bird blocking $0.10 ($0.05).

**One thing the seed cannot change:** `Commission_Redline_PPW__c` is a Salesforce formula
with Harmon's redlines written into it. A demo deal's commission is computed from the
$1.85/W "third-party" redline whoever sold it, including the in-house "Constructive
Solar" deals. Budget output fields are left blank on purpose — press Recalculate.

---

## Known limits

- **Created dates are the seed day.** Salesforce does not let the integration user
  backdate `CreatedDate`, so "created" columns show the day of the seed; the business
  dates (sold, scheduled, installed, invoiced) are spread over the past months.
- **Texting does not work for the demo tenant until it has its own number**
  (`tenantNumbers["conops-demo"]` in `sundial/twilio` — see the prerequisites near the
  top). The shared line is Harmon's and is never used for another tenant. The seeded text
  history is rows only; nothing was sent.
- **Customer emails and links need a `conops-demo` block in `sundial/brand`** (`companyName`,
  `portalUrl`) — same section.
- **Reminders:** the notification sweep may raise "late" bells for the tech whose call is
  Scheduled for earlier today.
- **Estimates have no public link and no PDF.** Send one from the portal to create them.
- **Roofing stages** are whatever the org has live (today a single value, "Stage 1").

## Tests

```powershell
node --experimental-test-module-mocks --test scripts/demo-seed/plan.test.js scripts/demo-seed/run.test.js scripts/demo-seed/freshen.test.js
```

Name the three files, as above: on Node 22 `node --test scripts/demo-seed/` does not run
the tests in a folder. They are also part of `npm test`. They run against a fake org built from
`migration/demo/probe.json`; they prove the plan is consistent and the safety rules hold,
not that the live org behaves the way the probe says.
