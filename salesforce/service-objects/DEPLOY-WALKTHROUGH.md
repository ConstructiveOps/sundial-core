# Deploying the service objects — step by step (Tim's copy)

> Plain-language version of the README's deploy order. Every command below is typed into
> **one terminal window** that is sitting in the `sundial-core` folder. Nothing here creates
> AWS infrastructure or touches live customer data; the Salesforce steps create seven brand-new
> objects and one field. Budget an hour. Stop and paste me the output at any ⛔.

## Step 0 — open the terminal in the right place

1. Open VS Code. **File → Open Folder…** → `C:\Users\TimMurphy\Projects\sundial-core`.
2. **Terminal → New Terminal.** A panel opens at the bottom; its prompt should end in
   `sundial-core>`. That panel is where every command below goes — type it, press Enter,
   read what comes back before moving on.
3. Sanity check — type:
   ```
   git status
   ```
   You'll see a list of changed/new files. That's expected (they're the files I wrote).
   If it says `fatal: not a git repository`, you're in the wrong folder — redo step 1.

## Step 1 — git housekeeping and the feature branch

1. Clear the leftover test worktree:
   ```
   git worktree prune
   ```
   (No output = fine.)
2. Make a branch so nothing lands on `master` until you've reviewed it:
   ```
   git checkout -b feature/service-data-model-v2
   ```
   If it says the branch already exists (you made it earlier), use `git checkout feature/service-data-model-v2` instead.
3. Remove the six superseded files from the repo (this deletes them from disk too):
   ```
   git rm salesforce/service-objects/objects/Sundial_Service__c.object salesforce/service-objects/objects/Sundial_Service_Visit__c.object sql/sundial_service_cache.sql sql/sundial_service_visit_cache.sql docs/Sundial_Service_Fields_by_Section.xlsx docs/Sundial_Service_Visit_Fields_by_Section.xlsx
   ```
   If one of them says "did not match any files", it's already gone — that's fine, but the
   whole command stops at the first miss; re-run it with that filename removed.
4. Stage exactly this session's files (not everything — other sessions may have their own
   uncommitted work in the same folder):
   ```
   git add salesforce/service-objects sql scripts/gen-service-objects.py scripts/verify-service-schema.mjs scripts/zip-package.mjs lambdas/sundial-sf-query/index.js lambdas/sundial-sf-update/index.js lambdas/sundial-cache-sync/index.js lib/access.js lib/access.test.js docs/service-data-model.md docs/service-workflows.md docs/Sundial_Estimate_Fields_by_Section.xlsx docs/Sundial_Service_Job_Fields_by_Section.xlsx docs/Sundial_Service_Call_Fields_by_Section.xlsx CLAUDE.md DECISIONS.md TASKS.md
   ```
5. Run the tests **before** committing:
   ```
   npm test
   ```
   Scroll to the bottom. You want `# fail 0`. ⛔ If anything fails, stop and paste me the
   lines around `not ok`. (The `getSalesforceToken` import failures I saw were a Linux-only
   quirk; they should not appear on your Windows Node.)
6. Commit:
   ```
   git commit -m "Service data model v2 (D-072): seven objects, versioned price book, one job = one payer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01JKYsKWsvaEjKCtvVsKEQnj"
   ```

## Step 2 — ask Salesforce what's there (read-only)

```
node scripts/verify-service-schema.mjs
```
This uses your normal AWS/Secrets-Manager Salesforce login (same as the other scripts).
**Before deploying, this is what "good" looks like:**

- `○ Sundial_Estimate__c: NOT in the org` — and the same for the other six. Expected.
- `● Sundial_Customer__c: EXISTS … field-only addition` followed by
  `✗ 1 package fields MISSING: Stripe_Customer_Id__c`. Expected — we haven't deployed it yet.
- A line about **`Sundial_Commercial__c`**. Two possibilities:
  - `✓ Sundial_Commercial__c resolves` → nothing to do.
  - `✗ Sundial_Commercial__c DOES NOT resolve` → **do Step 2b** before zipping.
- Three lines about **`Requested_Project_Types__c` value "Service" / "Roofing" / "Commercial"**.
  If "Service" says **MISSING**, do Step 2c (any time before go-live; it doesn't block the deploy).
- `RESULT: action needed` at the bottom is **normal pre-deploy** (the missing customer field).

⛔ If the script errors out before printing anything (token/secret problems), paste me the error.

### Step 2b — only if `Sundial_Commercial__c` does not resolve

The package has three lookups to that Phase 3 object; Salesforce refuses the whole deploy if
the target doesn't exist. Regenerate the package without them:
```
python --version
```
- If that prints `Python 3.x`: run `pip install openpyxl` once, then
  ```
  python scripts/gen-service-objects.py --no-commercial
  ```
  It prints `--no-commercial: omitted the three Sundial_Commercial__c lookups` and rewrites
  the package, SQL and workbooks in place (the three lookups come back when you re-run it
  without the flag later, once Commercial exists).
- If Python isn't installed: tell me and I'll send the no-commercial package.

### Step 2c — only if "Service" is MISSING from Requested_Project_Types__c

In Salesforce: **Setup → Object Manager → Sundial Customer → Fields & Relationships →
Requested Project Types → Values → New** → type `Service` → Save. (Add `Roofing` and
`Commercial` the same way whenever you like.) Not part of the deploy on purpose — a
value-set redeploy could wipe the values Harmon already uses.

## Step 3 — build the zip (never by hand)

```
node scripts/zip-package.mjs salesforce/service-objects
```
It writes `salesforce/service-objects.zip` and prints its contents. You want:
`10 entries` (package.xml, 8 object files, 1 permission set) and `manifest ✅`.
⛔ If it says "DISAGREE — refusing to build", paste me the output.
(Don't commit the `.zip`; it's a build product.)

## Step 4 — Workbench, Check Only first

1. Go to **workbench.developerforce.com** → log in to the Constructive Ops org (Production,
   your admin login).
2. **Migration → Deploy.**
3. **Choose File** → pick `C:\Users\TimMurphy\Projects\sundial-core\salesforce\service-objects.zip`.
4. Tick **Rollback On Error**, tick **Single Package**, tick **Check Only**. Leave the rest.
5. **Next → Deploy.** Wait for the status page to finish.
6. Read the result. **What matters is `Status: Succeeded` and `Failures: 0`.** The component
   count may read 9 or a couple of hundred — Workbench sometimes counts each field
   separately; either is fine.
   ⛔ Any failure: click into it, copy the message (it names the object/field), paste it to me.
7. Now the real deploy: **Migration → Deploy** again, same file, same ticks **except untick
   Check Only** → Next → Deploy. Wait for `Succeeded`.

## Step 5 — give the integration user access

Salesforce **Setup → (Quick Find) Permission Sets → Sundial Service Objects → Manage
Assignments → Add Assignment** → tick the Sundial integration user → **Assign**.
Skipping this is the classic silent failure: everything "works" and every field write is
dropped.

## Step 6 — verify the deploy

```
node scripts/verify-service-schema.mjs
```
Now you want: `● …: EXISTS` for all seven with `✓ all package fields present, types match,
integration-user FLS OK`, the customer field present, and `RESULT: green`.
⛔ Anything with ✗: paste it to me. (A "NOT updateable" list = Step 5 didn't take.)

## Step 7 — Supabase cache tables

1. **supabase.com → the Sundial project → SQL Editor → New query.**
2. In VS Code open `sql/sundial_estimate_cache.sql`, select all, copy; paste into the editor;
   **Run**. Expect `Success. No rows returned`.
3. Repeat for the other six: `sundial_service_job_cache.sql`, `sundial_service_call_cache.sql`,
   `sundial_price_book_item_cache.sql`, `sundial_service_line_cache.sql`,
   `sundial_service_invoice_cache.sql`, `sundial_service_payment_cache.sql`. Order doesn't
   matter. Running one twice is harmless (`if not exists`).
4. Check: **Table Editor** should now list seven `sundial_*_cache` tables.

## Step 8 — push the three Lambdas

```
.\deploy.ps1 sundial-sf-query
.\deploy.ps1 sundial-sf-update
.\deploy.ps1 sundial-cache-sync
```
One at a time; each ends with the function update settling. `lib/access.js` is bundled into
each automatically. Nothing user-visible changes yet — the new object keys are inert until
the portal calls them.

## Step 9 — XFiles Pro (in Salesforce, your usual screen)

Add three configurations with path pattern `SUNDIAL/{record_id}/`:
`Sundial_Service_Job__c`, `Sundial_Service_Call__c`, `Sundial_Estimate__c`.

## Step 10 — tell me it's done

Then I start the `sundial-service-estimate` Lambda against a real schema. If you also have
the Lead & Source defaults for a service-originated customer (Stage / Status / Lead Source),
send those with it.
