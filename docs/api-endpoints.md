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

**Query string parameters (typical):**
- `status` — Filter by Status__c picklist value
- `stage` — Filter by Stage__c picklist value
- `salesRepId` — Filter by Sales_Rep__c lookup
- `limit` — Max results (default 50, max 200)
- `offset` — Pagination offset
- `forceFresh` — Boolean, if `true` bypasses cache and reads directly from Salesforce

**Tenant scoping:** Always enforced via the authenticated user's Client__c context — the Salesforce Client record ID resolved from the verified token (`resolveIdentity` → `tenantId`). The cache is filtered on `client_sf_id`; Salesforce is filtered on `Client__c = '<tenantId>'`. The tenant slug is a label only and is never used for isolation. No request input can set or override the tenant. See DECISIONS.md D-035.

**Implementation status:** Built, deployed, and verified end to end against the live org. Cache miss falls through to Salesforce and writes back; an immediate repeat serves `source: "cache"`.

> **Known limitation (deferred):** the list read currently treats any non-empty tenant cache result as authoritative and does not re-check Salesforce for completeness, so a partially-populated cache can return an incomplete list. The optional `?field=&value=` filter quotes the value as a string (works for text/picklist; a numeric/boolean filter can error).

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
- `credentialMode: "invite"` emails a set-password link; `"password"` creates the user with `tempPassword` (email pre-confirmed, `must_change_password` flag).
- **Order** (fail-safe): duplicate-guard (409) → Supabase auth create (reuses an existing auth user by email if already registered) → `Sundial_User__c` create (force-stamps `Client__c`, sets the auth id). If the SF create fails after a *fresh* auth user was made, that auth user is deleted (compensating); if the delete also fails, the response includes `orphanAuthUser: true`.

**Response (201):**
```json
{ "id": "a0X...", "email": "jane@example.com", "credentialMode": "invite", "inviteSent": true }
```
**Errors:** 400 `VALIDATION_ERROR` (field-level `fields`), 409 `USER_ALREADY_EXISTS`, 502 `SUPABASE_CREATE_FAILED` / `SF_CREATE_FAILED`. `tempPassword` is never logged or returned.

#### `PATCH /admin/users/{id}`

Updates whitelisted fields on one tenant user. Body may contain `firstName`, `lastName`, `phone`, `accessLevel`, `defaultDepartment`, `active` (boolean). Any other key (`superAdmin`, `email`, `Client__c`, `Supabase_User_Id__c`, `hierarchyLevel`, …) → 400 `FIELD_NOT_ALLOWED`.
- Tenant pre-check: a cross-tenant or missing id → 404 `RECORD_NOT_FOUND`.
- `active: false` also **bans** the linked Supabase auth user (kills live supabase-direct sessions, e.g. comments RLS); `active: true` unbans. Salesforce `Active__c` is the source of truth — a ban failure still applies the SF change and returns `supabaseBanFailed: true`.
- A Super Admin **cannot deactivate themselves** → 400 `CANNOT_DEACTIVATE_SELF`.

**Response (200):** `{ "success": true, "id": "a0X..." }`

---

### Webhooks

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
| `sundial-list-files` | GET /files/by-record/{recordId} |
| `sundial-upload-file` | POST /files/by-record/{recordId}/upload |
| `sundial-list-related-files` | GET /files/by-record/{recordId}/related |
| `sundial-download-file` | GET /files/by-id/{fileId}/download |
| `sundial-delete-file` | DELETE /files/by-id/{fileId} |
| `sundial-budget` | POST /projects/{recordId}/budget/recalc |
| `sundial-user-admin` | GET /admin/users, POST /admin/users, PATCH /admin/users/{id} |
| `sundial-acumatica-webhook` | POST /webhooks/acumatica |

Lambda functions not exposed through API Gateway:

| Lambda | Trigger | Purpose |
|---|---|---|
| `sundial-acumatica-push` | SQS (sundial-acumatica-outbound) | Outbound calls to Acumatica with rate-limit handling |
| `sundial-dropbox-sync` | S3 PUT events on `constructive-sundial-files` | Mirrors uploaded files to Harmon's Dropbox |
| `sundial-cache-invalidator` | Salesforce Platform Events (Phase 2+) | Propagates out-of-band Salesforce changes to the cache |

---

## Deployment

API Gateway deployment is manual via the AWS Console (Actions → Deploy API → stage `prod`). When Phase 1 begins, this should be moved to an infrastructure-as-code workflow (Terraform, CDK, or SAM) so changes can be reviewed in pull requests and rolled back if needed.

Until then: any route changes in the Console must be deployed via Actions → Deploy API before they take effect at the prod URL.
