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

Every resource has an OPTIONS method automatically added for CORS preflight.
**Preflight is answered by API Gateway itself** (it returns `Access-Control-Allow-Origin: *`),
so an `OPTIONS` probe does *not* exercise the allowlist below — verify with a real
`GET`/`POST` carrying an `Origin` header.

Actual responses carry the Lambda's own CORS headers. Allowed origins:

- `https://sundial.harmonelectric.net` (production portal domain)
- `https://*.vercel.app` (preview deploys, and `harmon-crm.vercel.app`, retained as a redirect)
- `http://localhost:5173` (local dev)

An allowed origin is echoed back; anything else falls back to `http://localhost:5173`,
so an untrusted origin is never reflected.

**Methods.** The `/service/*` and `/public/*` routes are wired with their own `OPTIONS`
method to the Lambda (`scripts/wire-service-*-routes.ps1`), so for those the Lambda —
not the gateway — answers the preflight, and its `Access-Control-Allow-Methods` must
list every verb the portal uses. `lib/http.js` says `GET, POST, PATCH, PUT, DELETE,
OPTIONS` (2026-09-11: it lacked PATCH, so every estimate money edit and every board
drag failed in the browser as "Save failed." before reaching the API).

⚠️ **The allowlist lives in six places.** `lib/http.js` is bundled into
`sundial-user-admin`, `sundial-list-files`, `sundial-list-related-files`,
`sundial-upload-file`, `sundial-delete-file`, `sundial-budget`,
`sundial-acumatica-budget-push`, `sundial-service-estimate`, `sundial-service-public`
and `sundial-service-board`; five Lambdas carry their own inline copy —
`sundial-auth-proxy`, `sundial-sf-query`, `sundial-sf-update`,
`sundial-acumatica-push`, `sundial-aurora-push`. Adding an origin means editing all
six and redeploying all twelve. (Consolidation is logged as tech debt in TASKS.md.)

---

## Authentication

All requests except the `/webhooks/*` routes require a Supabase JWT in the `Authorization` header:

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
- `parentId` — **Related-records filter.** Returns only the children of one parent record, for a record's related list: `GET /sf/solar?parentId=<customerSfId>` is "this customer's solar projects". Composes with `limit`/`offset`, `q`, and `field`/`value`; the response shape is unchanged.
- `forceFresh` — reserved (not yet honored on the list path).

**`?parentId=` — supported objects and behavior**

| `{object}` | Parent lookup (Salesforce) | Cache column |
|---|---|---|
| `solar` | `Sundial_Customer__c` | `sundial_customer_sf_id` |
| `roofing` | `Sundial_Customer__c` | `sundial_customer_sf_id` |
| `customer`, `po`, `user` | — (no parent registered) | — |

Adding a child object is **one entry** in the `PARENT_FILTER` registry in
`lambdas/sundial-sf-query/index.js` — no other code change. The cache column is
`sfFieldToColumn()` of the lookup: API name minus `__c`, lowercased, plus `_sf_id`.

- **Unsupported object → `400 PARENT_FILTER_UNSUPPORTED`.** Deliberately an error, not a silently ignored parameter: dropping the filter would answer a related-list request with the tenant's *entire* table, and the caller could not tell the difference.
- **Malformed id → `400 INVALID_PARENT_ID`**, rejected before any cache or Salesforce query runs. Accepts 15- or 18-char Salesforce ids.
- An **empty** `parentId` is treated as absent (unfiltered list), not as a bad id.
- It only ever **narrows**. It is ANDed with the tenant scope and with the TEMP Sales-Rep restriction, so a restricted rep browsing a customer's related list sees the intersection — their own projects for that customer — never another rep's. The rep clause is applied first and is never relaxed by a caller filter.

> **⚠️ Zero rows is a normal answer here, and it collides with the cold-cache path.**
> A customer with no projects produces an empty cache result, which is
> indistinguishable from "this tenant/object has nothing cached yet" — the trigger for
> the live-Salesforce fallback. The parent clause is therefore carried into that
> fallback's SOQL, so it re-asks Salesforce for *that parent's* children and correctly
> returns an empty list. Without that, an empty related list would fall through and
> return the tenant's whole table. Same reasoning applies to any future filter that can
> legitimately match zero rows.

**Paged response shape:**
```json
{ "source": "cache", "count": 50, "total": 31948, "limit": 50, "offset": 0, "hasMore": true, "records": [ ... ] }
```
- `count` = rows in THIS page; `total` = all matching rows across pages; `hasMore` = `offset + count < total`.
- **LIST and SEARCH rows are a PROJECTION, not the full cache row** (the single-record read is not — it still returns every column):
  - **Null-valued keys are omitted.** A field with no value is ABSENT from the row rather than present as `null`. This has always been true of rows refreshed from Salesforce (`source: "cache+salesforce"`), so it is not a new shape — it is now consistent across every list row. Read fields with `??` / `||` / `?.`, never with `"key" in row`.
  - **Long-text columns are excluded**: `notes`, any column ending `_notes`, any column containing `findings`. Use the single-record read (`GET /sf/{object}/{id}`) or `?full=true` when you need them.

  - **`?full=true` carries an `access` block** (D-064 §4.3):

    ```json
    "access": { "visible": ["Primary_Email__c", …], "editable": [ … ], "manifestVersion": "…" }
    ```

    `visible` = the fields the caller may render, `editable` = the subset they may write. **Both
    `null` means tenant scope** (no restriction); `[]` means "nothing", which is not the same thing.
    The client reflects both and decides neither — the server refuses regardless.

    List and search responses carry **no `access` block**: their rows are projected to `listColumns`
    in snake_case (`sf_id`, …), so the field predicate does not apply to them.
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
- `{recordId}` — Salesforce record ID of the parent (Sundial_Solar__c, Sundial_Service_Job__c, etc.)

**Object key (`?object=` on GET / `object` in the POST body) — required, allowlisted in `lib/file-access.js`:** `solar`, `customer`, `roofing`, `po`, `user`, and since 2026-09-11 the service keys `estimate`, `job`, `servicecall`. Every key is gated by a matching `files.<key>.<verb>` row in `lib/access.js` — an allowlist entry without action rows is a 403 for everyone (that was Roofing's and PO's state until 2026-09-11; fixed, and `lib/access.test.js` now pins the two lists together). The estimate's folder receives `estimate-v{n}.pdf` on every send; job files (and service-call photos under `photos/{serviceCallId}/`) live under the job.

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

#### `POST /projects/{recordId}/budget/attributes-sync`

**Lambda:** `sundial-acumatica-budget-push` (same function as the budget push; it dispatches on the resource path)
**Wiring:** `scripts/wire-attributes-sync-route.ps1`
**Purpose:** Push a project's Acumatica **attributes** — the five lifecycle dates, `KW` and `SALESPERSO` — without touching its budget. Built for **legacy and non-budgeted jobs**: projects that predate the integration, were budgeted by hand, or were calculated by the v1 engine, whose attributes still need to be current because that is what Harmon's accounting reporting reads.

**Synchronous** (200/409/502, not 202). One SOQL, one Acumatica read, one PUT, one verifying re-read, one Salesforce update — five round trips, comfortably inside API Gateway's ~29s cap. The budget push next door self-invokes because it writes ~20 budget lines with retries; this does not, and making it async would cost the caller an immediate answer for nothing.

**Auth:** Supabase JWT in `Authorization`, verified inside the Lambda (`resolveIdentity`). The tenant comes only from the verified token and scopes the record read.

##### One gate, and only one

The record must carry an `Acumatica_Project_ID__c`. **There is deliberately no `Budget_Calc_Status__c` check and no `Commission_Deal_Type__c` guard.** Those exist to stop a *wrong budget* being posted, and this route posts no budget. A legacy record legitimately has neither, so gating on them would refuse exactly the records this exists to serve.

##### What it writes — and what it structurally cannot

Only `NON_COMMISSION_ATTRIBUTES`: `AUDITDATE`, `INDESIGN`, `INCOMDATE`, `GREENTAG`, `COMDATE`, `KW`, `SALESPERSO`. Populated values only.

**It never writes `SLSCOM1/2`, `MGRCOM1/2`, `MGMTOR1/2` or `JOBTYPE`.** That matters because legacy projects carry commission attributes **Harmon entered by hand** — `R261065` held `SLSCOM1 = 1538.00` / `SLSCOM2 = 2138.00`, matching neither the third-party rule nor the 75/25 one. Three independent mechanics keep those safe:

1. **Scope** — the commission attributes are never in the request body, and the filter lives inside `buildProjectAttributes`, so a caller cannot forget it.
2. **Merge** — a partial `Attributes` PUT leaves what it did not send alone (D24, proved by hand).
3. **Omit-blanks** — a field with no value is left out entirely rather than sent as `""`, so even an empty legacy record cannot blank anything.

Any one would be sufficient. Together, this path is incapable of disturbing a figure a person typed in.

`JOBTYPE` is excluded for a different reason: RS vs RSDC is authoritative at Layer-1 project creation, and nothing here can do better than infer it. Saying nothing lets the merge preserve what created the project.

##### Verification is mandatory

Acumatica returns **200 and silently discards** an `AttributeID` the project's template does not define (D-060). The write is therefore always followed by a fresh re-read, comparing dates by date part (`2026-07-14` comes back as `2026-07-14 00:00:00.000`). An attribute that was accepted and dropped is reported as `missing`.

##### Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ ok: true, action: "synced" \| "nothing_to_write", written, omitted }` | Confirmed by re-read. `nothing_to_write` means the record had no populated values. |
| `400` | `INVALID_RECORD_ID` | Path parameter is not a Salesforce id. |
| `401` / `403` | `AUTH_*`, `NO_TENANT`, `NO_SUNDIAL_USER` | Standard identity mapping. |
| `404` | `RECORD_NOT_FOUND` | Missing or not owned by the tenant — deliberately indistinguishable. |
| `409` | `NO_ACUMATICA_PROJECT` | The one gate. Nothing is written, including the sync fields: a record never linked to Acumatica has not had a *failed* sync. |
| `502` | `{ ok: false, action: "unverified" \| "write_failed" \| ..., missing, mismatched }` | The write failed or could not be confirmed. |

##### Direct invoke

```json
{ "attributesSync": true, "recordId": "a0X...", "tenantId": "harmon" }
```

`tenantId` is optional and scopes the read when present. No token is involved, so this is an operator/back-office entry point at the same trust level as the `reconcile` and `dryRunWrite` payloads on the same function.

##### Salesforce write-back

`Attribute_Sync_Status__c`, `Attribute_Sync_Error__c` and `Attribute_Synced_At__c` (`salesforce/v5-attribute-sync-fields/`). **The budget push worker's Stage E writes the same three fields from the same mapping function**, so the two paths cannot describe the same outcome differently.

---

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
- `PORTAL_BASE_URL` is a Lambda env var, set to `https://sundial.harmonelectric.net` (the in-code default matches). Point it at the client's real domain per tenant — a config change, no redeploy of code required.
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

#### `POST /webhooks/retell`

**Lambda:** `sundial-welcome-call`
**Purpose:** Retell AI's call lifecycle webhook for the automated **Welcome Call** (the post-sale contract-verification call). Forwards every analyzed call to the Zapier billing ledger, then writes the verification result back to `Sundial_Customer__c`. Full runbook: `docs/integrations/retell-welcome-call.md`. Design rationale: **D-054**.

> **This is the only HTTP route the Welcome Call feature adds.** There is no portal UI and no portal-authenticated endpoint. The call-placing side is invoked by EventBridge from a Salesforce platform event, not over HTTP.

**Authentication:** `X-Retell-Signature` — HMAC-SHA256 of the **raw request body**, keyed with `RETELL_WEBHOOK_SECRET`, hex-encoded (Retell sends `v=<hex>`; a bare hex value is also accepted). Constant-time compared in-Lambda. **No Supabase JWT and no API Gateway authorizer** — the caller is a machine with no portal user. An **unset secret fails closed (401)**, never open.

**Request body:** Retell's lifecycle payload, `{ event, call: { … } }`.

| `event` | Behavior |
|---|---|
| `call_started`, `call_ended` | Acked and ignored — 200, no ledger row, no Salesforce write |
| `call_analyzed` | Fully processed (below) |
| anything else | Acked (200) so Retell stops retrying |

**`call_analyzed` order of operations** — the order is the design:
1. **Forward the full raw payload to `ZAPIER_RESULTS_HOOK_URL` FIRST**, before Salesforce is touched (3 attempts, 500 ms → 2 s backoff). That Zap is the billing ledger and records *every* analyzed call, including rep-initiated calls this Lambda never placed. On final failure the payload is logged at ERROR for manual replay and **processing continues** — a forward failure never blocks the writeback.
2. If `call.metadata.sf_record_id` is **absent** (rep-form call, possibly no Salesforce record yet), the forward was the whole job → 200, Salesforce is never queried. *Exception to the ordering above:* the recording is parked **before** the forward here, so its key can be added to the forwarded payload as `s3_recording_key`.
3. Otherwise: **archive the recording** (below), map `call_analysis.custom_analysis_data.verification_result` to `Welcome_Call_Status__c`, append a log line carrying the archived key, then Salesforce → cache → Realtime.

**Recording archival.** `call.recording_url` is downloaded server-side (https only, no credentials attached, 20 s / 50 MB caps) and written to the `sfsolproj` bucket — which puts it on the record's portal Files tab, in XFiles Pro, and in the Dropbox mirror with no further work.

| Case | S3 key | Supabase metadata |
|---|---|---|
| `sf_record_id` present | `SUNDIAL/{sf_record_id}/welcome-call-{YYYY-MM-DD}-attempt-{n}.mp3` | row, category `Welcome Call Recording`, uploader `Wattson (system)` |
| absent (rep-form orphan) | `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3` | **none** — no record to attach to |
| no `recording_url` | — skipped silently (the call never connected) | — |

Date is **America/Phoenix**; `attempt_no` comes from `call.metadata` and falls back to the literal `x`. **The whole step is non-fatal**: any failure logs at ERROR with the `call_id` and the (still-live) `recording_url` for manual retrieval, and the Salesforce writeback proceeds regardless. Keys are deterministic, so a redelivery overwrites in place, and the metadata insert is skipped when a row for that key already exists.

**Idempotency:** a `Welcome_Call_Log__c` line carrying both this `call_id` and the `Result:` marker means the call was already recorded → ack and skip. (Retell may redeliver. The Zapier forward is *not* suppressed on a duplicate, so **dedupe on `call_id` in the Zap**.)

**Responses:**
| Code | When |
|---|---|
| 200 | processed, duplicate, ack-only event, no `sf_record_id`, record deleted |
| 401 | missing/invalid signature, or `RETELL_WEBHOOK_SECRET` not configured |
| **500** | **Salesforce writeback failed — deliberate**, so Retell retries; the ledger already has the call and the idempotency guard makes redelivery safe |

**Wiring (both Welcome Call routes):** `scripts/wire-welcome-call-routes.ps1`.

#### `POST /welcome-call/orphan-match`

**Lambda:** `sundial-welcome-call`
**Purpose:** Promote a parked rep-form recording onto the customer record, once the Zapier orphan sweep has worked out who the call belonged to.

**Authentication:** `X-Sundial-Zap-Secret` compared constant-time against `ZAP_ORPHAN_MATCH_SECRET`. **Not a portal JWT** — the caller is a Zap. An unset secret fails closed (401).

**Request body:** `{ "call_id": "call_abc123", "sf_record_id": "a1P7y00000AUo6TEAT" }`

**Behavior:** verifies `SUNDIAL/_orphan-welcome-calls/{call_id}.mp3` exists → copies it to `SUNDIAL/{sf_record_id}/welcome-call-{YYYY-MM-DD}-{call_id}.mp3` (**date from the holding object's `LastModified`**, Phoenix time — the sweep may run days after the call, and the file should be named for the conversation, not the sweep) → registers Supabase metadata → prepends `rep-form call {call_id} matched, recording attached` to `Welcome_Call_Log__c` (then cache + Realtime) → deletes the holding object **last**.

**Idempotent, and it has to work backwards.** The operation ends by deleting its own input, so a retry cannot re-derive the destination key (that key embeds the holding object's `LastModified`). Instead the retry **searches** `SUNDIAL/{sf_record_id}/` for `welcome-call-*-{call_id}.mp3` and returns `already_matched: true`. It also re-attempts the metadata row and the log line, skipping each if already present — so a partially-failed run converges rather than silently losing the note.

**Response (200):**
```json
{ "already_matched": false, "key": "SUNDIAL/a1P.../welcome-call-2026-08-15-call_abc123.mp3",
  "recordId": "a1P...", "callId": "call_abc123", "sizeBytes": 184320,
  "metadata": "registered", "log": "appended", "holdingDeleted": true }
```

**Errors:** 400 (`MISSING_FIELDS`, `INVALID_RECORD_ID`, `INVALID_CALL_ID`, `INVALID_BODY`), 401 (missing/invalid secret, or none configured), 404 (`RECORD_NOT_FOUND`; `RECORDING_NOT_FOUND` when neither a holding object nor an already-matched file exists).

A failed holding-object delete is **not** a failed match — the bytes are attached and registered, so the call returns 200 with `holdingDeleted: false` and a later retry cleans up.

**IAM:** `sfsolproj` `ListBucket` plus `GetObject`/`PutObject`/`DeleteObject` on `sfsolproj/SUNDIAL/*`. The execution role carries `AmazonS3FullAccess` today (verified 2026-08-03 for copy-to-solar), so no IAM change is expected — but `DeleteObject` is new for this feature, so confirm it if the role is ever tightened.

#### `POST /webhooks/comment-mention`

**Lambda:** `sundial-comment-notify`
**Purpose:** Sends the "you were @-mentioned in a comment" email. Full runbook: `docs/integrations/comment-mention-alerts.md`. Design rationale: **D-056**.

> **The caller is POSTGRES, not a browser.** Comments are written directly from the browser under RLS — there is no server in that path — so the notification is driven by an `AFTER INSERT` trigger on `comment_mentions` posting through `pg_net` (`sql/sundial_comment_mention_notify.sql`). A client-driven alert would be lost whenever the commenter closed their tab, and the person who loses it is not the person who caused it.

**Authentication:** shared secret in the `X-Sundial-Comment-Secret` header, constant-time compared in-Lambda against `COMMENT_NOTIFY_SECRET`. **No Supabase JWT and no API Gateway authorizer** — the caller has no portal user. **An unset secret rejects everything with 401** (fails closed). This is the **third** public non-JWT route, after the Aurora doorbell and the Retell webhook.

**Request body:** `{ "mention_id": "<uuid>", "comment_id": "<uuid>", "mentioned_user_id": "<auth uuid>" }`. `mention_id` alone is enough; `comment_id` + `mentioned_user_id` is accepted as a replay fallback.

**Behavior:** read the mention → read the comment → check preferences → resolve the recipient's address from `auth.users` (service role) → send via `lib/email.js` → stamp `comment_mentions.notified_at`.

**Every skip is a success (200), never an error:**

| `reason` | When |
|---|---|
| `already_notified` | `notified_at` is already set (pg_net can redeliver) |
| `self_mention` | The recipient is the comment's author |
| `alerts_disabled` | `user_preferences.comment_email_alerts = false` |
| `no_recipient_email` | The auth user has no address |
| `email_not_configured` | `EMAIL_FROM` unset — degrades like the Design Request email, so this ships before SES |
| `cross_tenant` | Comment tenant ≠ recipient tenant (defence in depth; should never fire) |

**A missing `user_preferences` row means alerts are ON.** There is no backfill — every existing user has no row, and nobody should have to opt in to keep today's behaviour.

**Idempotency:** `notified_at` is stamped **only after a successful send**. Nothing stamps it on a skip, so a recipient who re-enables alerts — or an SES that comes online later — is still reachable by a replay.

**Errors:** 400 (`MISSING_FIELDS`, `INVALID_BODY`), 401 (missing/invalid secret, or none configured), 404 (`MENTION_NOT_FOUND`, `COMMENT_NOT_FOUND`), 502 (send failed, database read failed, auth lookup failed). A send that succeeded but whose stamp failed returns **200** with `stamped: false` — the email went out, and reporting failure would invite a duplicate.

**Link map** (`${PORTAL_BASE_URL}` + path, from `comments.record_object`): `customer` → `/customers/{id}`, `solar` → `/projects/solar/{id}`, `roofing` → `/projects/roofing/{id}`. **An unknown key falls back to `/dashboard` and logs a warning** — never emit a link that 404s. The Service module gets one entry in `RECORD_PATHS` when it lands.

**Wiring:** `scripts/wire-comment-mention-route.ps1`. **Wire and verify this route before applying the trigger migration** — the trigger swallows post failures by design, so an unwired route loses notifications silently.

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
| `sundial-acumatica-budget-push` | POST /projects/{recordId}/budget/push, POST /projects/{recordId}/budget/attributes-sync |
| `sundial-user-admin` | GET /admin/users, POST /admin/users, PATCH /admin/users/{id} |
| `sundial-aurora-push` | POST /customers/{recordId}/design-request/submit |
| `sundial-service-estimate` | GET /service/jobs/{id}/activity, GET /service/estimates/{id}/{activity\|preview}, POST /service/estimates, GET+PATCH /service/estimates/{id}, POST /service/estimates/{id}/lines, PATCH+DELETE /service/estimates/{id}/lines/{lineId}, POST /service/estimates/{id}/{add-template\|recalculate\|send\|approve\|decline\|create-job}, POST /service/jobs, POST /service/price-book-items, PATCH /service/price-book-items/{id}, POST /service/price-book-items/{id}/{new-version\|deactivate}, POST /service/invoices/{id}/charge, POST /webhooks/stripe/{tenant} (Stripe's signature is the gate) |
| `sundial-service-board` | GET /service/board, GET+POST /service/jobs/{id}/calls, PATCH /service/calls/{id}, POST /service/calls/{id}/cancel, GET+POST /service/calls/{id}/clock; **the tech app:** GET /service/tech/day, GET /service/tech/price-book, GET /service/tech/calls/{id}, POST …/status, …/notes, …/checklist, …/photos, …/photos/confirm, GET …/photos |
| `sundial-service-public` | GET /public/estimates/{token}, POST /public/estimates/{token}/{accept\|decline\|checkout} (no auth — the token is the credential) |
| `sundial-sms` | GET+POST /service/jobs/{id}/sms, GET /service/sms/unmatched, POST /sms/inbound + POST /sms/status (Twilio-signed, no JWT) |
| `sundial-aurora-webhook` | GET /webhooks/aurora/agreement-status (doorbell → SQS) |
| `sundial-welcome-call` | POST /webhooks/retell, POST /welcome-call/orphan-match (**also** EventBridge — see below) |
| `sundial-comment-notify` | POST /webhooks/comment-mention (called by Postgres via pg_net) |
| `sundial-acumatica-webhook` | POST /webhooks/acumatica |

Lambda functions not exposed through API Gateway:

| Lambda | Trigger | Purpose |
|---|---|---|
| `sundial-aurora-inbound` | SQS (`sundial-aurora-inbound`, DLQ after 5) | Processes Aurora agreement-status events: retrievals, `Sundial_Customer__c` write-back, signed PDF to S3, design-manager email, dealer-origination auto-create (D-048/D-049) |
| `sundial-acumatica-push` | SQS (sundial-acumatica-outbound) | Outbound calls to Acumatica with rate-limit handling |
| `sundial-dropbox-sync` | S3 PUT events on `constructive-sundial-files` | Mirrors uploaded files to Harmon's Dropbox |
| `sundial-cache-invalidator` | Salesforce Platform Events (Phase 2+) | Propagates out-of-band Salesforce changes to the cache |

> `sundial-welcome-call` appears in **both** tables on purpose: one Lambda, two entry points, told apart by the shape of the event. An HTTP event carries `requestContext.http.method`/`httpMethod`; the EventBridge relay of `Sundial_Welcome_Call_Request__e` (field `Customer_Id__c`) does not. The platform-event path reads the customer **fresh from Salesforce** — never the cache — because the values are read aloud to the customer on a recorded call. The EventBridge rule and the Salesforce Event Relay are configured by hand, not in code; the expected rule shape is in `docs/integrations/retell-welcome-call.md`.

---

## Lambda Environment Variables

Config that must not live in code (addresses, domains, regions) is set per-Lambda as an environment variable. Secrets stay in Secrets Manager — **never** put credentials here.

| Variable | Lambda(s) | Required | Purpose |
|---|---|---|---|
| `SERVICE_PUBLIC_BASE_URL` | `sundial-service-estimate` | **Yes** (for the customer link) | The portal's public origin, e.g. `https://harmon.sundialcrm.com` (no trailing slash). `/send` builds the customer link as `{base}/estimate/{token}`. If unset, `/send` still records the version and returns `delivery: "recorded"` with `deliveryDetail` naming this variable — nothing is emailed because there is no link to email. **Per-tenant:** each fork's Vercel origin. |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` / `SES_REGION` / `EMAIL_CONFIG_SET` | `sundial-service-estimate` (in addition to the senders below) | `EMAIL_FROM` yes to send | Same values as the other senders — the estimate email goes through `lib/email.js`. The execution role already carries SES access (see the SES notes). |
| *(secret, not a variable)* `sundial/twilio` | `sundial-sms` | Yes to text | Secrets Manager JSON `{ "accountSid", "authToken", "fromNumber", "tenantNumbers"?: { "<slug>": "+1…" }, "defaultTenant"?: "<slug>" }`. The account is Constructive Ops'; the number a tenant texts from is `tenantNumbers[slug]`, else the shared `fromNumber`; an inbound text routes to the tenant whose number it hit, else `defaultTenant`. Re-read every 5 minutes — swapping Harmon onto its own approved number is a secret edit, not a deploy. |
| `SMS_WEBHOOK_BASE` | `sundial-sms` | Yes for webhooks | The public base Twilio calls, e.g. `https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod`. Twilio's signature covers the EXACT URL, so this must match the Twilio console character for character; it is also the base of the per-message status callback. |
| `SMS_DEFAULT_TENANT` | `sundial-sms` | No | Overrides the secret's `defaultTenant` (a slug, e.g. `harmon`). |
| *(secret, not a variable)* `sundial/google-maps` | `sundial-service-estimate`, `sundial-service-board` | No (Street View card says "not set up" until it exists; the tech app's geofence stays "unverified") | Secrets Manager JSON `{ "apiKey": "…" }` — a Google Cloud API key with the **Street View Static API** and (since amendment 7) the **Geocoding API** enabled, restricted to those two. Read by `GET /service/jobs/{id}/street-view` and by the tech app's clock-in (one geocode per job, written to `Geocode_Lat/Lon/Status__c`); the execution role needs `secretsmanager:GetSecretValue` on it (the role's existing `sundial/*` grant covers it if that is how the other secrets are granted). |
| `SERVICE_GEOFENCE_METERS` | `sundial-service-board` | No (defaults `250`) | The tech app's geofence radius: a clock-in within this many metres of the job's geocode (or the shop) sets `Geofence_Verified__c`. A tag, never a gate. |
| `SERVICE_SHOP_LATLNG` | `sundial-service-board` | No | `"33.45,-112.07"` — the shop's coordinates. A clock-in at the shop counts as verified (office work, prep, pickups). |
| `SERVICE_TIMEZONE` | `sundial-service-board` | No (defaults `America/Phoenix`) | The timezone appointment windows are written in for customer emails ("Monday, September 14, 9:00 AM – 11:00 AM"). Per-tenant. |
| `SERVICE_BRAND_NAME` | `sundial-service-public`, `sundial-service-board` | No | Company name printed at the top of the hosted estimate document (the `brand.companyName` slot). Until Harmon's identity block is captured, set it to `Harmon Electric`; the rest of the brand block (license line, contact, terms link, footer) is the next config step. |
| `DESIGN_REQUEST_NOTIFY_TO` | `sundial-aurora-push`, `sundial-aurora-inbound` | **Yes** (for the email step) | The design manager who receives the Design Request notification **and** the signed-agreement / cancellation notifications. Accepts a comma- or semicolon-separated list. If unset, the work still succeeds and the result reports `no_recipient_configured`. |
| `DESIGN_REQUEST_NOTIFY_CC` | `sundial-aurora-push`, `sundial-aurora-inbound` | No | The director (or anyone else) CC'd on those notifications. Same list format. When unset, **no Cc header is sent at all**. |
| `AURORA_INBOUND_QUEUE_URL` | `sundial-aurora-webhook` | **Yes** | The SQS queue the Aurora doorbell enqueues to. If unset the doorbell returns **500 on purpose** so Aurora retries rather than the event being acked into a void. |
| `SUNDIAL_TENANT_SLUG` | `sundial-aurora-inbound` | No (defaults `harmon`) | Tenant slug resolved to the `Sundial_Tenant__c` record id for `Client__c` on auto-created dealer customers (D-049). Same identity as `VITE_TENANT_ID` and the S3 prefix. |
| `EMAIL_FROM` | any sender (`sundial-aurora-push`, `sundial-aurora-inbound`, `sundial-comment-notify`) | Yes to send | **Set to `Sundial <no-reply@sundialcrm.com>`** (2026-08-19). The verified identity is the **domain** `sundialcrm.com`. Until it is set, `lib/email.js` reports "not configured" and senders skip the email instead of failing — which is exactly how Design Request notifications degraded silently for weeks. |
| `EMAIL_REPLY_TO` | any sender | No, but **effectively required** | **Set to `tim@constructiveoperations.com`.** No mailbox exists behind `no-reply@sundialcrm.com`, so without this a recipient who hits Reply gets a bounce. **Per-tenant:** the From is correctly tenant-neutral, the reply target is not — a second tenant must point this at their own monitored address. |
| `SES_REGION` | any sender | No (defaults `us-west-1`) | **Set explicitly to `us-west-1`**, which is where `sundialcrm.com` is verified. Matches the in-code default; set anyway so the config is self-describing. |
| `EMAIL_CONFIG_SET` | any sender | No | **Set to `sundial-transactional`.** SES configuration set publishing BOUNCE / COMPLAINT / DELIVERY / REJECT to CloudWatch under the `configuration-set` dimension. These emails reach real Harmon employees on a domain that **also carries auth email**, so a bounce/complaint problem here is a reputation risk to the login flow, not just to notifications. |
| `PORTAL_BASE_URL` | `sundial-user-admin`, `sundial-comment-notify` | No | Base URL for invite links and @-mention deep links. Set to `https://sundial.harmonelectric.net` (D-053); the in-code default matches in **both** Lambdas, so a lost env var degrades to the working domain. Point at the client's real domain per tenant. |
| `RETELL_FROM_NUMBER` | `sundial-welcome-call` | **Yes** (to place calls) | The Retell-owned E.164 number the Welcome Call dials from. |
| `RETELL_AGENT_ID` | `sundial-welcome-call` | **Yes** (to place calls) | `override_agent_id` for the Welcome Call agent. |
| `ZAPIER_RESULTS_HOOK_URL` | `sundial-welcome-call` | **Yes** (for the billing ledger) | Catch Hook of the billing-ledger Zap. Unset means analyzed calls are logged at ERROR instead of billed; the Salesforce writeback still runs. |
| `RETELL_API_KEY` | `sundial-welcome-call` | Credential | **Prefer the `sundial/retell/api` secret** — the secret wins over this env var so the key can be rotated without a redeploy. Accepted here as a fallback. |
| `RETELL_WEBHOOK_SECRET` | `sundial-welcome-call` | Credential | Same: secret-first, env fallback. If neither is set the webhook **rejects everything with 401** (fails closed). |
| `ZAP_ORPHAN_MATCH_SECRET` | `sundial-welcome-call` | Credential | Shared secret for `POST /welcome-call/orphan-match` (`X-Sundial-Zap-Secret`). Secret-first, env fallback; fails closed when unset. |
| `ACCESS_MODEL_MODE` | `sundial-sf-query` | No (defaults `off`) | The D-064 access-model rollout switch: `off` \| `shadow` \| `enforce`. **`off` (unset) is the code path as it was before Phase 2** — no computation, no extra query, no log line. `shadow` computes the new access decision on every read and emits one structured JSON line per request (`{"shadow":true,…}`, read by `scripts/access-shadow-summary.mjs`) while **serving the old answer unchanged**. `enforce` is recognized but not implemented until Phase 3: it warns and behaves as `shadow`, so an early flip degrades to "measure" rather than crashing the function or silently meaning `off`. An **unrecognized** value warns and falls back to `off`. Rollback from shadow is an env change with no redeploy. |
| `COMMENT_NOTIFY_SECRET` | `sundial-comment-notify` | Credential | Shared secret for `POST /webhooks/comment-mention` (`X-Sundial-Comment-Secret`). **Prefer the `sundial/comment-notify` secret** — it wins over this env var so it can rotate without a redeploy. The same value must be stored **in the Supabase database as the `comment_notify_secret` row of `private.app_config`** (NOT a database setting — `alter database … set` is not permitted on managed Supabase; see `docs/integrations/comment-mention-alerts.md`). Fails closed when unset. |

Setting them (⚠️ `update-function-configuration` **replaces** the whole Variables map —
read the current map, merge, and send the complete result in one command):

```powershell
# 1. ALWAYS read what's there first.
aws lambda get-function-configuration --function-name sundial-aurora-push `
  --region us-west-1 --query 'Environment.Variables'

# 2. Merge and apply. Prefer a JSON file over the Variables={...} shorthand: EMAIL_FROM
#    contains spaces and angle brackets, and the shorthand treats , and = as delimiters.
#    (env.json = { "Variables": { "EMAIL_FROM": "...", ... } }, no BOM)
aws lambda update-function-configuration --function-name sundial-aurora-push `
  --region us-west-1 --environment file://env.json --query 'Environment.Variables'

# 3. Re-read and diff against what you intended. A dropped var does not announce
#    itself: losing COMMENT_NOTIFY_SECRET fails the webhook closed, and losing
#    SUNDIAL_TENANT_SLUG silently mis-tenants auto-created customers.
aws lambda get-function-configuration --function-name sundial-aurora-push `
  --region us-west-1 --query 'Environment.Variables'
```

The sending Lambda's execution role also needs `ses:SendEmail`. On Harmon's
`sundial-lambda-execution-role` this comes from the managed **`AmazonSESFullAccess`**;
see `docs/integrations/ses-transactional-email.md` for the scoped alternative and why
it was not applied.

---

## Deployment

API Gateway deployment is manual via the AWS Console (Actions → Deploy API → stage `prod`). When Phase 1 begins, this should be moved to an infrastructure-as-code workflow (Terraform, CDK, or SAM) so changes can be reviewed in pull requests and rolled back if needed.

Until then: any route changes in the Console must be deployed via Actions → Deploy API before they take effect at the prod URL.

---

## Admin routes — dealers (D-064)

### `GET /admin/dealers`

Active `Sundial_Dealer__c` records in the caller's tenant, for the Dealer dropdown on
the user form. **Super-admin gated**, like every route on `sundial-user-admin`.

```json
{ "dealers": [ { "id": "a1X7y00001ASRILEA5", "name": "ZZ TEST DEALER A" } ] }
```

Active only: offering an inactive dealer would let an admin create a user who
authenticates and then sees nothing (§2.1).

⚠️ **Deliberately NOT in `sundial-sf-query`'s `OBJECT_ALLOWLIST`.** That allowlist is
the read surface every portal user reaches; dealers are an admin lookup, and adding them
there would expose the tenant's dealer roster to every authenticated caller for the sake
of one dropdown.

⚠️ **The same list is also returned by `GET /admin/users`** as a `dealers` key, from the
same server function. That exists because a new API Gateway route is a manual step
(`scripts/wire-admin-dealers-route.ps1`) and dealer onboarding could not wait for it.
The two cannot diverge — one function, two callers.

### `POST /admin/users` / `PATCH /admin/users/{id}` — `dealerId`

**Required** when `accessLevel` is `Sales Rep` or `Sales Dealer`; **refused** for
tenant-wide levels.

| Code | Status | When |
|---|---|---|
| `DEALER_REQUIRED_FOR_SALES_ROLE` | 400 | a sales role would end up with no dealer |
| `DEALER_NOT_FOUND` | 400 | unknown id, another tenant's dealer, an INACTIVE dealer, or a value that is not a Salesforce id — all indistinguishable on purpose |
| `DEALER_NOT_APPLICABLE` | 400 | `dealerId` sent for a tenant-wide level |

On PATCH the rule is evaluated against the state the request **results in**, not against
the body: a PATCH setting only `accessLevel: "Sales Rep"` is refused if the record has
no dealer, and allowed if it already has one. Moving OUT of a sales role leaves
`Dealer__c` untouched.

`GET /admin/users` returns `dealerId` and `dealerName` per user.

---

## Access enforcement — response codes (D-064)

Under `ACCESS_MODEL_MODE=enforce`, every read and write endpoint answers to
`lib/access.js`. The status codes are not interchangeable:

| Situation | Code | Why |
|---|---|---|
| A module closed to this scope, on a **list/search/create** | **403** `MODULE_FORBIDDEN` | Names a module, not a record. Leaks nothing about what exists |
| A record outside the row filter, on a **single read** | **404** `RECORD_NOT_FOUND` | A record you may not see must be indistinguishable from one that does not exist. A 403 on a record id **confirms the record exists** and turns any detail endpoint into an enumeration oracle |
| A field the role may not write, on a PATCH/POST | **403** `FIELD_FORBIDDEN` | Names the field, and **rejects the whole request** — writing the rest would leave the caller believing it all landed |
| An action the role may not perform | **403** `ACTION_FORBIDDEN` | A capability, not a record |
| A picklist for a field the role may not read | **404** `FIELD_NOT_FOUND` | Same oracle reasoning as a record |

⚠️ One deliberate exception: on the **record-addressed file routes**, a `none`-scope
caller gets **403**, not 404. They are refused by the action gate before any record is
considered, and get the same answer for every id — so there is no oracle, and 403 is the
honest answer. A **sales** role still 404s there, because their refusal DOES depend on
which record was asked for.

---

## Service module — estimates, jobs, price book (D-072) — `sundial-service-estimate`

The WRITE side of the service data model (`docs/service-data-model.md`). Reads (lists,
search, single records) stay on `GET /sf/{estimate|job|servicecall|pricebookitem|serviceline|serviceinvoice|servicepayment}`
via `sundial-sf-query`. Every route below: Supabase bearer auth, tenant from the token,
**tenant scope only** (`service.*` action keys in `lib/access.js`; sales and none scopes
get **403 `ACTION_FORBIDDEN`** before any Salesforce call). Record ids outside the
caller's tenant are **404** everywhere. Every write recomputes and stores the estimate's
totals (`totals.js` — kind subtotals → scoped discount → hidden markup → tax → total →
deposit) and marks the affected cache rows stale.

### The customer block (New Estimate / New Job popup)

Both `POST /service/estimates` and `POST /service/jobs` take:

```json
"customer": { "id": "a1P…" }
"customer": { "new": { "firstName","lastName","street","city","state","postalCode","email","phone" }, "confirmNew": false }
```

- `id` → the customer is loaded tenant-scoped and `Requested_Project_Types__c` gets
  `Service` **union-added** (skipped silently if already present).
- `new` → name + (email or phone) required. A **soft duplicate sweep** (exact email, 10-digit
  phone, zip + house number + street token) returns **409 `DUPLICATE_CANDIDATES`** with
  `candidates:[{id,name,email,phone,address,reasons}]`; resend with `confirmNew: true` to
  create anyway. The new customer gets `Requested_Project_Types__c = Service`, `State__c`
  matched against the picklist (value or label; blank + warning if no match), `Client__c`
  from the token. If the tag value is missing from the org's picklist the create still
  succeeds and `warnings[]` says so.
- Responses carry `customerId`, `customerCreated`, `warnings[]`. If the estimate/job
  create fails AFTER a customer was created, the 502 body carries `customerCreated: true`
  and the id — never a silent orphan.

### `POST /service/estimates` → 201

Body: `customer` (above) — or `isTemplate: true` and no customer; `estimate: { discountScope, discountType, discountValue, discountSource, markupType, markupValue, taxRate, taxJurisdiction, depositRequired, depositType, depositValue, scopeSummary, validUntil, soldById, templateName, originatingSolarId, originatingRoofingId, originatingCommercialId }` (all optional); `lines: [ { priceBookItemId, quantity?, unitPrice?, description? } | { description, kind, unitPrice, quantity?, taxable? } ]`; `templateId` (clone a template's lines, re-snapshotted from each item's **active** version). Response: `{ id, customerId, customerCreated, linesCreated, lineProblems[], totals{…__c}, rejectedFields[], warnings[] }`.

### `GET /service/estimates/{id}` → `{ estimate, lines[], totals }` (live totals, computed on read).

### `PATCH /service/estimates/{id}` — the `estimate:{}` keys above at top level. 409 `ESTIMATE_INVOICED` once billed. Unknown keys are reported in `rejectedFields`, not written.

### Lines
- `POST /service/estimates/{id}/lines` — one line object, or `{ lines: [...] }`. Catalog lines snapshot description / unit price / labor+material split / costs / taxable from the item and set `Price_Overridden__c` when `unitPrice` differs. Only the **active** version of an item can be added (`lineProblems` names the rest). → 201 `{ ids[], problems[], totals }`.
- `PATCH /service/estimates/{id}/lines/{lineId}` — `description, quantity, unitPrice, stage (Proposed|Approved|Completed|Removed), sortOrder, showUnitPrice, taxable, kind`, and **`priceBookItemId`** — link the line to an ACTIVE catalog item ("save this ad-hoc line to the price book": the portal creates the item, then links the line). Linking sets `Price_Book_Item__c`, `Source__c = Price Book`, snapshots the item's labor/material price + cost split, unit and taxability, keeps the line's description / quantity / unit price, and recomputes `Price_Overridden__c` against the item; `400 ITEM_NOT_FOUND` / `ITEM_NOT_ACTIVE` otherwise. Response carries `priceBookItemId`. **Lines are editable after they are added** — the line is the office's snapshot of the item. A price edit on a catalog line flips `Price_Overridden__c`. A money-affecting edit (price / quantity / kind / taxable) to an **Approved** line drops it to `Proposed` and the response carries `needsReapproval: true`; a no-op patch returns `unchanged: true`.
- `DELETE /service/estimates/{id}/lines/{lineId}` — real delete (sent versions survive in `Version_Log__c`).
- `POST /service/estimates/{id}/add-template` `{ templateId }` → 201 `{ ids[], totals }`.
- `POST /service/estimates/{id}/recalculate` — recompute from lines (the reconcile hook).

### Lifecycle
- `POST /service/estimates/{id}/send` `{ via?: Email|SMS|Both|Manual, validDays?, to? }` → `Version__c + 1`, one entry appended to `Version_Log__c` (`{version, sentAt, sentBy, sentVia, total, lines[], pdfKey:null}`), `Status__c = Sent`, `Public_Token__c` (issued once, reused), `Public_Token_Expires_At__c`, `Valid_Until__c` (send + tenant validity days — **default 30 until Harmon confirms**). **Then it delivers (2026-09-11):** the customer link is `SERVICE_PUBLIC_BASE_URL` + `/estimate/{token}` and, for `via` Email/Both, it is emailed through `lib/email.js` (SES) to `to` → the customer's `Primary_Email__c` → the estimate's email snapshot, in that order. Response `{ version, total, publicToken, publicUrl, validUntil, delivery, recipient, deliveryDetail, pdfKey, pdfUrl }` where `delivery` is `"email"` (SES accepted it for `recipient`) or `"recorded"` (version + link exist, nothing went out — `deliveryDetail` says why: base URL unset, `EMAIL_FROM` unset, no customer email, SES error, or SMS not live). The activity row carries the same fields. A delivery failure is **never** a failed request — the version is on the record either way and the office sends the link by hand. **The PDF (D-072 amendment 3):** every send renders this version to `SUNDIAL/{estimateId}/estimate-v{n}.pdf` (pdf-lib, from the same document model as the page), registers a `sundial_file_metadata` row (category `Estimate`), stores the key in `Version_Log__c[].pdfKey`, attaches it to the email, and returns `pdfKey` / `pdfUrl`. A PDF failure never blocks the send: `pdfKey: null`, the email goes without the attachment, `deliveryDetail` says so. **SMS waits for Twilio.**
- `POST /service/estimates/{id}/approve` `{ method?: Online|Verbal|Signed|Deposit Paid, name? }` → `Status Approved`, `Approved_Version/Amount/At/Method/By`, every `Proposed` line → `Approved`.
- `POST /service/estimates/{id}/decline` `{ reason? }`.
- `POST /service/estimates/{id}/create-job` `{ job: {…} }` → 201 `{ jobId, estimateId }`; 409 `ESTIMATE_HAS_JOB` if already converted. Job `Intake_Channel__c` defaults to `Estimate Conversion`.

### `POST /service/jobs` (quick-create) → 201
Body: `customer` (above) **or** `estimateId` (then it behaves as create-job); `job: { issueDescription, priority, serviceType, systemOwnership, intakeChannel, intakeDate, assignedToId, billToType, billToName, billingReference, originatingSolarId, originatingRoofingId, originatingCommercialId }`; plus `estimate`, `lines`, `templateId` as on estimate create. Creates the estimate, then the job (`Estimate__c` required), then links `Service_Job__c` back. If the job create fails the estimate is deleted (compensation) and the 502 reports `estimateRemoved`. Response `{ jobId, estimateId, customerId, customerCreated, linesCreated, totals, warnings }`.

### Price book
- `POST /service/price-book-items` `{ name, itemCode, kind: Labor|Material|Product|Fee, jobType?, serviceType?, category?, description?, internalNotes?, unitOfMeasure?, defaultQuantity?, estimatedHours?, laborCost?, materialCost?, laborPrice?, materialPrice?, taxable? }` → 201 version 1. **Filter fields (2026-09-15):** `jobType` (Solar | Electrical | EV | Commercial), `serviceType` (Installation | Repair | Maintenance | Inspection) and `category` (open list — the picklists are unrestricted, so a new value typed in the portal simply exists) are the three narrowing dropdowns on the Price Book list; the HCP import (`salesforce/pricebook-import/`) fills them from the export's categories and keeps the HCP uuid in `HCP_Id__c` (the DataLoader upsert key). `itemCode` is upper-cased, spaces → `-`. 409 `ITEM_CODE_IN_USE` if an active version of that code exists.
- `PATCH /service/price-book-items/{id}` — in-place edit, **only while no line references the version**; otherwise 409 `ITEM_IN_USE` (`referencingLines`). `itemCode` is never changed here.
- `POST /service/price-book-items/{id}/new-version` `{ …edits }` — the **Update** button: clones with `Version__c + 1`, `Is_Active__c true`; the old version gets `Is_Active__c false` + `Superseded_By__c`. 409 `ITEM_NOT_ACTIVE` if called on a superseded version.
- `POST /service/price-book-items/{id}/deactivate` — removes from the active list without a successor. **There is no delete**, by design.

### Activity tracker (D-072 amendment 2)
Every route above writes one row to `sundial_service_activity` after its Salesforce write (event, actor, timestamp, `details` with old → new). `sundial-sf-update` does the same for a generic `PATCH/POST /sf/{estimate|job|servicecall|serviceline|serviceinvoice|servicepayment|pricebookitem}` (`field_updated` / `record_created`, with the previous values read before the write).
- `GET /service/jobs/{id}/activity?limit=200&before=<iso>` → `{ jobId, estimateId, activity: [ { id, event, record_type, record_sf_id, job_sf_id, estimate_sf_id, actor_user_sf_id, actor_name, details, at } ] }`, newest first. Includes the estimate's pre-job rows (re-keyed at Create Job).
- `GET /service/estimates/{id}/activity` — same shape for one estimate.

### Preview (read-only document)
`GET /service/estimates/{id}/preview` → `{ html, title, version }`. The customer-facing estimate rendered by `lib/estimate-document.js` — the SAME renderer the hosted customer page, the PDF, and the email will use, so the office's preview is exactly what the customer gets. Self-contained HTML (inline CSS, no external assets); the portal shows it in a sandboxed iframe. Edits are never made in the preview. `mode: "preview"` watermarks the page and shows a disabled Approve placeholder where the customer's button + card form will sit. Brand block (company name, license line, contact, terms link, footer note) is tenant config — placeholder until Harmon's identity block is captured.
- Events: `estimate_created | estimate_updated | estimate_sent | estimate_approved | estimate_declined | template_applied | line_added | line_updated | line_removed | job_created | job_updated | customer_created | customer_tagged | service_call_updated | field_updated | record_created | item_created | item_updated | item_new_version | item_deactivated` `| invoice_issued | invoice_sent | invoice_voided | payment_recorded` (the billing routes below) `| labor_billed` (direct labor billing) `| service_call_created | service_call_cancelled` (the board).

### Street View (the house on the job page)
`GET /service/jobs/{id}/street-view[?refresh=1]` → `{ status: "ready", url, key, cached }` | `{ status: "none" }` (Google has no imagery there) | `{ status: "unconfigured" }` (no key yet) | `{ status: "no_address" }`. The Google key lives in Secrets Manager **`sundial/google-maps`** as `{ "apiKey": "…" }` — never in the browser or an env var. The still is fetched ONCE per job: metadata first (free; `source=outdoor`) to learn whether imagery exists, then the image **by address** (`location=` + `source=outdoor`, so Google aims the camera at the house — a `pano=` request shows the camera car's heading, i.e. the house across the street), stored at `SUNDIAL/{jobId}/street-view.jpg` and remembered in `Street_View_Image_Key__c`; `NONE` in that field means "asked, nothing there" so the page stops asking. `?refresh=1` re-asks after an address fix. `502 STREET_VIEW_FAILED` when Google does not answer. Action `service.estimate.write`.

### Invoices + payments (D-072.6 / .1) — `invoice.js` inside this Lambda
One live invoice per job; the invoice is the estimate's non-removed lines **frozen** at issue; `Paid_Amount__c` is written here from Succeeded payment rows (Payment + Deposit + Adjustment − Refund); invoice status and the job's `Payment_Status__c` (and Invoiced ↔ Paid job status) are settled in one function after every money write. Reads: `service.estimate.write`; writes: **`service.invoice.write`**.
- `GET /service/jobs/{id}/invoice` → `{ jobId, jobStatus, paymentStatus, canIssue, issueBlocker, history[{id,name,status,total,issuedAt,voidedAt}], invoice | null, payments[], balance, pdfUrl }`. With no invoice, `payments` are the job's unattached rows (deposits) that will roll onto it.
- `POST /service/jobs/{id}/invoice` `{ dueDate? | netDays? }` → 201 `{ invoice, payments, balance, pdfUrl, jobStatus, paymentStatus, warnings[] }`. Number = job number (`-2`, `-3` after voids); Bill-To frozen from the job; money from `computeTotals` on the estimate's lines; unattached Succeeded payments back-filled; estimate → `Invoiced` (locks it), job → `Invoiced` (→ `Paid` at once if the deposits cover it); PDF at `SUNDIAL/{jobId}/{invoiceNumber}.pdf` (`PDF_S3_Key__c`, Files tab row, category Invoice). Proposed lines are billed but reported in `warnings`. `409 INVOICE_EXISTS` (live invoice), `400 NO_ESTIMATE | NO_LINES | DUE_DATE_INVALID`.
- `GET /service/invoices/{id}` → `{ invoice, payments, balance, pdfUrl, job:{id,name,status,paymentStatus,customerId,customerName,estimateId} }`.
- `GET /service/invoices/{id}/preview` → `{ html, title, number, status, total, balance }` — `buildInvoiceModel()` in `lib/estimate-document.js`, same painters as the estimate ("Bill to", Paid to date / Balance due rows, PAID / VOID watermark).
- `POST /service/invoices/{id}/payments` `{ type: Deposit|Payment|Refund|Adjustment (Payment), method: Card|Check|ACH|Partner Remittance|Other (Check), amount (>0; refunds positive), receivedAt?, reference?, notes? }` → 201 `{ id, invoice, payments, balance, jobStatus, paymentStatus }`. The row is `Succeeded` on write, `Recorded_By__c` = caller. `409 INVOICE_VOID`, `400 PAYMENT_INVALID`.
- `POST /service/invoices/{id}/send` `{ to? }` → `{ delivery: email|recorded, recipient, deliveryDetail, invoice, … }`. Fresh PDF (balance / PAID as of now) attached; customer-billed → the customer's email (current, else snapshot); partner-billed → `to` is required (`deliveryDetail` says so). `Issued` → `Sent`, `Sent_At__c` stamped. Subject is "Receipt for …" once the balance is zero.
- `POST /service/invoices/{id}/void` `{ reason }` → `{ status: "Void", jobStatus }`. Payments stay on the job (unhooked, so the reissue picks them up), the estimate reopens (`Approved` if ever approved, else `Sent`, else `Draft`), job → `Ready to Bill`. `400 REASON_REQUIRED`.
- Stripe card payments (webhook worker, `Stripe_Payment_Intent_Id__c` idempotency) are the next increment; nothing here changes for them.

**Stripe (D-072 amendment 8, 2026-09-17; `stripe.js` inside this Lambda; runbook `docs/integrations/stripe.md`).**
- `POST /service/invoices/{id}/charge` `{}` (`service.invoice.write`) → **200** `{ success, status: "succeeded" | "processing" | "requires_action", pending?, paymentId, paymentIntentId, amount, invoice, payments, balance, jobStatus, paymentStatus }`. Charges the invoice's balance on the customer's card on file, off-session: PaymentIntent created unconfirmed → a **Pending** Payment row (`Stripe_Payment_Intent_Id__c`) → confirm → Succeeded + `settleMoney`. A decline is **402** `{ code: <Stripe decline code>, message: <Stripe's words>, paymentId }` with the row left **Failed** (`Failure_Reason__c`). `400 NO_CARD | STRIPE_NOT_CONFIGURED`; `409 NOTHING_DUE | INVOICE_VOID | NOT_CUSTOMER_PAY | CHARGE_PENDING`. Activity `payment_recorded` (`via: "office-charge"`).
- `POST /service/jobs/{id}/invoice` accepts `chargeCard: true` — the same charge right after issue; its result rides back as `charge` and a decline adds a warning, never un-issues the invoice. `GET /service/jobs/{id}/invoice` gained `cardOnFile` + `billToType` so the portal knows to offer it. `PAYMENT_SELECT` gained `Stripe_Charge_Id__c, Stripe_Refund_Id__c, Failure_Reason__c`.
- `POST /webhooks/stripe/{tenant}` — **no bearer token**; the `Stripe-Signature` check over the raw body (5-minute tolerance) is the whole gate, fail closed (`503 STRIPE_NOT_CONFIGURED` with no webhook secret for the slug, `400 SIGNATURE_INVALID`). The tenant is the slug → `Sundial_Tenant__c.Name`; an event whose `metadata.tenantId` disagrees, or whose `livemode` does not match the keys, is `ignored`. Every accepted event is upserted into Supabase `sundial_stripe_events` by Stripe's event id (a redelivery is `200 { duplicate: true }`), with what Sundial did: `checkout.session.completed` → the hub's `Stripe_Customer_Id__c`, the job's `Customer_Card_on_File__c`, and Stripe's default card for the customer; `payment_intent.succeeded` → one Payment row per PaymentIntent (Deposit or Payment, Method Card), `Deposit_Paid_At__c` on the estimate, `settleMoney` (or the job's `Payment_Status__c` alone when no invoice exists yet) — **deferred** when the estimate has no job yet (Create Job applies it); `payment_intent.payment_failed` → the Pending row goes Failed; `charge.refunded` → a Refund row per Stripe refund (`Stripe_Refund_Id__c`) and a re-settle. A failure while applying is `500` so Stripe retries. Activity rows carry `via: "stripe"`, actor "Stripe".
- `POST /service/estimates/{id}/create-job` now returns `stripeApplied` — the number of deferred ledger rows (a deposit paid, a card kept) it landed on the new job.

### Direct labor billing (D-072 amendment 6) — `labor.js` inside this Lambda
The techs' clocked time on the job's **Complete** calls, and the office's per-call decision whether the customer pays for it by the hour. Off by default: a call that is not billable leaves **nothing** about hours on the estimate or the invoice (the customer is paying the price-book price). On: **one Labor line per billable call** (`Source__c = Time`, `Added_By_Service_Call__c` = the call, Kind Labor, UoM Hour, not taxable), hours = the office's number or the clock **rounded up to the quarter hour**, rate = the call's `Bill_Rate__c`, else the tech's `Sundial_User__c.Hourly_Bill_Rate__c`. Reads: `service.estimate.write`; writes: **`service.invoice.write`** (it is a billing decision).
- `GET /service/jobs/{id}/labor` → `{ jobId, jobNumber, estimateId, estimateLocked, calls:[{ id, number, status, subType, techId, techName, techDefaultRate, date, actualStart, actualEnd, clockMinutes, clockHours, hours, hoursSource: office|clock|none, rate, rateSource: call|tech|none, billable, amount, lineId, lineTotal }], summary:{ billableCalls, billableHours, billableAmount } }`. Complete calls only; `estimateLocked` once the invoice is issued.
- `POST /service/jobs/{id}/labor` `{ calls:[{ id, billable, hours?, rate? }] }` — the whole decision in one request: writes `Billable_to_Customer__c / Billable_Hours__c / Bill_Rate__c` on each call, then creates / updates / **deletes** its Time line and recomputes the estimate. → `{ success, applied:[{ id, action: created|updated|removed|none|pending, hours, rate, amount }], totals, …the GET view }`. `409 ESTIMATE_INVOICED` (locked); `400 NO_CALLS | CALL_INVALID | LABOR_INVALID | NO_ESTIMATE`. Activity `labor_billed`.
- `POST /service/labor/default-rate` `{ userId, rate | null }` → `{ success, id, name, rate }` — the tech's default bill rate on `Sundial_User__c` (the "save as X's default" link in the portal). Rates are what the customer is charged per hour, standardized across techs by policy, editable per call.

### Errors
`400` `CUSTOMER_REQUIRED | CUSTOMER_INVALID | LINE_INVALID | ITEM_INVALID | ITEM_NOT_FOUND | NO_FIELDS | INVALID_BODY | TEMPLATE_REQUIRED | ESTIMATE_NO_CUSTOMER | NO_ESTIMATE | NO_LINES | DUE_DATE_INVALID | PAYMENT_INVALID | REASON_REQUIRED`; `403` `ACTION_FORBIDDEN | NO_TENANT`; `404` `RECORD_NOT_FOUND | ROUTE_NOT_FOUND`; `409` `DUPLICATE_CANDIDATES | ESTIMATE_HAS_JOB | ESTIMATE_INVOICED | ITEM_CODE_IN_USE | ITEM_IN_USE | ITEM_NOT_ACTIVE | INVOICE_EXISTS | INVOICE_VOID`; `502` `SALESFORCE_ERROR` (`where` names the step, `message` carries Salesforce's text) `| ACTIVITY_READ_FAILED | STREET_VIEW_FAILED`.

## Dispatch board — service calls (D-072 amendment 4) — `sundial-service-board`

The board's backend (`docs/dispatch-board-design.md`). A service call is one tech × one appointment on a job; a multi-tech job is parallel calls. **Always fresh:** every read and every write goes to Salesforce directly — scheduling commits are on the always-fresh list, and a board that snaps a block back because the cache lagged is a board nobody trusts. **Optimistic concurrency:** mutations may carry `baseModstamp` (the `modstamp` the call was rendered with); a fresh read that disagrees is **409 `CALL_CONFLICT`** with the current `call` in the body and nothing written. Actions: `service.board.read`, `service.call.write` (tenant scope). After every write: activity row, cache rows stale, one Realtime broadcast (`tenant:{tenantId}:sundial_service:list`, event `board`, payload `{ kind:"call", action:"created|updated|cancelled", call, jobStatus }`), and — when `notifyCustomer: true` — a customer email with the window (SES; a text is the next increment now that `sundial-sms` exists), reported as `notified` / `detail` / `recipient` and never a reason to fail the write.

**Job status follows the calls (the only automation, all in `settleJobStatus`):** first call scheduled → job `New | Triaging | Remote Investigation | Ready to Schedule | Awaiting Parts` becomes `Scheduled`; a call `In Progress` → job `Scheduled` becomes `In Progress`; the last open call `Complete`/`No-Show` → job becomes `Awaiting Office Review`; the last open call cancelled → job `Scheduled` drops back to `Ready to Schedule`. Each transition is its own `job_updated` activity row (`via: "dispatch"`).

- `GET /service/board?from=<iso>&to=<iso>[&techId=]` → `{ window, techs:[{id,name,level}], techsSource, calls:[BoardCall], unscheduled:[TrayJob], unscheduledCalls:[BoardCall], defaults:{callMinutes,timeZone} }`. **`unscheduledCalls` (2026-09-15)** = calls with `Status__c = Unscheduled` — created "schedule later", each its own tray card (with its tech if one was picked); a job that has one is left out of `unscheduled` so it is not in the tray twice. Dropping such a card schedules THAT call (PATCH with `start`), keeping its notes and tech. Window capped at 42 days — the portal's month view is a fixed 6×7 grid (`400 WINDOW_TOO_WIDE`). **Techs** = active `Sundial_User__c` with `Access_Level__c = Technician` or `Default_Department__c = Service`; until the tenant marks anyone, every active user is a column and `techsSource` is `"all-users"` (the portal shows a banner). **Tray** = jobs whose status is one of the five unscheduled statuses, emergencies first then by age, 200 max. `BoardCall` = `{ id, number, jobId, jobNumber, jobStatus, customerId, customerName, address, phone, priority, serviceType, billToType, techId, techName, visitType, subType, start, end, status, cancelReason, actualStart, actualEnd, durationMinutes, workNotes, privateNotes, billable, billableHours, billRate, createdAt, modstamp }`.
- `GET /service/jobs/{id}/calls` → `{ jobId, jobStatus, calls, techs, defaults }` (the job page's card).
- `POST /service/jobs/{id}/calls` `{ techId, start, end?, subType?, privateNotes?, notifyCustomer?, unscheduled? }` → **201** `{ call, jobStatus, jobStatusChanged, notified, detail, recipient }`. `end` defaults to `start` + 120 min. `400` `TECH_REQUIRED | TECH_INVALID | START_REQUIRED | WINDOW_INVALID`; `409 JOB_CLOSED` when the job is Invoiced / Paid / Closed. Creates `Sundial_Service_Call__c` with `Visit_Type__c = Service`, `Status__c = Scheduled`, `Client__c` from the token. **`unscheduled: true`** (or simply no `start`) creates the call with `Status__c = Unscheduled`, tech optional, no window, no email, no job-status change — it waits in the dispatch tray.
- `PATCH /service/calls/{id}` `{ start?, end?, techId?, status?, subType?, workNotes?, privateNotes?, notifyCustomer?, baseModstamp? }` → `{ call, changed:[fields], jobStatusChanged, notified, detail }`; `{ unchanged: true }` when nothing differed. Moving (start / end / techId) a call that is `In Progress` or `Complete` is **409 `CALL_ALREADY_STARTED`**. `status` accepts `Scheduled | En Route | In Progress | Complete | No-Show` — `Cancelled` is refused (`400 USE_CANCEL`) so a reason is always recorded. Giving an **Unscheduled** call a `start` moves it to `Scheduled` (default length, `TECH_REQUIRED` if it still has no tech, job settles to Scheduled, customer email kind "scheduled"); any other status on a call with no start is `400 CALL_NOT_SCHEDULED`. Marking `In Progress` / `Complete` / `No-Show` by hand moves **the same clock log the phone writes** (2026-09-17): `In Progress` opens an `on_site` interval at now unless one is open, `Complete` and `No-Show` close the open one, and `Actual_Start__c` / `Actual_End__c` / `Duration_Minutes__c` are derived from the log (a never-clocked call marked Complete still gets `Actual_End__c = now`). Activity `service_call_updated` with `fields: { Field: { from, to } }`.
- `POST /service/calls/{id}/cancel` `{ reason, notifyCustomer?, baseModstamp? }` → `{ call, jobStatusChanged, notified }`; `400 REASON_REQUIRED`; `409 CALL_ALREADY_COMPLETE`; a second cancel is `200 { alreadyCancelled: true }`. Activity `service_call_cancelled`.
- **Time corrections (2026-09-17)** — the phone appends to `Clock_Intervals__c`, the office corrects here; the log is never edited by hand and nothing is ever lost from it.
  - `GET /service/calls/{id}/clock` (`service.board.read`) → `{ call: TechCall, log: [{ index, in, arrived, out, kind, minutes, gps:{in,arrived,out}, fromPhone, added, removed, corrections:[{ at, by:{id,name}, reason, from:{in,arrived,out} }] }], timeZone, serverTime }`. Every row of the log, **numbered** (`index`), removed rows included (flagged `removed: { at, by, reason }`). `fromPhone` = the row carries a tap's event id.
  - `POST /service/calls/{id}/clock` (`service.call.write`) `{ reason, intervals: [ { index, in, arrived?, out } | { in, arrived?, out, kind? } ], complete?, baseModstamp? }` → `{ call, log, changes:{ corrected:[{index,from,to}], added, removed }, jobStatusChanged, laborFromClock }`. The body is **the office's version of the live rows**: a row with `index` edits that interval (only `in` / `arrived` / `out` may change — GPS and the tap's ids stay), a row without one is a new interval (`kind` defaults to `on_site`, must be closed), and a live interval left out is **removed** (kept in the JSON with a `removed` stamp; counts for nothing afterwards, but its event ids still make a replayed tap a duplicate). Nothing reopens: a closed interval stays closed (`400 NO_REOPEN`), an open one may stay open only as the latest row (`400 OPEN_NOT_LAST`). Rules: `reason` required (`400 REASON_REQUIRED`), times not in the future (`400 TIME_FUTURE`, 5-min grace), `in < out`, `arrived` inside the interval (`400 ORDER_INVALID`), no overlap (`400 OVERLAP`), `400 INDEX_INVALID | INDEX_DUPLICATE | TIME_INVALID | IN_REQUIRED | OUT_REQUIRED`. Every changed row gets a `corrections[]` entry (who / when / why / the previous times); an added row an `added` stamp. Then `Actual_Start__c` / `Actual_End__c` / `Duration_Minutes__c` are **re-derived from the log** — end + duration only when the call is Complete (an In Progress call whose open interval is closed is *paused*, not finished). `complete: true` closes the job's loop: the call goes `Complete` (`409 CALL_STATE` unless Scheduled / En Route / In Progress; `400 STILL_OPEN` while an interval is open; `400 NO_CLOCK` with no clocked time — use the status menu for those) and the job settles as usual. An `En Route` call whose drive is closed off without an arrival goes back to `Scheduled`. Same rows back → `200 { unchanged: true }`, nothing written. `409 CALL_CONFLICT | CALL_CANCELLED | CALL_NOT_SCHEDULED`. Activity `service_call_clock` (`via: "dispatch"`, `reason`, counts, the three fields old → new). `laborFromClock: true` means the call is billable with hours taken from the clock, so the job's Labor billing card must be re-saved for its `Source = Time` line to follow the correction.
- Errors: `404 RECORD_NOT_FOUND | ROUTE_NOT_FOUND` (cross-tenant ids look like missing ones); `403 ACTION_FORBIDDEN | NO_TENANT`; `502 SALESFORCE_ERROR`.

Wire script: `scripts/wire-service-board-routes.ps1` (adds `/service/board`, `/service/jobs/{id}/calls`, `/service/calls/{id}`, `/service/calls/{id}/cancel`, `/service/calls/{id}/clock`; invoke permission `apigw-service-board` on `…/*/*/service/*`).

## The technician app (D-072 amendment 7) — `sundial-service-board` `tech.js` (+ one route in `sundial-service-estimate`)

The routes behind the portal's `/tech` app (`docs/pwa-architecture.md`). All need action **`service.tech.self`** — the ONLY action a Technician login (scope `tech`) has; tenant scope has it too and may act for any tech (`techId=` on the day; any call). A call that is not the caller's is a **404**, never a 403. Every write: activity row (`service_call_clock | service_call_note | service_call_photo`), call cache stale, one board broadcast (`via: "tech"`) so open dispatch boards patch themselves.

- `GET /service/tech/day?date=YYYY-MM-DD[&techId=]` → `{ date, timeZone, window, tech:{id,name}, calls:[TechCall], unscheduled:[TechCall], activeCallId, serverTime }`. `date` is in `SERVICE_TIMEZONE` (default today); `calls` = the tech's calls starting that day **plus** any En Route / In Progress call of theirs on any date; `unscheduled` = their calls with no window. `TechCall` = `BoardCall` + `{ issue, email, estimateId, geocode:{lat,lng,status}|null, geofenceVerified, photosCount, clock:{ state: idle|en_route|on_site, since, openSince, minutes, intervals }, intervals:[…], checklist:{ key, title, items:[{ key, label, required, auto, done, at, by }], missing:[keys], complete } }`. `400 DATE_INVALID`; `403 NO_TECH_USER` when the login has no active `Sundial_User__c`.
- `GET /service/tech/calls/{id}` → `{ call:TechCall, otherTechs:[{ id, techId, techName, status, start, end, isMe }], photos:[{ key, fileName, publicUrl, size, lastModified }], estimate:{ id, number, status, total, subtotal, lines:[{ id, description, kind, quantity, unitPrice, lineTotal, stage, addedByThisCall }] }|null, geofenceMeters, serverTime }`.
- `POST /service/tech/calls/{id}/status` `{ status: En Route | In Progress | Complete | No-Show, at?, gps?:{lat,lng,accuracy}, eventId?, textCustomer?, message?, note?, override? }` → `{ call, jobStatus, jobStatusChanged, closedOthers:[{id,status}], text?:{ sent, to | reason: NO_PHONE|SKIPPED|NOT_CONFIGURED|SEND_FAILED, detail }, geofence?:{ verified, distanceMeters, against: job|shop|null } }`. The clock engine is documented in `docs/pwa-architecture.md`: En Route opens an `en_route` interval and closes the tech's other clocks (+ the "on my way" text via `lib/sms-send.js`); In Progress arrives / opens `on_site` (+ geofence tag; job → In Progress, or a Complete call reopens with a new interval and the job goes Awaiting Office Review → In Progress); Complete runs the checklist gate then closes (`Actual_End__c`, `Duration_Minutes__c` = the sum of intervals); No-Show needs `note`. `at` defaults to now and must not be in the future, older than 7 days, or before the call's last clock event (`400 AT_INVALID | AT_FUTURE | AT_TOO_OLD | AT_OUT_OF_ORDER`); a repeated `eventId` is `200 { duplicate: true }`. `409 CALL_CANCELLED | CALL_NOT_SCHEDULED | CALL_STATE | CALL_NOT_STARTED | CHECKLIST_INCOMPLETE { missing, checklist }`; `400 STATUS_INVALID | TECH_REQUIRED | NOTE_REQUIRED`.
- `POST /service/tech/calls/{id}/notes` `{ body, private?, at?, eventId? }` → `{ call }` — appends one stamped entry (`── Name · date`) to `Work_Notes__c` or `Private_Notes__c`; never edits what is there. `400 EMPTY_NOTE`; a repeated `eventId` is `{ duplicate: true }`.
- `POST /service/tech/calls/{id}/checklist` `{ key, done, at? }` → `{ checklist }`. `400 ITEM_INVALID | ITEM_AUTOMATIC` (work notes / photos tick themselves).
- `POST /service/tech/calls/{id}/photos` `{ fileName, contentType (image/*), size? }` → `{ uploadUrl, key, publicUrl, expiresIn }` — a 5-minute presigned PUT into `SUNDIAL/{jobId}/photos/{callId}/{stamp}-{name}`. `400 NOT_AN_IMAGE | TOO_LARGE (25 MB) | NO_JOB`.
- `POST /service/tech/calls/{id}/photos/confirm` `{ key, size?, contentType?, caption? }` → `{ photosCount, photos, checklist }` — registers the `sundial_file_metadata` row on the **job** (`category: photo`, `subfolder: photos/{callId}`; idempotent on the key) and sets `Photos_Count__c` from the S3 listing. `400 KEY_INVALID` for a key outside the call's folder.
- `GET /service/tech/calls/{id}/photos` → `{ photos, photosCount }`.
- `GET /service/tech/price-book?q=` → `{ q, items:[{ id, name, code, kind, category, description, unit, defaultQuantity, price, taxable }] }` — active items, name / code / description contains `q`, 25 max.
- `POST /service/tech/calls/{id}/estimate-lines` (**estimate Lambda**) `{ lines:[ { priceBookItemId, quantity? } | { description, kind, unitPrice, quantity? } ] }` → **201** `{ estimateId, lines:[{ id, description, kind, quantity, unitPrice, lineTotal, stage, addedByThisCall }], problems, totals }`. Every line lands **Proposed**, `Source__c = Field`, `Added_By_Service_Call__c` = the call, appended after the office's lines, totals recomputed; `stage` / `source` in the body are ignored. `409 CALL_CANCELLED | NO_ESTIMATE | ESTIMATE_INVOICED`; `400 LINE_INVALID { problems }`.
- **Read-only, tenant-wide (2026-09-16; action `service.tech.read`, which a tech and the office hold):** a tech at a house needs the customer's history and any job's estimate, assigned or not.
  - `GET /service/tech/jobs?q=&status=` → `{ q, status, jobs:[{ id, number, status, priority, serviceType, jobType, customerId, customerName, address, phone, email, issue, summary, estimateId, estimateTotal, billToType, paymentStatus, createdAt }] }` — open jobs (not Closed / Cancelled / Paid) newest first, 50 max; `q` searches number / customer / address / phone and then includes closed ones; `status` filters exactly.
  - `GET /service/tech/jobs/{id}` → `{ job, calls:[BoardCall + isMine], estimate:{ …summary, lines } | null }`.
  - `GET /service/tech/estimates?q=&status=` → `{ estimates:[{ id, number, status, version, customerId, customerName, address, phone, jobId, subtotal, discount, tax, total, deposit, sentAt, approvedAt, createdAt }] }` — never templates. `GET /service/tech/estimates/{id}` → `{ estimate: { …, lines } }` (a template id is a 404).
  - `GET /service/tech/customers?q=` → `{ customers:[{ id, name, firstName, lastName, address, phone, email, projectTypes, createdAt }] }` (newest 50 without a search; `q` on name / street / phone / email). `GET /service/tech/customers/{id}` → `{ customer, jobs, estimates }`.
  - The job's Communications for a tech: `GET /service/jobs/{id}/sms` and `GET /service/jobs/{id}/activity` now accept `service.tech.read` alongside `service.estimate.write`; `POST /service/jobs/{id}/sms` (`service.sms.send`) is open to a tech too. Team notes go browser-direct under RLS — `sql/sundial_access_p10_tech_scope.sql` teaches the policies the `tech` scope (job / estimate / customer tenant-wide; a tech is staff for mentions). `GET /sf/users` (the @-mention list) serves a tech the tenant directory.
- Wire script: `scripts/wire-service-tech-routes.ps1`.

## Customer texting (D-072 amendment 6) — `sundial-sms`

The Service module's SMS thread with the customer, behind the job page's **Communications** panel (`docs/integrations/sms-twilio.md`). Twilio underneath, never branded. Rows live in Supabase `sundial_sms_messages` (`sql/sundial_sms_messages.sql`; browser access revoked — the Lambda is the only reader). After every row change the Lambda broadcasts `tenant:{tenantId}:sundial_service_job:{jobId}`, event `sms`, payload `{ kind: sent|received|status, message }`, so an open job page updates without polling.
- `GET /service/jobs/{id}/sms` → `{ jobId, jobNumber, customerName, customerPhone, customerPhonePretty, fromNumber, fromNumberPretty, canSend, notConfiguredReason, messages:[{ id, direction: in|out, jobId, from, to, fromPretty, toPretty, body, media[{url,contentType}], status, errorCode, sentByName, at, updatedAt }] }` oldest first. `customerPhone` = the customer's CURRENT `Primary_Phone__c`, else the job's snapshot, as E.164. Action `service.estimate.write`.
- `POST /service/jobs/{id}/sms` `{ body (≤1600), to? }` → `{ success, message }` — sends through `lib/sms-send.js` (the shared sender the tech app's "on my way" text also uses) to Twilio from the tenant's number with a status callback, stores the row as `queued`. `400 EMPTY_BODY | BODY_TOO_LONG | NO_PHONE`; `503 SMS_NOT_CONFIGURED`; `502 SMS_SEND_FAILED` (the row is kept as `failed` with Twilio's error code, so the office sees it). Action **`service.sms.send`**.
- `GET /service/sms/unmatched` → `{ messages }` — inbound texts that could not be matched to a job (kept, never dropped). Action `service.estimate.write`.
- `POST /sms/inbound` — **Twilio's messaging webhook** (form-encoded; `From, To, Body, MessageSid, NumMedia, MediaUrlN`). The only gate is `X-Twilio-Signature` (HMAC-SHA1 over the exact URL + params with the auth token, constant-time compared; fails closed with no secret). Tenant = the number it was sent **to**; the job = **(1)** the job we last texted that number from, **(2)** the tenant's most recent open job whose phone snapshot matches (last ten digits), **(3)** the customer with that phone and their latest job — else stored with no job. Idempotent on `MessageSid`. Answers an empty TwiML `<Response/>` so Twilio sends no auto-reply.
- `POST /sms/status` — Twilio's per-message status callback (`MessageSid, MessageStatus, ErrorCode`), same signature gate; updates the row (`sent → delivered | undelivered | failed`) and broadcasts.
- Wire script: `scripts/wire-sms-routes.ps1`. Twilio console: the number's messaging webhook = `POST <SMS_WEBHOOK_BASE>/sms/inbound`.

## Public — the customer's hosted estimate page (D-072.7) — `sundial-service-public`

**No portal login.** These are the routes the customer's email link hits. The only credential is the token in the URL — 24 random bytes (base64url) minted once per estimate by `/send`, stored in `Sundial_Estimate__c.Public_Token__c` (External ID) with `Public_Token_Expires_At__c`. Authorization at the gateway is NONE (there is no bearer token to check); the Lambda answers **404** for any token it cannot resolve to exactly one non-template estimate (wrong and unknown look identical — the URL space cannot be probed for shape), **410** `LINK_EXPIRED` once the token has expired. Nothing here accepts a record id, tenant id, or field name from the caller; the tenant is read from the estimate's `Client__c` and stamped onto the activity row. The portal page is `harmon-crm` `/estimate/:token` (outside `ProtectedRoute`, plain `fetch`, no `Authorization` header).

- `GET /public/estimates/{token}` → `{ html, title, number, status, version, total, depositAmount, depositRequired, validUntil, approvedAt, approvedByName, customerName, canAccept, pdfUrl }`. `pdfUrl` is the PDF of the version being viewed (from `Version_Log__c`), null when that send produced none — never an older version's. `html` is `lib/estimate-document.js` in `customer` mode — the same renderer as the office preview. The first open of a `Sent` estimate flips it to `Viewed` and stamps `Last_Viewed_At__c` (best-effort; activity actor "Customer"). `canAccept` is true for `Sent | Viewed | Draft` with a version > 0.
- `POST /public/estimates/{token}/accept` `{ name }` → **200** `{ success, …summary }` — `Status Approved`, `Approved_At/Version/Amount`, `Approval_Method__c = Online`, `Approved_By_Name__c = name`, every `Proposed` line → `Approved`; activity `estimate_approved` with actor `Customer: {name}`. **400** `NAME_REQUIRED` (the typed name is the e-signature); **200** `alreadyApproved: true` on a second accept (idempotent — never a second approval); **409** `ESTIMATE_NOT_OPEN` when the estimate is Declined / Invoiced / unsent. Card capture (Stripe SetupIntent / deposit) attaches to this step when Harmon's Stripe keys arrive.
- `POST /public/estimates/{token}/decline` `{ reason? }` → `Status Declined`, `Declined_Reason__c`; **409** `ESTIMATE_NOT_OPEN` once Approved / Invoiced.
- **Payments (D-072 amendment 8, 2026-09-17; `docs/integrations/stripe.md`).** `GET` (and `accept`) now also return `payment: { configured, cardOnFile, depositRequired, depositAmount, depositPaidAt, invoice: { number, status, total, paid, balance } | null, next: "setup" | "deposit" | "balance" | null, unavailable }` — `next` is the ONE step the page offers, derived from the records (approved + unpaid deposit → `deposit`; approved + no card → `setup`; a live invoice with a balance → `balance`; a partner-billed job → never). `POST /public/estimates/{token}/checkout` `{ kind }` → `{ url, kind, mode }` — a Stripe Checkout Session on the tenant's keys (`setup` mode for a card on file; `payment` mode with `setup_future_usage: off_session` for the deposit / the balance, so the card is kept for the final charge); the Stripe customer is found-or-created and remembered on `Sundial_Customer__c.Stripe_Customer_Id__c`; success / cancel URLs return to the page with `?checkout=success&kind=…` / `?checkout=cancel`. `400 KIND_INVALID`; `409 CHECKOUT_NOT_APPLICABLE` when the browser asks for a step that is not due (the page reloads); `503 STRIPE_NOT_CONFIGURED | PUBLIC_URL_NOT_SET`; `502 STRIPE_ERROR`. This Lambda never writes a Payment row — the money arrives through the webhook below.
- Errors: `404` `ESTIMATE_NOT_FOUND | ROUTE_NOT_FOUND`; `410` `LINK_EXPIRED`; `502` `SALESFORCE_ERROR`; `500` `server_error`. Every 4xx body carries a customer-safe `message` the page shows verbatim.

Wire script: `scripts/wire-service-public-routes.ps1` (resources `/public/estimates/{token}` + `/accept` + `/decline` + `/checkout`, invoke permission `apigw-service-public` on `…/*/*/public/*`).

