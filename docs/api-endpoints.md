# Sundial — API Endpoints

> Canonical reference for the deployed Sundial API. Every Lambda function reachable from the portal is documented here with its route, methods, parameters, and current implementation status.

---

## Base URL

The API Gateway is deployed in AWS region `us-west-1`.

- **Production base URL:** `https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod`
- **Frontend environment variable:** `VITE_API_GATEWAY_URL`

All routes below are relative to this base URL.

---

## CORS

Every resource has an OPTIONS method automatically added for CORS preflight. Allowed origins are configured at the bucket and gateway level to include:

- `https://*.vercel.app` (covers preview deploys and the production Vercel URL)
- `http://localhost:5173` (local dev)

When a custom production domain is added for Harmon, update the API Gateway CORS configuration to include it.

---

## Authentication

All requests except `/webhooks/acumatica` require a Supabase JWT in the `Authorization` header:

```
Authorization: Bearer <supabase-jwt>
```

The auth proxy validates the JWT, resolves the calling user's `Sundial_User__c` record, and includes the tenant context in every downstream Lambda invocation. Unauthenticated requests return 401.

Webhook endpoints use a separate verification mechanism (signed payload from the source system) since they don't have a user context.

---

## Endpoints

### Authentication

#### `GET /auth/me`

**Lambda:** `sundial-auth-proxy`
**Purpose:** Verifies the caller's Supabase token, resolves the matching `Sundial_User__c` record, and returns the user's identity + tenant scope. Side effect: upserts the caller's `public.profiles` row (for Supabase RLS), which never affects the response.

**Auth:** Supabase JWT (`Authorization: Bearer <jwt>`). 401 if missing/invalid; 403 (`NO_SUNDIAL_USER` / `USER_INACTIVE`) if the token has no matching, active `Sundial_User__c`.

**Response shape (200):**
```json
{
  "user": {
    "id": "a01XX0000034ABCD",
    "firstName": "Tim",
    "lastName": "Murphy",
    "email": "tim@example.com",
    "phone": null,
    "hierarchyLevel": "Client",
    "accessLevel": "Executive",
    "superAdmin": true,
    "defaultDepartment": "Residential Solar",
    "parentUserId": null,
    "supabaseUserId": "8f3c…"
  },
  "tenant": { "clientId": "a1W7y000007AszBEAS" }
}
```

- `accessLevel` (`Access_Level__c`) — gates UI tiers (tabs/sections/fields/reports); frontend only.
- `superAdmin` (`Super_Admin__c`) — strict boolean, gates the Manage Users surface. **Salesforce-set only; never writable via any endpoint.**
- `defaultDepartment` (`Default_Department__c`) — portal landing page only, not an access restriction.
- `tenant.clientId` — the Salesforce Client record id (the tenant isolation key), **not** a slug.

See DECISIONS.md D-043 for the access model.

---

### Salesforce Operations

#### `GET /sf/{object}`

**Lambda:** `sundial-sf-query`
**Purpose:** List or query records of a given Sundial object type. Reads from Supabase cache first, falls back to Salesforce on miss.

**Path parameters:**
- `{object}` — short Sundial object name resolved through a fixed allowlist (Phase 1: `solar`, `customer`, `roofing`, `po`, `user`). Off-allowlist values are rejected with `400 OBJECT_NOT_ALLOWED`. See DECISIONS.md D-035 for the allowlist → Salesforce object → cache table mapping.

**Query string parameters:**
- `limit` — Page size (default **500**, **max 5000**). This is the size of ONE page, not a cap on the dataset — use `offset` to page through everything. Values above the max clamp to 5000; `0`, negative and non-numeric values fall back to the default. At 5000 the 31.6k-row customer sweep is 7 requests instead of 64 (see the G2 note below).
  - The **5000 cap applies to the cache path only.** The live-Salesforce list paths — cold cache, and the TEMP Sales-Rep restrict — keep the original **500** cap, because SOQL `OFFSET` is hard-capped at 2000 and those paths write back every row they return.
  - The cap's real ceiling is Lambda's **6 MB response limit**: 5000 customer rows is ~4.4 MB of JSON. Solar's entire 4,476-row set returns in one request at 3.65 MB.
- `offset` — Start row for the page (default 0). Server-side paginated: the response includes `total` (exact count of all matching rows) and `hasMore`.
- `field` / `value` — Optional single-field filter (string/picklist; a numeric/boolean value may error). A `Client__c` filter from the caller is ignored — tenant scoping is forced.
- `forceFresh` — reserved (not yet honored on the list path).

**Paged response shape:**
```json
{ "source": "cache", "count": 50, "total": 31948, "limit": 50, "offset": 0, "hasMore": true, "records": [ ... ] }
```
- `count` = rows in THIS page; `total` = all matching rows across pages; `hasMore` = `offset + count < total`.
- **LIST and SEARCH rows are a PROJECTION, not the full cache row** (the single-record read is not — it still returns every column):
  - **Null-valued keys are omitted.** A field with no value is ABSENT from the row rather than present as `null`. This has always been true of rows refreshed from Salesforce (`source: "cache+salesforce"`), so it is not a new shape — it is now consistent across every list row. Read fields with `??` / `||` / `?.`, never with `"key" in row`.
  - **Long-text columns are excluded**: `notes`, any column ending `_notes`, any column containing `findings`. Use the single-record read (`GET /sf/{object}/{id}`) or `?full=true` when you need them.
  - Both exist to stay under **Lambda's 6,291,556-byte response cap** — see the warning below.
- Rows are ordered **`created_date` DESC (newest first), NULLs last, with `sf_id` as a stable tiebreaker** — so the first page is the most recent records and paging never shifts rows as they are re-synced. `created_date` is a cache column populated from Salesforce: `CreatedDate` for most objects, **`COALESCE(Contract_Date__c, CreatedDate)` for Solar**. Backed by the `(client_sf_id, created_date DESC NULLS LAST, sf_id)` index. (If the `created_date` column is absent, the endpoint falls back to stable `sf_id` order — no error.) Only the rows on the requested page are freshness-checked/refreshed — a read never scans the whole table.

**Tenant scoping:** Always enforced via the authenticated user's Client__c context — the Salesforce Client record ID resolved from the verified token (`resolveIdentity` → `tenantId`). The cache is filtered on `client_sf_id`; Salesforce is filtered on `Client__c = '<tenantId>'`. The tenant slug is a label only and is never used for isolation. No request input can set or override the tenant. See DECISIONS.md D-035.

**Implementation status:** Built, deployed, and verified end to end against the live org (31,948-row customer set paged correctly with `total`). Cache miss falls through to Salesforce and writes back; an immediate repeat serves `source: "cache"`.

> **Cache completeness:** the cache is kept complete by `sundial-cache-sync` (incremental on a schedule; **full resync** via `{ "mode": "full" }` after a bulk load — see below). The shared `sfQuery` follows the Salesforce query locator (`nextRecordsUrl`) to exhaustion, so neither the sync nor a Salesforce fallback is silently truncated at the 2000-row REST page limit.

> **PostgREST "Max Rows" (why a page over 1000 still works):** Supabase enforces a per-request row ceiling — **1000 by default — and silently truncates past it**: asking PostgREST for 5000 rows returns `206` with 1000 rows and *no error*. Raising this endpoint's own cap alone would therefore have shipped a page size the cache layer quietly ignored. The list read splits any page larger than 1000 into consecutive `.range()` sub-requests (one exact count, on the first), so it returns the full page regardless of the dashboard setting. Raising "Max Rows" in Supabase → Settings → API collapses this back to a single round trip; it does not change correctness.

> **⚠️ Lambda's 6 MB response cap (why list rows are projected):** a Lambda response payload is hard-capped at **6,291,556 bytes**. Past it the runtime never delivers the response — it logs `LAMBDA_RUNTIME Failed to post handler success response. Http response code: 413. {"errorType":"RequestEntityTooLarge"}` and API Gateway returns **502**. Two traps here. First, **the cap applies to the serialized response OBJECT, not the body string**: the body is a JSON string nested inside `{statusCode, headers, body}`, so every quote in it is escaped a second time — measured at ~9% overhead on solar. Second, **the same request can pass or fail depending on cache freshness**: a stale page's rows are rebuilt from Salesforce with null fields omitted (small), while a fresh page serves cache rows with `"column":null` spelled out (large), so a page that 200s right after a refresh can 502 ten minutes later with no code change. Measured on `solar?limit=5000` (4,476 rows): **6.14 MB payload → 413**; dropping long-text columns alone → 6.02 MB, **still over**; dropping null keys → **4.04 MB**. Null omission is what carries this, not the column exclusion. If a list response ever approaches the cap again, lower `MAX_LIMIT` (D-050) — its ceiling was always this limit.

> **⚠️ AWS Lambda concurrency quota (the G2 root cause):** this account's **"Concurrent executions" quota in us-west-1 is 10**, not the AWS default of 1000, and it is shared by all 32 functions. Invocations past it are rejected with `TooManyRequestsException` *before the function runs*, and API Gateway surfaces that as **`500 {"message": "Internal server error"}` in ~65 ms with no CloudWatch log line and no `Errors` metric**. That generic body is API Gateway's, not ours (this Lambda returns `{"error":"server_error"}`) — so if you ever see it with no matching log entry, suspect the quota, not the code. Diagnose with `ConcurrentExecutions` (Max) and `Throttles` in CloudWatch, and `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 --region us-west-1`.

#### `GET /sf/{object}/{id}`

**Lambda:** `sundial-sf-query`
**Purpose:** Fetch a single record by Salesforce ID. Cache-first read.

**Path parameters:**
- `{object}` — short Sundial object name (allowlisted; see above)
- `{id}` — Salesforce record ID (15 or 18 char)

**Tenant scoping:** Same as the list endpoint — isolation keyed on the Salesforce Client record ID. A record outside the caller's tenant (or of the wrong object) returns `404 RECORD_NOT_FOUND`.

**Implementation status:** Built, deployed, and verified end to end against the live org.

> **Routing note:** this resource is verb-split across two Lambdas. `GET` routes to `sundial-sf-query` (read, built). `PATCH` and `DELETE` route to `sundial-sf-update` (writes, not yet built). See DECISIONS.md D-036.

> **Response-shape caveat:** a `source: "cache"` row returns all cache columns (including nulls); a `source: "salesforce"` row returns only describe-selected fields. Shapes are not yet guaranteed identical across sources — the frontend should treat all fields as nullable.

#### `PATCH /sf/{object}/{id}`

**Lambda:** `sundial-sf-update`
**Purpose:** Update fields on a record. Writes to Salesforce, updates cache, broadcasts via Supabase Realtime.

**Request body:** JSON object of field API names to new values.

```json
{
  "Stage__c": "Contract Signed",
  "Project_Manager__c": "a02XX0000045EFGH"
}
```

**Behavior:**
- Validates the authenticated user has permission to edit the record's tenant
- Writes to Salesforce via JSforce
- On success, updates the corresponding cache table
- Broadcasts a change event via Supabase Realtime so other connected clients refresh

#### `DELETE /sf/{object}/{id}`

**Lambda:** `sundial-sf-update`
**Purpose:** Soft-delete or hard-delete a record (depends on object type and business rules). Phase 1 default is soft-delete for project records, hard-delete for draft Lead-status customer records.

---

### File Operations

File storage uses the `{tenant_id}/{object_type}/{sf_record_id}/{filename}` S3 path convention. File metadata lives in Supabase `sundial_file_metadata`. See `docs/file-storage.md` for the full architecture.

The API splits file operations into two paths to satisfy API Gateway's restriction on sibling path variables: `/files/by-record/{recordId}/...` for operations on a Salesforce record's file collection, and `/files/by-id/{fileId}/...` for operations on an individual file metadata record.

#### `GET /files/by-record/{recordId}`

**Lambda:** `sundial-list-files`
**Purpose:** List all files associated with a Salesforce record.

**Path parameters:**
- `{recordId}` — Salesforce record ID of the parent (Sundial_Solar__c, Sundial_Service__c, etc.)

**Query string parameters:**
- `category` — Filter by category tag (e.g., `Proposal`, `Permit`, `Photo`)
- `includeSoftDeleted` — Default false; if true, returns soft-deleted files for restore
- `search` — Free-text search on file_name and description

**Response shape:**
```json
{
  "files": [
    {
      "id": "uuid",
      "fileName": "proposal-signed.pdf",
      "fileSizeBytes": 1247892,
      "mimeType": "application/pdf",
      "category": "Proposal",
      "uploadedAt": "2026-06-12T14:30:00Z",
      "uploadedByUserName": "Tim Murphy",
      "subfolder": null
    }
  ]
}
```

#### `POST /files/by-record/{recordId}/upload`

**Lambda:** `sundial-upload-file`
**Purpose:** Initiate a file upload. Returns a presigned PUT URL for direct browser-to-S3 upload plus a metadata record ID.

**Path parameters:**
- `{recordId}` — Salesforce record ID of the parent

**Request body:**
```json
{
  "fileName": "proposal-signed.pdf",
  "mimeType": "application/pdf",
  "fileSizeBytes": 1247892,
  "sfObjectType": "Sundial_Solar__c",
  "category": "Proposal",
  "description": "Signed contract from customer",
  "subfolder": null
}
```

**Response shape:**
```json
{
  "metadataId": "uuid",
  "uploadUrl": "https://constructive-sundial-files.s3.us-west-1.amazonaws.com/...",
  "expiresIn": 900
}
```

The frontend then PUTs the file bytes directly to `uploadUrl` (does not go through Lambda).

#### `GET /files/by-record/{recordId}/related`

**Lambda:** `sundial-list-related-files`
**Purpose:** Returns files from records related to this one. For a Sundial_Solar__c, this means files from the linked Sundial_Customer__c, any linked Sundial_Roofing__c, related Sundial_PO__c records, and the originating Sundial_Service__c if applicable.

**Response shape:**
```json
{
  "relatedFileGroups": [
    {
      "sourceObjectType": "Sundial_Customer__c",
      "sourceRecordId": "a03XX0000023XYZW",
      "sourceRecordName": "Smith Family - 123 Main St",
      "files": [ /* same shape as list-files */ ]
    }
  ]
}
```

#### `GET /files/by-id/{fileId}/download`

**Lambda:** `sundial-download-file`
**Purpose:** Returns a presigned GET URL for downloading a specific file.

**Path parameters:**
- `{fileId}` — UUID from `sundial_file_metadata`

**Response shape:**
```json
{
  "downloadUrl": "https://constructive-sundial-files.s3.us-west-1.amazonaws.com/...",
  "fileName": "proposal-signed.pdf",
  "mimeType": "application/pdf",
  "expiresIn": 900
}
```

#### `DELETE /files/by-id/{fileId}`

**Lambda:** `sundial-delete-file`
**Purpose:** Soft-delete a file. Marks metadata as deleted and hides from default lists. Hard delete occurs after the retention period via a scheduled cleanup Lambda.

**Response:** 204 No Content on success.

#### `POST /projects/{customerId}/files/copy-to-solar`

**Lambda:** `sundial-list-files`
**Purpose:** Backs the "Create Project" button. Copies every file in the **Customer's** S3 folder into the newly created **Solar project's** folder, so the new project starts with the customer's documents attached. Server-side S3 `CopyObject` — bytes never pass through the Lambda.

**Path parameters:**
- `{customerId}` — a **`Sundial_Customer__c`** record ID (15 or 18 char).

> **Gateway variable name:** the resource is registered as `/projects/{recordId}/files/copy-to-solar` because `/projects/{recordId}` already exists (budget recalc) and API Gateway forbids sibling path variables with different names (see *Path Variable Notes*). The URL callers use is unchanged — the id in that position is a **customer** id.

**Auth:** Supabase JWT (`Authorization: Bearer <jwt>`), verified in-Lambda via `resolveIdentity`. Both the customer read and the resolved solar project are tenant-scoped (`Client__c = <caller tenant>`, D-035); a missing or cross-tenant customer returns 404.

**Request body:** none required (send `{}`).

**Destination resolution — never client-supplied.** The target is read server-side from the customer's `Linked_Solar_Project__c`. That is the *only* destination; no request input can redirect the copy. If the field is empty → `400 NO_LINKED_PROJECT` (create the Solar project first). If it points outside the caller's tenant (bad data) → `400 LINKED_PROJECT_NOT_ACCESSIBLE`, nothing copied.

**Behavior:**
- Copies `SUNDIAL/{customerId}/*` → `SUNDIAL/{solarRecordId}/*`, preserving filenames **and** any nested subfolder path. Folder-placeholder keys are skipped.
- **Zero files is a success:** `200 { "copied": 0 }`.
- **Idempotent:** destination keys are deterministic, so a re-run overwrites in place rather than duplicating. Re-running is the supported recovery after a partial failure.
- **Per-object fault isolation:** one object failing does not abort the batch — the rest still copy and the failures come back in `failed[]` (the call is still a 200).
- Copies are also registered in Supabase `sundial_file_metadata` (category `Copied from Customer`) **best-effort**. The deployed Files tab lists straight from S3, so files appear regardless; this only keeps the documented metadata-backed design (D-029) in sync, mirroring the budget snapshot writer. A Supabase outage cannot fail the copy.

**Response (200):**
```json
{
  "customerId": "a1P7y00000AUo6TEAT",
  "solarRecordId": "a1Q7y00000JDmqHEAT",
  "copied": 3,
  "failedCount": 0,
  "files": [{ "fileName": "contract.pdf", "key": "SUNDIAL/a1Q.../contract.pdf", "size": 39 }],
  "failed": [],
  "metadataRegistered": 3
}
```
`publicUrl` is deliberately **not** returned — the caller already sees these files on the customer, and the response should not hand out solar-prefixed links (the TEMP Sales Rep solar-files restriction guards those).

**Errors:** 400 (`INVALID_RECORD_ID`, `NO_LINKED_PROJECT`, `LINKED_PROJECT_NOT_ACCESSIBLE`), 401 (no/invalid token), 403 (`NO_TENANT`), 404 (`RECORD_NOT_FOUND`, incl. cross-tenant), 500 (`server_error`).

**IAM:** needs `s3:ListBucket` on `sfsolproj` plus `GetObject`/`PutObject` on `sfsolproj/SUNDIAL/*`. Verified 2026-08-03 — `sundial-lambda-execution-role` has `AmazonS3FullAccess` attached, so **no IAM change was required**.

**Smoke test:** `node scripts/verify-copy-to-solar-e2e.mjs` — creates a throwaway customer + linked solar project + portal user + S3 objects, exercises the live route, and deletes everything (teardown is verified, not assumed). Unit tests: `lambdas/sundial-list-files/test.js` (`npm test`).

```bash
# Manual equivalent (token from the portal's session):
curl -i -X POST \
  "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod/projects/<CUSTOMER_ID>/files/copy-to-solar" \
  -H "Authorization: Bearer <SUPABASE_JWT>" \
  -H "Content-Type: application/json" -d '{}'
```

---

### Budget

#### `POST /projects/{recordId}/budget/recalc`

**Lambda:** `sundial-budget`
**Purpose:** Recalculate a residential solar project's budget on demand (the portal "Recalculate Budget" button). Synchronous: reads the project's budget input fields, runs the pinned calculation engine, writes a datestamped workbook snapshot to S3 (`SUNDIAL/{recordId}/Budget_{Name}_{YYYYMMDD-HHMMSS}.xlsx`), PATCHes the computed output + control fields back to `Sundial_Solar__c`, and returns the computed fields so the UI can refresh instantly.

**Path parameters:**
- `{recordId}` — `Sundial_Solar__c` record ID (15 or 18 char)

**Auth:** Supabase JWT (`Authorization: Bearer <jwt>`), verified in-Lambda via `resolveIdentity`. The record read is tenant-scoped (`Client__c = <caller tenant>`, keyed on the Salesforce Client record ID per D-035); a missing or cross-tenant id returns 404.

**Request body:** none required (the id comes from the path). `{ "recordId": "<id>" }` is also accepted as a fallback.

**Response shape (200):**
```json
{
  "recordId": "a0XXX0000001ABC",
  "source": "Button",
  "s3Key": "SUNDIAL/a0XXX0000001ABC/Budget_HOLLAND_20260721-120000.xlsx",
  "fields": {
    "System_Size_Watts__c": 19800,
    "Total_Material_Budget__c": 60675.44,
    "Total_Labor_Budget__c": 9547.75,
    "Total_Labor_Burden_Budget__c": 7160.8125,
    "Total_Other_Budget__c": 2989.15,
    "Total_Job_Cost__c": 82023.1525,
    "GP_Dollars__c": 21968.6,
    "Total_Job_Hours__c": 268,
    "...": "all computed output fields written back to Sundial_Solar__c"
  }
}
```
The Lambda also sets `Budget_Calc_Status__c = 'Calculated'`, `Budget_Last_Calculated__c`, and `Latest_Budget_File_Path__c` on the record. On failure it flips `Budget_Calc_Status__c = 'Error'` with `Budget_Calc_Error__c` and returns 500.

**Errors:** 401 (no/invalid token), 403 (`NO_SUNDIAL_USER` / `USER_INACTIVE` / `NO_TENANT`), 404 (`RECORD_NOT_FOUND`, incl. cross-tenant), 400 (`MISSING_RECORD_ID`), 500 (`server_error`).

**Other recalc trigger (not an HTTP route):** the same Lambda also runs from the `Sundial_Budget_Recalc__e` platform event via the EventBridge/SQS relay (field-change Flow). See `docs/integrations/budget-recalc-relay.md` and the Flow in `salesforce/flows/`. Calc-in-Lambda rationale: D-038.

### Design Request

#### `POST /customers/{recordId}/design-request/submit`

**Lambda:** `sundial-aurora-push`
**Purpose:** The "Submit Design Request" button on the **Customer** record's Design Request Form tab. It pushes the customer to Aurora Solar (creates the Aurora project + 12-month consumption profile), writes `Sent_to_Aurora__c` + `Aurora_Project_ID__c` back to the customer, and emails the design manager the **full Design Request field set**.

> **Why the customer, not a project:** no `Sundial_Solar__c` record exists at design-request time — a Solar project is created only after the proposal is done and the docs are signed. All Aurora integration operates on `Sundial_Customer__c`. See **D-047** (supersedes the earlier `/projects/{solarId}/…` route, which was wired but never used by any frontend and has been removed).

**Idempotency — two separate guarantees.** Project creation is **once-only**; notification delivery is **independently retryable**:

| Marker | Meaning | Effect on re-submit |
|---|---|---|
| `Sent_to_Aurora__c` / `Aurora_Project_ID__c` | An Aurora project was created | Never creates a second one. Ever. |
| `Design_Request_Email_Sent__c` | A notification actually **landed** | Only this suppresses the email |

Because Aurora has no design-request API, **the email *is* the design request**. If both facts shared one marker, a first submit whose email failed (SES error, env not yet configured) would leave an Aurora project stamped as submitted with nobody notified, and every re-submit would return `already_submitted` — no recovery path from inside the product. So a re-submit whose notification never landed **re-sends it** (same payload, fields re-read fresh) and returns `email.sent: true, resend: true`, making no Aurora calls at all. See D-047.

**Path parameters:**
- `{recordId}` — **`Sundial_Customer__c`** record ID (15 or 18 char).

**Auth:** Supabase JWT (`Authorization: Bearer <jwt>`), verified in-Lambda via `resolveIdentity`. The customer read and write-back are tenant-scoped (`Client__c = <caller tenant>`, D-035); a missing or cross-tenant id returns 404 (indistinguishable, by design).

**Request body:** none required (send `{}`). The path carries the record id, and **every field value is read fresh from Salesforce at submit time** — nothing in the body is trusted beyond the route itself.

**What goes where.** Aurora's project-create API accepts only customer identity + site address; the consumption endpoint accepts the 12 monthly usage values. **None** of the Design Request form fields have an Aurora API home, so the notification email is their delivery channel (the design manager keys them into Aurora). Full mapping: `docs/integrations/aurora-api-reference.md`.

| Data | Aurora API | Email |
|---|---|---|
| `Name`, `First_Name__c`, `Last_Name__c`, `Primary_Email__c`, `Primary_Phone__c` | ✅ `customer_*` | ✅ |
| `Street__c`, `City__c`, `State__c`, `Postal_Code__c` | ✅ `location.property_address` (one geocodable line) | ✅ |
| `Jan_Usage_kW__c` … `Dec_Usage_kW__c` | ✅ `consumption_profile.monthly_energy[12]` | ✅ (compact summary line) |
| `Project_Type__c`, `Existing_Solar_System__c`, `Existing_Panel_Count__c`, `Design_Turnaround__c`, `Proposed_Panel_Type__c`, `Inverter_Type__c`, `Battery_Type__c`, `Battery_Quantity__c`, `For_Profit_PPW__c`, `Annual_Usage_kWh__c`, `Utility_Company__c`, `Appointment_DateTime__c`, `Proposed_Panel_Count__c`, `Offset_Requested__c`, `Financing_Type__c`, `Financing_Partner__c`, `Term__c`, `APR__c`, `Design_Notes__c` | ❌ not accepted by any Aurora endpoint | ✅ **email only** |

The email field list is filtered against the live `Sundial_Customer__c` describe (5-min TTL cache), so a field the org doesn't have yet is skipped rather than breaking the SOQL. Two fields are in that state today:
- **`Design_Notes__c`** — that row is simply absent from the email until it is created in Salesforce.
- **`Design_Request_Email_Sent__c`** — until it exists there is nowhere to record delivery, so the route cannot tell a delivered notification from an undelivered one. It resolves that ambiguity toward **re-sending** (silence is the failure being guarded against), reporting `email.tracking: "unavailable"`. In practice the button doubles as a manual "re-send the design request" until the field is created. Neither field needs a code change or redeploy when created.

**Response shape (200):**
```json
{
  "status": "pushed",
  "auroraProjectId": "43bfd824-…",
  "recordId": "<customer id>",
  "consumption": "sent",
  "email": { "sent": true, "messageId": "…", "recipients": { "to": 1, "cc": 1 } }
}
```
- `status` is one of `pushed`, `already_pushed`, or `pushed_writeback_failed` (Aurora project created but the SF write-back failed — non-retryable, the id is in the body so it isn't lost).
- `consumption` is `sent`, `skipped_no_data`, or `failed`.
- `already_pushed` also carries `sentToAurora`, and `notifiedAt` when a notification had already landed.

**The `email` object:**

| Key | When | Meaning |
|---|---|---|
| `sent` | always | Did a notification go out on this call |
| `messageId`, `recipients: { to, cc }` | `sent: true` | SES message id; recipient **counts** (addresses are never returned or logged) |
| `resend` | `true` on a recovery re-send | This was a re-submit whose earlier notification never landed. No Aurora calls were made. |
| `reason` | `sent: false` | `email_not_configured`, `no_recipient_configured`, `already_submitted` (a notification already landed), or the SES error |
| `tracking: "unavailable"` | when `Design_Request_Email_Sent__c` doesn't exist | Delivery can't be recorded, so re-submits keep re-sending |
| `trackingWriteFailed: true` | rare | The email sent but stamping the marker failed; worst case a later re-submit sends one duplicate |

**Email is always non-fatal** — a failed notification never fails the push, the email is still sent when the Salesforce write-back fails (the request *was* submitted), and a failure never marks the request as notified, so it stays recoverable by re-submitting.

**Errors:** 400 (`INVALID_RECORD_ID`, `MISSING_SITE_ADDRESS`), 401 (no/invalid token), 403 (`NO_TENANT`), 404 (`RECORD_NOT_FOUND`, incl. cross-tenant), 502 (`aurora_create_failed`).

**Also supported (manual, not the button):** the body-based call `POST` with `{ "object": "customer", "recordId": "<customer id>", "retryConsumptionOnly"?: true }` still works for a direct customer push / consumption resend. It sends no email.

**Tests:** `lambdas/sundial-aurora-push/test.js` (`npm test`) — happy path, re-submit after a successful notification (no email) vs. after a failed one (re-sends, no Aurora call), missing customer, cross-tenant rejection, CC set/unset, write-back failure, SES failure, and the describe guard when `Design_Request_Email_Sent__c` is absent.

---

### Admin — User Management

**Lambda:** `sundial-user-admin`

All routes require a Supabase JWT **and** the caller's `Super_Admin__c = true` (verified in-Lambda via `resolveIdentity`; `403 NOT_SUPER_ADMIN` otherwise, fail closed). Every read/write is tenant-scoped on `Client__c` from the token — a Super Admin can only manage their **own** tenant's users. `Super_Admin__c`, `Client__c`, and `Supabase_User_Id__c` are **never** writable from request input; email is not editable via PATCH. See DECISIONS.md D-044.

#### `GET /admin/users`

Lists all `Sundial_User__c` in the caller's tenant, **including inactive**.

**Response (200):**
```json
{
  "users": [
    {
      "id": "a0X...", "firstName": "Jane", "lastName": "Doe",
      "email": "jane@example.com", "phone": null,
      "accessLevel": "Sales Rep", "defaultDepartment": "Roofing",
      "active": true, "superAdmin": false, "hierarchyLevel": "Sales Rep",
      "hasLogin": true
    }
  ]
}
```
`hasLogin` is a boolean (is a Supabase auth user linked); the actual `Supabase_User_Id__c` is never returned.

#### `POST /admin/users`

Creates a portal user: a Supabase auth user **and** a `Sundial_User__c`.

**Request:**
```json
{
  "firstName": "Jane", "lastName": "Doe",
  "email": "jane@example.com", "phone": "602-555-0100",
  "accessLevel": "Sales Rep", "defaultDepartment": "Roofing",
  "credentialMode": "invite",
  "tempPassword": "<password mode only, min 8>"
}
```
- `credentialMode: "invite"` emails a set-password link (with `redirectTo` → `<PORTAL_BASE_URL>/reset-password`); `"password"` creates the user with `tempPassword` (email pre-confirmed, `must_change_password` flag).
- `PORTAL_BASE_URL` is a Lambda env var (defaults to `https://harmon-crm.vercel.app`). Set it to the client's real domain at go-live so invite links land on the live portal — a config change, no redeploy of code required.
- **Order** (fail-safe): duplicate-guard (409) → Supabase auth create (reuses an existing auth user by email if already registered) → `Sundial_User__c` create (force-stamps `Client__c`, sets the auth id). If the SF create fails after a *fresh* auth user was made, that auth user is deleted (compensating); if the delete also fails, the response includes `orphanAuthUser: true`.

**Response (201):**
```json
{ "id": "a0X...", "email": "jane@example.com", "credentialMode": "invite", "inviteSent": true }
```
**Errors:** 400 `VALIDATION_ERROR` (field-level `fields`), 409 `USER_ALREADY_EXISTS`, 502 `SUPABASE_CREATE_FAILED` / `SF_CREATE_FAILED`. `tempPassword` is never logged or returned.

#### `PATCH /admin/users/{id}`

Updates whitelisted fields on one tenant user. Body may contain `firstName`, `lastName`, `phone`, `accessLevel`, `defaultDepartment`, `active` (boolean). Any other key (`superAdmin`, `email`, `Client__c`, `Supabase_User_Id__c`, `hierarchyLevel`, …) → 400 `FIELD_NOT_ALLOWED`.
- Tenant pre-check: a cross-tenant or missing id → 404 `RECORD_NOT_FOUND`.
- `active: false` also **bans** the linked Supabase auth user (kills live supabase-direct sessions, e.g. comments RLS); `active: true` unbans. The ban/unban is **retried (3 attempts, backoff)** so a transient blip can't leave a deactivated user un-banned or a reactivated user stuck banned. Salesforce `Active__c` is the source of truth — a persistent ban failure still applies the SF change and returns `supabaseBanFailed: true`.
- A Super Admin **cannot deactivate themselves** → 400 `CANNOT_DEACTIVATE_SELF`.

**Response (200):** `{ "success": true, "id": "a0X..." }`

---

### Webhooks

#### `GET /webhooks/aurora/agreement-status`

**Lambda:** `sundial-aurora-webhook` (doorbell) → SQS `sundial-aurora-inbound` → `sundial-aurora-inbound` (worker)
**Purpose:** Receives Aurora's `agreement_status_changed` webhook. The doorbell **only** authenticates, validates, enqueues, and acks; all retrieval and write-back happens in the worker. Full setup runbook: `docs/integrations/aurora-inbound.md`. Design rationale: **D-048**, extended by **D-049**.

> **Why a doorbell:** Aurora counts a delivery as failed if we don't respond within **10 seconds**, and ~48h of failures **auto-disables the subscription**. The four retrievals + signed-PDF generation cannot fit in that budget.

**Authentication:** shared secret in the `X-Aurora-Webhook-Token` header, constant-time compared in-Lambda against `webhook_token` from Secrets Manager (`sundial/aurora/webhook` if present, else `sundial/aurora/api`; cached 5 min so the token is rotatable without a redeploy). **No Supabase JWT and no API Gateway authorizer** — the caller is a machine with no portal user. A missing or wrong token is a 401 before anything else happens.

**Query parameters** (all five must be in Aurora's `url_template`; `PROJECT_ID`/`AGREEMENT_ID`/`STATUS` are required):
- `project_id` — the Aurora project; resolves the customer via `Aurora_Project_ID__c`
- `design_id` — required for the `signed` path (design summary, proposal, financing)
- `agreement_id` — the agreement whose status changed
- `financing_id` — **empty when no financing option was selected**; the worker then skips the financing retrieval entirely (requesting it would 404)
- `status` — `sent` | `viewed` | `signed` | `cancel-pending` | `canceled` | `declined` | `error` (the subscription takes **all** of them)

**Responses:**
| Code | When | Why it matters |
|---|---|---|
| 200 | enqueued | Aurora considers the delivery successful |
| 400 | missing `project_id`/`agreement_id`/`status` | not retryable by Aurora; nothing enqueued |
| 401 | missing/invalid token | the only gate on a public endpoint |
| 500 | **enqueue failed or `AURORA_INBOUND_QUEUE_URL` unset** | **deliberate** — a 5xx drives Aurora's retry ladder so the event isn't lost. Acking an event we failed to queue would silently drop a signed contract. |

**Worker behavior (not an HTTP route):** every status updates the agreement tracking fields on `Sundial_Customer__c`, deduped on `(agreement_id, status)` with a precedence rank so a late `viewed` cannot regress a `signed`. The negative terminal statuses (`canceled`, `cancel-pending`, `declined`) are **confirmed with a fresh `GET /agreements/{id}`** before precedence is applied: if Aurora agrees the agreement is dead it is applied even over a recorded `signed` and a cancellation email is sent; if Aurora still says `signed` the event is dropped as stale (D-048 amendment). A `signed` event additionally retrieves the agreement (confirming Aurora still says signed — if the re-read shows a dead agreement it records Aurora's status and sends the same cancellation notification instead), design summary, default proposal, and financing; writes the mapped fields; stores the signed PDF at `SUNDIAL/{customerId}/{agreementId}-signed-agreement.pdf`; and emails the design manager once. Failures report `batchItemFailures`, so SQS redrives to `sundial-aurora-inbound-dlq` after 5 receives; permanent classes (ambiguous/mismatched customer, missing `design_id`, any Aurora **403 = endpoint not provisioned for our key**) are logged with a `PERMANENT` marker.

**Dealer origination (D-049):** a **signed** event for an Aurora project no customer carries no longer dead-letters — the worker fetches Retrieve Project and either **creates** the customer (dealer-originated: no `external_provider_id`) or **repairs** the missing `Aurora_Project_ID__c` on our own customer (provider id that resolves). Unmatched **non-signed** events create nothing and are dropped quietly unless they carry a provider id. See the runbook's dealer-origination table.

**Env:** `AURORA_INBOUND_QUEUE_URL` (doorbell, required); `EMAIL_FROM` + `DESIGN_REQUEST_NOTIFY_TO` / `DESIGN_REQUEST_NOTIFY_CC` and `SUNDIAL_TENANT_SLUG` (worker).

**Tests:** `lambdas/sundial-aurora-webhook/test.js` (14) and `lambdas/sundial-aurora-inbound/test.js` (55), via `npm test`.

#### `POST /webhooks/acumatica`

**Lambda:** `sundial-acumatica-webhook`
**Purpose:** Inbound webhook from Acumatica for payment events, vendor bill status changes, project closeout signals, etc.

**Authentication:** Validates a shared secret in the request header (configured during Phase 1 Acumatica integration setup). Does NOT use Supabase JWT.

**Request body:** Acumatica's generic inquiry webhook payload format. Schema TBD during Phase 1 integration.

**Behavior:**
- Validates the signature/secret
- Identifies the event type
- Routes to the appropriate handler (payment received, PO status update, etc.)
- Updates Salesforce via the integration user
- Updates Supabase cache
- Broadcasts via Realtime to connected clients

---

## Path Variable Notes

API Gateway does not allow two path variables with different names to coexist as siblings at the same level. This is why file operations use `/files/by-record/{recordId}/...` and `/files/by-id/{fileId}/...` rather than `/files/{recordId}/...` and `/files/{fileId}/...` as siblings. The `by-record` and `by-id` segments disambiguate the two paths.

When adding new endpoints with path variables, check that you're not creating a sibling-variable conflict before deploying.

---

## Lambda Function to Endpoint Map

Quick reference of which Lambda handles which routes:

| Lambda | Routes |
|---|---|
| `sundial-auth-proxy` | GET /auth/me |
| `sundial-sf-query` | GET /sf/{object}, GET /sf/{object}/{id} |
| `sundial-sf-update` | PATCH /sf/{object}/{id}, DELETE /sf/{object}/{id} |
| `sundial-list-files` | GET /files/by-record/{recordId}, POST /projects/{customerId}/files/copy-to-solar |
| `sundial-upload-file` | POST /files/by-record/{recordId}/upload |
| `sundial-list-related-files` | GET /files/by-record/{recordId}/related |
| `sundial-download-file` | GET /files/by-id/{fileId}/download |
| `sundial-delete-file` | DELETE /files/by-id/{fileId} |
| `sundial-budget` | POST /projects/{recordId}/budget/recalc |
| `sundial-user-admin` | GET /admin/users, POST /admin/users, PATCH /admin/users/{id} |
| `sundial-aurora-push` | POST /customers/{recordId}/design-request/submit |
| `sundial-aurora-webhook` | GET /webhooks/aurora/agreement-status (doorbell → SQS) |
| `sundial-acumatica-webhook` | POST /webhooks/acumatica |

Lambda functions not exposed through API Gateway:

| Lambda | Trigger | Purpose |
|---|---|---|
| `sundial-aurora-inbound` | SQS (`sundial-aurora-inbound`, DLQ after 5) | Processes Aurora agreement-status events: retrievals, `Sundial_Customer__c` write-back, signed PDF to S3, design-manager email, dealer-origination auto-create (D-048/D-049) |
| `sundial-acumatica-push` | SQS (sundial-acumatica-outbound) | Outbound calls to Acumatica with rate-limit handling |
| `sundial-dropbox-sync` | S3 PUT events on `constructive-sundial-files` | Mirrors uploaded files to Harmon's Dropbox |
| `sundial-cache-invalidator` | Salesforce Platform Events (Phase 2+) | Propagates out-of-band Salesforce changes to the cache |

---

## Lambda Environment Variables

Config that must not live in code (addresses, domains, regions) is set per-Lambda as an environment variable. Secrets stay in Secrets Manager — **never** put credentials here.

| Variable | Lambda(s) | Required | Purpose |
|---|---|---|---|
| `DESIGN_REQUEST_NOTIFY_TO` | `sundial-aurora-push`, `sundial-aurora-inbound` | **Yes** (for the email step) | The design manager who receives the Design Request notification **and** the signed-agreement / cancellation notifications. Accepts a comma- or semicolon-separated list. If unset, the work still succeeds and the result reports `no_recipient_configured`. |
| `DESIGN_REQUEST_NOTIFY_CC` | `sundial-aurora-push`, `sundial-aurora-inbound` | No | The director (or anyone else) CC'd on those notifications. Same list format. When unset, **no Cc header is sent at all**. |
| `AURORA_INBOUND_QUEUE_URL` | `sundial-aurora-webhook` | **Yes** | The SQS queue the Aurora doorbell enqueues to. If unset the doorbell returns **500 on purpose** so Aurora retries rather than the event being acked into a void. |
| `SUNDIAL_TENANT_SLUG` | `sundial-aurora-inbound` | No (defaults `harmon`) | Tenant slug resolved to the `Sundial_Tenant__c` record id for `Client__c` on auto-created dealer customers (D-049). Same identity as `VITE_TENANT_ID` and the S3 prefix. |
| `EMAIL_FROM` | any sender (`sundial-aurora-push`, `sundial-aurora-inbound`, …) | Yes to send | Verified SES From address, e.g. `Sundial <no-reply@sundialcrm.com>`. Until it is set, `lib/email.js` reports "not configured" and senders skip the email instead of failing. |
| `EMAIL_REPLY_TO` | any sender | No | Default Reply-To. |
| `SES_REGION` | any sender | No | Region the SES identity is verified in (defaults to `us-west-1`). |
| `EMAIL_CONFIG_SET` | any sender | No | SES configuration set for bounce/complaint tracking. |
| `PORTAL_BASE_URL` | `sundial-user-admin` | No | Base URL for invite links (defaults to `https://harmon-crm.vercel.app`). Set to the client's real domain at go-live. |

Setting them (⚠️ `update-function-configuration` **replaces** the whole Variables map — include every var the function needs in one command):

```powershell
# Check what's there first
aws lambda get-function-configuration --function-name sundial-aurora-push `
  --region us-west-1 --query 'Environment.Variables'

aws lambda update-function-configuration `
  --function-name sundial-aurora-push `
  --region us-west-1 `
  --environment "Variables={EMAIL_FROM=Sundial <no-reply@sundialcrm.com>,DESIGN_REQUEST_NOTIFY_TO=designmanager@harmonelectric.net,DESIGN_REQUEST_NOTIFY_CC=director@harmonelectric.net}"
```

The sending Lambda's execution role also needs `ses:SendEmail` for the email step to succeed.

---

## Deployment

API Gateway deployment is manual via the AWS Console (Actions → Deploy API → stage `prod`). When Phase 1 begins, this should be moved to an infrastructure-as-code workflow (Terraform, CDK, or SAM) so changes can be reviewed in pull requests and rolled back if needed.

Until then: any route changes in the Console must be deployed via Actions → Deploy API before they take effect at the prod URL.
