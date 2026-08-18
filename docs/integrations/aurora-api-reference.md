# Aurora Sync API — Distilled Reference (Sundial retrieval build)

Condensed from Aurora's official OpenAPI docs (2024.05.0) supplied by Tim on
2026-07-23. Docs show the sandbox server; production base_url + tenant_id + api_key
come from Secrets Manager `sundial/aurora/api` (same secret the push Lambda uses).
Auth on every call: `Authorization: Bearer <api_key>`.
Error shape on 4xx/422: `{ "errors": [ { "message": "..." } ] }`.
**403 means the endpoint is not provisioned for our API key** ("contact your Aurora
account team") — surface this loudly if hit; it's a provisioning problem, not a bug.

> **Reconstruction note (2026-08-07):** this file was lost in a working-tree deletion
> before it had ever been committed, and was rebuilt from the session transcript.
> The endpoint surfaces below are as originally distilled, plus the Retrieve Project /
> List Partners / Retrieve User sections verified against Aurora's public reference
> on 2026-08-07. Re-verify against the OpenAPI file if anything looks off.

---

# Outbound (what Sundial SENDS to Aurora)

## POST /tenants/{tenant_id}/projects   (Create Project)
The only project-creating call we make. Body is `{ "project": { … } }`. **Accepted fields:**
- `external_provider_id` (required for us) — we send the `Sundial_Customer__c` Id; this is
  the cross-reference Aurora echoes back on designs/webhooks.
- `name` (required) — "First Last", falling back to the customer `Name`.
- `status` — we send `active`.
- `location` (required: property_address **or** lat/lng) — `{ "property_address": "..." }`,
  a single geocodable line assembled as `Street, City, State Postal, US`. Aurora has **no**
  flat street/city/state/postal fields and no country field.
- `customer_salutation`, `customer_first_name`, `customer_last_name`, `customer_email`,
  `customer_phone` — all **optional strings, and null is REJECTED** ("must be a string").
  An absent value must be an **absent key**. (We never collect a salutation, so it is
  never sent.)

Response carries the new project at `project.id` (or `id`).

## PUT /tenants/{tenant_id}/projects/{project_id}/consumption_profile
Body `{ "consumption_profile": { "monthly_energy": [...] } }` — **exactly 12** values in
calendar order Jan..Dec. An empty month is the literal 4-character **string** `"null"`,
not JSON null. At least one real number is required, so we skip the call entirely when
all 12 are empty.

## No design-request / design-ordering endpoint
**There is no Aurora API that accepts a design request.** Nothing in the documented
surface (and nothing provisioned for our API key) takes panel SKU, inverter SKU,
turnaround, battery selection, financing terms, offset, or design notes — those exist only
inside Aurora's UI. That is why the Sundial Design Request submit
(`POST /customers/{recordId}/design-request/submit`) splits its payload:

| Sundial_Customer__c field | Destination |
|---|---|
| `Name`, `First_Name__c`, `Last_Name__c`, `Primary_Email__c`, `Primary_Phone__c` | Aurora `customer_*` on project create |
| `Street__c`, `City__c`, `State__c`, `Postal_Code__c` | Aurora `location.property_address` |
| `Jan_Usage_kW__c` … `Dec_Usage_kW__c` | Aurora `consumption_profile.monthly_energy` |
| `Project_Type__c`, `Existing_Solar_System__c`, `Existing_Panel_Count__c`, `Design_Turnaround__c`, `Proposed_Panel_Type__c`, `Inverter_Type__c`, `Battery_Type__c`, `Battery_Quantity__c`, `For_Profit_PPW__c`, `Annual_Usage_kWh__c`, `Utility_Company__c`, `Appointment_DateTime__c`, `Proposed_Panel_Count__c`, `Offset_Requested__c`, `Financing_Type__c`, `Financing_Partner__c`, `Term__c`, `APR__c`, `Design_Notes__c` | **Notification email only** — no Aurora API accepts them (D-047) |

If Aurora ever provisions a design-ordering API for our key, fields move from the email
block to the payload in `lambdas/sundial-aurora-push/designRequest.js`; the route contract
does not change.

---

# Inbound (what Sundial READS from Aurora)

## GET /tenants/{tenant_id}/projects/{id}   (Retrieve Project)
Verified against Aurora's public reference **2026-08-07**. This is the source for
auto-creating a customer from a dealer-originated deal (D-049).

Response `project`:
- **Customer:** `customer_salutation`, `customer_first_name`, `customer_last_name`,
  `customer_email`, `customer_phone`, `mailing_address` (all string ≤255)
- **Identity:** `id` (uuid), `name`, `external_provider_id` (our SF id when the
  project came from Sundial — **empty for dealer-originated deals, which is exactly
  how we tell them apart**), `status`, `tags[]`, `project_type` (`residential` |
  `commercial`)
- **Attribution:** `owner_id` (uuid — "the user who owns the project"), `team_id`
  (uuid), `partner_id` (uuid — "the partner associated with the project")
- **Location:** `location.property_address`, `location.latitude`,
  `location.longitude`, and
  `location.property_address_components.{ street_address, city, region,
  postal_code, country }`
  ⚠️ **The components are nested under `location`**, not at the top level. `country`
  comes back as a full name ("United States"), and `region` as the state code.
- **Other:** `created_at` ("YYYY-MM-DD HH:MM:SS UTC"), `created_from_lead_id`
  (nullable), `order_id` (nullable), `ahj_id` (nullable),
  `preferred_solar_modules[]` (uuids)

There is **no dealer name on the project** — only ids. Two endpoints resolve them:

## GET /tenants/{tenant_id}/partners   (List Partners)
Returns `partners[] { id, name }`. Aurora "partners" are **external business user
groups**: users assigned to a partner can only see that partner's projects. That is
precisely Harmon's third-party-dealer concept, so a project's `partner_id` resolved
through this list **is** the dealer name. There is **no single-partner GET** in the
spec, so we list and match by id (small list; cached 30 min).

## GET /tenants/{tenant_id}/users/{id}   (Retrieve User)
Returns `{ id, tenant_id, first_name, last_name, email, account_status, phone,
title, job_function, external_provider_id, role_id, team_ids[], partner_ids[],
partner_id (deprecated), locale, base_price_per_watt_min/max }`. Used as the
fallback when a project has an `owner_id` but no `partner_id` — it names a person
rather than the firm.

**403 handling differs by endpoint.** Retrieve Project not being provisioned kills
the dealer-origination feature outright → loud `AURORA_NOT_PROVISIONED` dead-letter.
List Partners / Retrieve User are attribution only → degrade to the raw ids in the
import notes and carry on; never fail an import over them.

## GET /tenants/{tenant_id}/agreements/{id}   (Retrieve Agreement)
Response `agreement`:
- `id` (uuid), `project_id` (uuid), `design_id` (uuid)
- `agreement_template_name` (string)
- `status`: one of `cancel_pending, canceled, sent, viewed, signed, error, declined`
- `signing_provider`: `docusign` | `dropbox_sign`  (Harmon uses **docusign**)
- `created_at` ("YYYY-MM-DD HH:MM:SS UTC"), `sent_at` (null for Docusign),
  `last_viewed_at` (null for Docusign), `error_message` (nullable)
- NOTE: **no pricing fields and no signed_at timestamp** on this object.

## POST /tenants/{tenant_id}/agreements/{id}/download_url/run
Starts async generation of the signed-agreement PDF download URL.
**Docusign-only; agreement status must be `signed`.** Returns 202:
`agreement_download_url_job { job_id, requested_at, completed_at|null,
status: in-progress|succeeded|failed, file_url|null, project_id, design_id,
error|null }`

## GET /tenants/{tenant_id}/agreements/{id}/download_url/status?job_id={job_id}
Poll the job. Same `agreement_download_url_job` shape. When `succeeded`,
`file_url` holds the PDF download URL — **expires 15 minutes after generation**.
(The `agreement_download_url_job_completed` webhook also exists but polling is
simpler for our worker; job completes in seconds typically.)

## GET /tenants/{tenant_id}/designs/{design_id}/summary   (Retrieve Design Summary)
Response `design`:
- `design_id`, `project_id`, `external_provider_id` (our SF id when set), `created_at`
- `system_size_stc`, `system_size_ptc`, `system_size_ac` — all **Watts** (divide by
  1000 for kW)
- `bill_of_materials[]`: `{ id, component_type, sku, name, manufacturer_name,
  quantity }` where component_type ∈ `modules, microinverters, inverters, batteries,
  dc_optimizers, ...`
- `arrays[]`: per-array `{ size (W), azimuth, pitch, orientation, configuration,
  module { name, count, rating_stc, orientation }, microinverter?, dc_optimizer?,
  face, ground_mounted, shading { solar_access { annual, monthly[] } } }`
- `string_inverters[]` / `storage_inverters[]` / `batteries[]`: `{ id, name,
  rated_power / has_integrated_inverter }`
- `energy_production`: `{ up_to_date, annual (kWh), annual_offset ("87%"),
  monthly[12], hourly[8760]|null, loss_summary[], ... }` — only present if a
  performance simulation has run.

## GET /tenants/{tenant_id}/designs/{design_id}/proposals/default   (Retrieve Proposal)
Response `proposal`: `{ id, created_at, updated_at, proposal_template_id,
proposal_link }` — proposal_link is a URL into the Aurora web app. **No PDF from
this endpoint.**

## GET /tenants/{tenant_id}/designs/{design_id}/financings/{financing_id}   (Retrieve Financing)
NOTE THE PATH: it is design-scoped — you need BOTH design_id and financing_id
(the webhook supplies both). `<FINANCING_ID>` is empty when no financing option was
selected on the design — skip this call entirely in that case.
Response `financing` (key fields for Sundial):
- `id`, `name`, `project_id`, `design_id`, `selected_in_sales_mode` (bool)
- `financing_option`: `cash | loans | lease | ppa | levelized_ppa`
- `system_price` (number, 2dp): "Total price the customer pays; includes the
  principal, downpayment and incentive grants." ← THE contract dollar amount.
- `up_to_date` (bool): whether the financial simulation results are current.
- Loans-only: `loan_principal`, `down_payment` (= system_price − loan_principal),
  `monthly_payment_first_month`, `avg_monthly_savings`, `loans[]` (name,
  duration_months, dealer_fee_percentage, periods[]).
- Lease/PPA-only: `epc_price_per_watt`, `escalation`, `monthly_payment`,
  `solar_rate`, `upfront_payment`.
- `financier` (nullable): `{ type: integrated|custom, provider (e.g. "mosaic",
  "sungage", or custom name), status (created|quoted|submitted|pre_approved|
  rejected|canceled|failed_to_be_quoted, integrated only),
  approved_loan_amount, external { provider_status, request_id,
  contract_signed_at (GoodLeap/LightReach only), ... } }`
- Also available: `lifetime_savings`, `payback_period` (cash only),
  `incentive_values[]` ({name, sum}), `year1_avoided_cost[12]`,
  `annual_cashflows[]`.

### Design results → Salesforce mapping (approved 2026-08-03)
All onto **`Sundial_Customer__c`** (no Solar record exists yet — D-047/D-048):
- `Final_System_Size_kW__c` ← `system_size_stc / 1000`, 2dp (Aurora reports **Watts**)
- `Final_Panel_Count__c` ← sum of `bill_of_materials[].quantity` where
  `component_type = modules`
- `First_Year_kW_Production__c` ← `energy_production.annual`. **The field's label says
  kW but the value written is kWh** — Aurora's `annual` is kWh, and that is the number
  we want; the label is what's wrong. Absent until a performance simulation has run.
- `Contract_Signed_Date__c`, `Sold_Date__c` ← **webhook receipt time**, as the local
  (America/Phoenix) calendar date. The agreement object has **no `signed_at`** and the
  webhook carries no timestamp, so receipt time is the only signing timestamp we have.
- `Loan_Term_Years__c` ← `loans[0].duration_months / 12` (loans only)
- `Monthly_Payment__c` ← `monthly_payment_first_month` (loans) or `monthly_payment`
  (lease/ppa)
- `Aurora_Proposal_Link__c` ← `proposal.proposal_link`

### Confirmed financing → Salesforce mapping (Tim, 2026-07-23)
- `Proposal_Amount__c` ← `system_price`
- `Contract_Price_Per_Watt__c` ← `system_price / system_size_stc` (Watts, from the
  design summary), 2dp, only when both present
- `Financing_Type__c` ← `financing_option` (describe-check the picklist first; map
  to the org's closest values, e.g. loans → "Loan", cash → "Cash"; report any value
  with no reasonable match instead of guessing)
- `Financing_Partner__c` ← `financier.provider` (only when financier is non-null)
- `Down_Payment_Amount__c` ← `down_payment` (loans only; skip otherwise)

### Lease/PPA financing → Salesforce mapping (2026-08-17)
These keys are **lease/PPA-only** in Aurora's response, so they are written on the
non-loan branch and are simply absent for cash and loans:
- `Energy_Rate__c` ← `solar_rate` — the customer's **$/kWh energy rate**.
  **Not `Solar_Price_per_Watt__c`**, which is a different metric (contract amount ÷
  system watts; this pipeline writes that as `Contract_Price_Per_Watt__c`). Mixing
  them would put a ~$3 figure in a ~$0.14 field.
- `Escalator__c` ← `escalation` — annual escalation on that rate.
  ⚠️ **Unit unverified.** `Escalator__c` is a Salesforce PERCENT field, which stores
  the percentage itself (`2.9` = 2.9%). Aurora's docs don't say whether `escalation`
  is a percentage (`2.9`) or a fraction (`0.029`), and Aurora is inconsistent about
  this elsewhere (`energy_production.annual_offset` is the **string** `"87%"`). We
  pass the number through **unconverted** rather than guess at a ×100, and the worker
  warns when the value is `0 < x < 1` — the tell for a fraction, since real
  escalations are 1–5%. Settle it against a real payload, then apply a ×100 or drop
  the warning (TASKS.md).
- `Monthly_Payment__c` ← `monthly_payment` — see the note below; this was **already**
  implemented, contrary to the superseded line this section replaced.

**`upfront_payment` is deliberately NOT mapped.** Aurora lists it as a lease/PPA field
with no definition, and the plausible readings — a capital-cost reduction/prepayment
that lowers the monthly, vs. a due-at-signing fee — belong in different Salesforce
fields and mean different things to finance. `Down_Payment_Amount__c` is the tempting
target and is the wrong one if it is a prepayment. Left unmapped until a real
Participate payload proves its meaning (TASKS.md).

> **Superseded (was: "Everything else … is NOT mapped in v1").** That line dated from
> 2026-07-23 and was already false: the 2026-08-03 design-results round added
> `Monthly_Payment__c` for both loans and lease/PPA, and the code has written it since.
> Savings and incentives remain genuinely unmapped.

## Webhook: agreement_status_changed (our inbound doorbell)
- Aurora sends a **GET** to our url_template with query params; available
  attributes: `<PROJECT_ID>, <DESIGN_ID>, <AGREEMENT_ID>, <FINANCING_ID>, <STATUS>`.
  All five are required in our template — `<DESIGN_ID>` gates the signed retrievals,
  and `<FINANCING_ID>` is **empty when no financing option was selected** (skip the
  financing call entirely; requesting it would 404).
- Statuses: `sent, viewed, signed, cancel-pending, canceled, declined, error`.
  **Our subscription takes ALL statuses, not just `signed`** (corrected 2026-08-04;
  it previously said "filters to `signed`"). Every status updates the agreement
  tracking fields on `Sundial_Customer__c`; only `signed` triggers retrieval. Setup:
  `docs/integrations/aurora-inbound.md`.
- Auth: our shared secret in `X-Aurora-Webhook-Token` header.
- **Respond within 10 seconds** or Aurora counts it failed. 3xx/4xx/5xx → up to 5
  retries over ~24h (30s, 5m, 30m, 3h, 20h). A webhook failing consistently for
  48h (≥100 attempts) gets auto-disabled.
- **Duplicates are possible; ordering is NOT guaranteed** (a `signed` can arrive
  before a `viewed`). Consumers must be idempotent.
- Returning 5xx from our doorbell deliberately triggers Aurora's retry — correct
  behavior when our enqueue fails.
