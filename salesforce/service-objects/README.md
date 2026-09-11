# service-objects — the seven Service Operations objects (Phase 2, D-072)

> Step-by-step, plain-language version of the deploy: **`DEPLOY-WALKTHROUGH.md`** in this folder.

Creates **`Sundial_Estimate__c`** (`EST-{00000}`), **`Sundial_Service_Job__c`**
(`SVC-{00000}`), **`Sundial_Service_Call__c`** (`SC-{00000}`),
**`Sundial_Price_Book_Item__c`** (Name = Text, item name), **`Sundial_Service_Line__c`**
(`SL-{00000}`), **`Sundial_Service_Invoice__c`** (Name = Text; the invoice Lambda assigns
the job number, then `-2` on reissue), **`Sundial_Service_Payment__c`** (`PAY-{00000}`);
adds **one field** to the existing `Sundial_Customer__c` (`Stripe_Customer_Id__c`, deployed
as a `CustomField` member — never a whole-object deploy of the customer); and the
`Sundial_Service_Objects` permission set (integration-user FLS on all 190 grantable fields
+ object perms). 201 fields across the seven objects.

**Everything here is generated from one spec** — `scripts/gen-service-objects.py`, run from
the repo root (needs `openpyxl`); the spec mirrors `docs/service-data-model.md` — together with the seven
`sql/*_cache.sql` files and the three `docs/*_Fields_by_Section.xlsx` workbooks. Change the
model there and regenerate — do not hand-edit the `.object` files.

Design: `docs/service-data-model.md` (authoritative), `docs/service-workflows.md`
(workflows), DECISIONS.md **D-072** (+ D-065 for everything it did not supersede).

## Deliberate choices worth knowing before you deploy

- **Lines hang off the estimate, not the job.** `Sundial_Service_Line__c.Estimate__c` is
  required; there is no line→job lookup on purpose (one living set of lines, D-072.3).
  The job reads money through the four `Estimate_*` cross-object formulas.
- **`Sundial_Service_Job__c.Estimate__c` is required.** Every job has exactly one estimate;
  the Lambda creates it in the same transaction on quick-create. Migration creates the
  estimate first, then the job.
- **`Sundial_Estimate__c.Sundial_Customer__c` is NOT required in metadata** — templates
  (`Is_Template__c`) have no customer. The Lambda requires it for everything else.
- **Price-book items have no delete and are versioned** — `Item_Code__c` is an External ID
  but *not* unique (versions share it); "one active per code" is enforced in the Lambda,
  never in metadata. `Superseded_By__c` is a self-lookup.
- **`Sundial_Service_Payment__c.Stripe_Payment_Intent_Id__c` IS unique** — the webhook
  idempotency key. A redelivered Stripe event fails the insert instead of double-recording.
- **Bill-To exists on the job (editable) and the invoice (frozen copy) only.** Nothing on
  the customer, nothing on the service call — one job = one payer (D-072.6). The value
  "Internal Warranty" is tenant-neutral by design (never "Harmon Warranty").
- **The service call's four parent lookups are optional in metadata**; the
  exactly-one-matching-`Visit_Type__c` rule is a validation rule / Lambda guard added
  with the workflows build so migration can bulk-load.
- **Job `Status__c` has no estimate states.** `Estimate Sent` / `Estimate Approved` live on
  `Sundial_Estimate__c.Status__c`; the job list shows `Estimate_Status__c` (formula).
- **`sharingModel` is `Private`** on all seven, per `docs/salesforce-schema.md`. With only
  Tim (View All Data) and the integration user (owns what it creates) as SF users this is
  safe; if Check Only argues otherwise, flip the two `sharingModel` lines per object.
- **Delete is granted only on `Sundial_Service_Line__c`.** Jobs close, calls cancel,
  invoices void, estimates decline/expire, payments refund, price-book items deactivate.

## Deploy order

1. **`node scripts/verify-service-schema.mjs`** (repo root; standard Secrets-Manager
   Salesforce auth). Per object: exists / missing, and for existing objects the
   field-by-field diff against this package. `Sundial_Customer__c` is reported as a
   field-only addition (it must exist; its other fields are expected).
   - **If any of the seven objects already exists: STOP and reconcile** (whole-object
     deploy overwrites object-level settings).
   - **If `Sundial_Commercial__c` is absent** (Phase 3): regenerate without the three
     commercial lookups — `python scripts/gen-service-objects.py --no-commercial` — a lookup
     to a missing object fails the whole deploy. Re-run without the flag once Commercial
     exists. The verify script says which case you're in.
2. `node scripts/zip-package.mjs salesforce/service-objects` → `salesforce/service-objects.zip`
   (10 entries; the script now understands whole-object packages and skips README/spec.json).
   Never zip by hand — **never PowerShell 5.1 Compress-Archive**.
3. Workbench → **Migration → Deploy** → Single Package → **Check Only first** (expect
   **9/9 components**: 7 objects + 1 field + 1 permission set) → deploy for real. Leave
   Rollback on Error checked.
4. **Assign `Sundial_Service_Objects` to the integration user** (Setup → Permission Sets →
   Manage Assignments). Without it every Lambda write silently drops fields.
5. Re-run `node scripts/verify-service-schema.mjs` — expect seven green objects, the
   customer field present, zero missing, FLS green.
6. Supabase: apply the seven `sql/sundial_*_cache.sql` files (proven against Postgres 16),
   then deploy `sundial-sf-query`, `sundial-sf-update`, `sundial-cache-sync` (`lib/access.js`
   rides along) — the allowlist keys `estimate / job / servicecall / pricebookitem /
   serviceline / serviceinvoice / servicepayment` are inert until objects + tables exist.
7. XFiles Pro: configure `Sundial_Service_Job__c`, `Sundial_Service_Call__c`, and
   `Sundial_Estimate__c` with path pattern `SUNDIAL/{record_id}/` (manual, in Salesforce).

## Not in this package (deliberately)

Validation rules (call parent/type rule; Closed-requires-Resolution), the time roll-up Flow
(call → job) and the Paid_Amount roll-up (payment → invoice), page layouts, alerts, and any
`Sundial_Tenant__c` config fields. Layouts don't matter (no SF users browse these objects);
rules/Flows come with the workflows build so the migration can bulk-load first.

## Superseded files to delete from the repo (Tim — `git rm`)

`objects/Sundial_Service__c.object`, `objects/Sundial_Service_Visit__c.object`,
`sql/sundial_service_cache.sql`, `sql/sundial_service_visit_cache.sql`,
`docs/Sundial_Service_Fields_by_Section.xlsx`, `docs/Sundial_Service_Visit_Fields_by_Section.xlsx`.
The line and invoice files of the same names are **replaced in place** by this rework.
