# Sundial — File Storage Architecture

> How files are stored, organized, accessed, and synced across Sundial portal, Salesforce (via XFiles Pro), and Harmon's Dropbox.

---

## Overview

Files for all Sundial records live in AWS S3, organized by Salesforce record ID. The same folder structure serves three access surfaces:

1. **Sundial portal** — Users see a Files tab on every record detail page, with upload, download, search, and related-files navigation
2. **Salesforce + XFiles Pro** — Admin users (Tim) and any future Salesforce-side users see the same files natively inside Salesforce via the XFiles Pro app, which reads from the same S3 bucket
3. **Harmon's Dropbox** — Automated copy-back keeps a mirror of every file in Harmon's existing Dropbox account for ownership comfort and offline access

This is a deliberate move away from the URL-field-per-document pattern used in the TAG portal. The folder-per-record pattern scales better (no field count problems), supports unlimited document categories without schema changes, and aligns with how XFiles Pro expects to find files.

---

## S3 Bucket Structure

**Bucket:** `sfsolproj` (shared with XFiles Pro). All Sundial files live under the `SUNDIAL/` top-level prefix to keep them separate from XFiles Pro's existing organization.

**Path format:**
```
SUNDIAL/{sf_record_id}/{filename}
```

**Examples:**
```
SUNDIAL/a01XX000003ABCD/proposal-signed.pdf
SUNDIAL/a01XX000003ABCD/site-photos/roof-front.jpg
SUNDIAL/a02XX000004EFGH/diagnostic-screenshot.png
SUNDIAL/a03XX000005IJKL/utility-bill.pdf
SUNDIAL/a04XX000006MNOP/vendor-quote.pdf
```

Full URLs look like `https://sfsolproj.s3.us-west-1.amazonaws.com/SUNDIAL/a01XX000003ABCD/proposal.pdf`.

Subfolders within a record's folder are allowed (e.g., `site-photos/`, `permits/`, `signed-contracts/`) and the portal surfaces them as logical groupings.

### `SUNDIAL/_orphan-welcome-calls/` — the one non-record prefix

```
SUNDIAL/_orphan-welcome-calls/{call_id}.mp3
```

A holding area for Welcome Call recordings that have no record to attach to yet. A sales rep can start a Welcome Call from a form for a customer who has not been created in Salesforce, so the recording arrives with no `sf_record_id`. Throwing it away is not an option (it is a recorded conversation about a contract), and there is no folder to put it in.

**The leading underscore is load-bearing.** It is not a valid Salesforce record ID, so this prefix can never collide with a real record folder, XFiles Pro never resolves a record to it, and it sorts away from the record folders in any S3 browser.

**Nothing here has a `sundial_file_metadata` row**, deliberately: every list query is scoped by `sf_record_id`, so a row with a null one would be unreachable — worse than no row, because it looks registered. The file becomes a normal record file only when `POST /welcome-call/orphan-match` promotes it to `SUNDIAL/{sf_record_id}/welcome-call-{date}-{call_id}.mp3`, registers metadata, and deletes the holding object.

Objects should not accumulate here. Anything older than a few weeks is a call the Zapier sweep never managed to match — worth a look, not a lifecycle rule (deleting an unmatched recording of a signed-contract conversation is the wrong default). See `docs/integrations/retell-welcome-call.md`.

**Note on tenant isolation:** Earlier drafts of this design included `{tenant_id}` as the first path segment for multi-tenant isolation at the path level. Because XFiles Pro requires a single bucket and a fixed prefix per configuration, tenant isolation now lives entirely in Lambda code rather than the path. This is acceptable for the under-10-clients scale Sundial is targeting; every Lambda must enforce tenant filtering by querying the SF record's `Client__c` value before granting any file access. If a future requirement creates a need for path-level isolation, we will revisit, potentially by giving each client its own bucket.

**Path pattern verified against existing XFiles Pro install:** Tim's existing XFiles Pro setup uses an analogous pattern for Solar_Project__c with the prefix `OPS/`, paths look like `OPS/{record_id}/{filename}`. SUNDIAL follows the same pattern as a peer functional prefix. No object type in the path; SF record ID is sufficient for XFiles Pro to resolve.

---

## Why Salesforce Record ID as Folder Name

This is the architectural keystone. The choice has several downstream benefits:

- **Unique and permanent.** Salesforce record IDs never change after creation, so the folder never needs to move.
- **No sync logic needed for XFiles Pro alignment.** XFiles Pro looks for files in S3 by the SF record ID. As long as files live under `SUNDIAL/{sf_record_id}/`, both Sundial and XFiles Pro find them automatically.
- **Cross-system consistency.** Whether you're in Sundial, Salesforce native UI, or browsing the Dropbox mirror, the folder for a given record is identifiable by ID.
- **Migration-safe.** If we ever change the portal UI, the underlying file organization doesn't have to change.

The downside is that folder names aren't human-readable (Salesforce IDs are opaque strings). This is mitigated by:
- The portal UI showing project names, not folder paths
- The Dropbox mirror using human-readable folder names (see Dropbox Sync section)

---

## File Metadata in Supabase

File metadata is stored in Supabase, not Salesforce. This keeps API consumption low and supports fast portal queries.

**Table:** `sundial_file_metadata`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `s3_key` | text | Full S3 object key (path including filename) |
| `file_name` | text | Original filename as uploaded |
| `tenant_id` | text | Matches `Client__c` value |
| `sf_record_id` | text | The parent record's Salesforce ID |
| `sf_object_type` | text | E.g., `Sundial_Solar__c` |
| `uploaded_by_user_id` | text | Sundial_User__c ID |
| `uploaded_by_user_name` | text | Denormalized for display |
| `uploaded_at` | timestamptz | Default `now()` |
| `file_size_bytes` | bigint | |
| `mime_type` | text | |
| `category` | text | Optional: Proposal, Contract, Photo, Permit, Invoice, Other |
| `description` | text | Optional, user-provided |
| `subfolder` | text | If file is in a subfolder within the record folder |
| `soft_deleted` | boolean | Default false |
| `deleted_at` | timestamptz | |
| `deleted_by_user_id` | text | |
| `s3_version_id` | text | For S3 versioning support |

**Indexes:**
- `(tenant_id, sf_record_id)` — primary access pattern
- `(tenant_id, soft_deleted)` — listing active files
- `(uploaded_at)` — recent files
- `(category)` — category filtering

---

## Lambda Functions

The file system exposes five Lambda functions through API Gateway. See `docs/api-endpoints.md` for the canonical API reference with full request/response shapes.

### `sundial-list-files`
Route: `GET /files/by-record/{recordId}`
Returns metadata for all files associated with a Salesforce record.
- **Source:** Queries Supabase `sundial_file_metadata` table (does not query S3 directly)
- **Tenant enforcement:** Verifies the authenticated user's `Client__c` matches the record's tenant before returning

### `sundial-upload-file`
Route: `POST /files/by-record/{recordId}/upload`
Returns a presigned PUT URL for direct browser-to-S3 upload, plus creates the metadata record.
- **Output:** Presigned PUT URL, expires in 15 minutes; metadata record ID
- **Tenant enforcement:** Verifies the authenticated user's `Client__c` matches the target record's tenant

### `sundial-download-file`
Route: `GET /files/by-id/{fileId}/download`
Returns a presigned GET URL.
- **Output:** Presigned GET URL, expires in 15 minutes
- **Tenant enforcement:** Verifies the authenticated user's tenant matches the file's tenant

### `sundial-delete-file`
Route: `DELETE /files/by-id/{fileId}`
Marks the file as soft-deleted in metadata; the actual S3 object is retained.
- **Hard delete** of S3 objects happens via a scheduled cleanup Lambda after the retention period (default 90 days, configurable in `client-config.ts`)

### `sundial-list-related-files`
Route: `GET /files/by-record/{recordId}/related`
Returns files from related records based on Salesforce relationships.
- **Logic:** Lambda traverses the SF relationships (Sundial_Customer__c on the source record, any linked projects, related POs, etc.) and queries the metadata table for files associated with those related records

### Other writers into `SUNDIAL/`

Not every object under `SUNDIAL/` arrives through `sundial-upload-file`. Three Lambdas write files as a side effect of doing something else, and all of them reuse the same key convention and the shared `registerFileMetadata` helper in `lib/file-access.js` so the results are indistinguishable from an upload:

| Writer | Key | Category |
|---|---|---|
| `sundial-budget` | `SUNDIAL/{solarId}/Budget_{Name}_{timestamp}.xlsx` | budget snapshot |
| `sundial-list-files` (copy-to-solar) | `SUNDIAL/{solarId}/{name}` | `Copied from Customer` |
| `sundial-aurora-inbound` | `SUNDIAL/{customerId}/{agreementId}-signed-agreement.pdf` | signed agreement |
| `sundial-welcome-call` | `SUNDIAL/{customerId}/welcome-call-{date}-attempt-{n}.mp3` | `Welcome Call Recording` |

**Registration is best-effort for all of them.** The deployed Files tab lists straight from S3, so a file is visible the moment it lands; the metadata row adds category, uploader, and search. A Supabase outage must never fail the operation that produced the file.

**Deterministic keys mean re-runs overwrite rather than duplicate** — but only in S3. A second `registerFileMetadata` for the same key would insert a *second* row and show the file twice in the Files tab with no way to tell them apart. Any writer that can legitimately run twice (a webhook redelivery, a retried copy) must call `findFileMetadataByKey` first and skip the insert; `sundial-welcome-call` does.

### Path structure note

The split between `/files/by-record/{recordId}/...` and `/files/by-id/{fileId}/...` exists because API Gateway does not allow two differently-named path variables to coexist as siblings. The `by-record` and `by-id` segments make the API self-documenting about which identifier each endpoint expects.

---

## Portal UI

### Files Tab on Every Record

Every record detail page (Sundial_Solar__c, Sundial_Roofing__c, Sundial_Commercial__c, Sundial_Service__c, Sundial_Customer__c, Sundial_PO__c, etc.) includes a Files tab. The tab displays:

- **File list** with columns: name, category, size, uploaded date, uploaded by, actions (download, delete, edit metadata)
- **Search bar** filtering by filename, category, or description
- **Upload area** supporting drag-and-drop and click-to-browse, with optional category selection before upload
- **Subfolder navigation** for records with organized file structures
- **Soft-delete with undo** (deleted files show in a "Recently Deleted" view for the retention period)

### Related Files Section

Below the primary file list, a "Related Files" section pulls files from connected records:

- On `Sundial_Solar__c`: files from the linked `Sundial_Customer__c`, any linked `Sundial_Roofing__c`, related `Sundial_PO__c` records, the originating `Sundial_Service__c` (when applicable)
- On `Sundial_Service__c`: files from the linked `Sundial_Customer__c`, the linked `Asset` (installed system), and the originating `Sundial_Solar__c` / `Sundial_Commercial__c` / `Sundial_Roofing__c` projects
- On `Sundial_Customer__c`: files from all of this customer's projects across the four project objects

Related files are grouped by source record with a header indicating where each group came from, and a link to navigate to that record's full file view.

### Permissions

File access permissions inherit from record permissions. If a user can see the record, they can see its files. If a user cannot see the record (filtered by Client__c, Parent_User__c hierarchy, or other sharing rules), the file metadata never reaches them.

Upload permissions per record can be more restrictive than view permissions if needed; this is controlled per-client in `client-config.ts`.

---

## XFiles Pro Integration

XFiles Pro is a Salesforce AppExchange app that surfaces S3 files inside the Salesforce UI as if they were native attachments. Tim uses XFiles Pro for unified file access between Sundial and Salesforce, and the existing XFiles Pro installation is bound to the `sfsolproj` S3 bucket.

**How it works with Sundial's folder convention:**

- Both Sundial and XFiles Pro read from and write to the `sfsolproj` bucket
- Sundial writes everything under the `SUNDIAL/` prefix so its files are clearly separated from XFiles Pro's other organization
- For each Sundial_* custom object, XFiles Pro is configured to find files at the path `SUNDIAL/{sf_record_id}/`. Confirmed to match Tim's existing pattern (Solar_Project__c uses `OPS/{record_id}/`)
- When Tim opens a Sundial_Solar__c record in Salesforce, XFiles Pro automatically displays the same files the portal user sees on that record's Files tab
- No sync between Sundial and Salesforce is required; both systems read the same S3 folder

**Implications:**

- Tim (as admin) has full file visibility in Salesforce without needing to log into the portal
- Files uploaded via the portal are immediately visible in XFiles Pro and vice versa
- One source of truth (S3), three views (Sundial portal, Salesforce via XFiles Pro, Dropbox mirror)
- No duplication of file storage; XFiles Pro and Sundial coexist in one bucket
- IAM enforcement keeps Sundial's Lambda functions scoped to the `SUNDIAL/` prefix only, so they cannot accidentally read or modify XFiles Pro's other files

**XFiles Pro configuration:**

- Verify the existing XFiles Pro setup points at the `sfsolproj` bucket
- For each Sundial_* custom object, configure XFiles Pro's path pattern to include the `SUNDIAL/` prefix
- Path pattern confirmed: SF record ID alone is sufficient (matches existing OPS pattern). Manual XFiles Pro setup is required per Sundial_* object (see CLAUDE.md XFiles Pro Configuration Tasks checklist)
- File metadata in Supabase remains the portal's source of truth for filtering, search, and audit; XFiles Pro shows raw S3 contents (sufficient for admin needs)

---

## Dropbox Sync

Files in S3 are automatically copied to Harmon's Dropbox account for data ownership and familiar local access.

**Architecture:**

- S3 PUT events on the `sfsolproj` bucket (filtered to the `SUNDIAL/` prefix) trigger a Lambda function (`dropbox-sync`)
- The Lambda authenticates against Harmon's Dropbox via OAuth token stored in AWS Secrets Manager
- Lambda copies the file to Harmon's Dropbox at a human-readable mirror path

**Dropbox path format:**

```
/Sundial/{ProjectType}/{ProjectName-or-CustomerName}/{filename}
```

Examples:
```
/Sundial/Residential Solar/Smith - 123 Main St Phoenix/proposal-signed.pdf
/Sundial/Service/Jones Service Call 2026-06-15/diagnostic.png
/Sundial/Roofing/Garcia - 456 Oak Ave Tempe/inspection-report.pdf
```

Why human-readable on Dropbox rather than SF record IDs: Harmon users browsing Dropbox directly need names they can recognize. The SF record ID stays as the S3 source of truth; Dropbox is a navigation mirror.

**Project name fallback:** If a record has no name set, fall back to the customer name plus address. If neither is available, fall back to the SF record ID (rare but defensible).

**Sync characteristics:**

- One-way: S3 to Dropbox only. Sundial does not pull changes from Dropbox.
- Near-real-time: Triggered on S3 PUT, typically completes within seconds.
- Resilient: Failed sync attempts retry up to 5 times with exponential backoff. Permanent failures land in a dead-letter queue with CloudWatch alerts.

**Deletion handling:**

- Soft-deleted files in Sundial are moved in Dropbox to `/Sundial/_archived/{original_path}` rather than permanently deleted.
- Hard-deleted files (after retention period) are deleted from Dropbox too.

**Rename handling:**

If a record's name changes (e.g., a project gets renamed), the Dropbox folder rename is handled by a scheduled reconciliation Lambda that runs nightly to bring Dropbox folder names in line with current record names. This avoids generating excessive Dropbox API calls in real-time.

---

## Versioning

S3 versioning is enabled on the `sfsolproj` bucket (already in place via XFiles Pro's existing setup). When a user uploads a new file with the same name to the same folder, S3 retains the previous version.

- **Default UI behavior:** Show only the current version
- **Admin view:** Tim can access all versions via S3 directly or a future portal admin tool
- **Metadata table:** Tracks `s3_version_id` of the current version; previous versions accessible via S3 API

---

## Security

- **No public bucket access.** All file access is via Lambda-generated presigned URLs.
- **Presigned URL expiration:** 15 minutes for both PUT and GET URLs.
- **Tenant isolation:** Lambda enforces `tenant_id` match between authenticated user and requested file before generating any URL.
- **IAM roles:** Lambda has bucket-scoped permissions; XFiles Pro has separate read-only role; Dropbox sync Lambda has its own role.
- **Encryption at rest:** S3 SSE-S3 (server-side encryption with S3-managed keys) is the baseline; SSE-KMS available if Harmon requires stricter key management.
- **Encryption in transit:** All Lambda-to-S3 and browser-to-S3 traffic is TLS.

---

## Implementation Phase

File storage is **Phase 1 foundational infrastructure**. Phase 1 delivers:

- S3 bucket setup with versioning and lifecycle policies
- Supabase `sundial_file_metadata` table
- Five core Lambda functions (`list-files`, `upload-file`, `download-file`, `delete-file`, `list-related-files`)
- Portal Files tab on Sundial_Customer__c, Sundial_Solar__c, Sundial_Roofing__c, and Sundial_PO__c records
- Dropbox sync Lambda triggered on S3 PUT
- XFiles Pro configuration for the Sundial_* objects active in Phase 1

Phase 2 adds:
- Files tab on Sundial_Service__c and Sundial_Service_Visit__c
- Photo capture from the PWA writing to the appropriate S3 folders

Phase 3 adds:
- Files tab on Sundial_Commercial__c
- Any commercial-specific file organization patterns

---

## Operational Concerns

### Bucket Cost
S3 storage is inexpensive for the volume Harmon will generate. Even at 100GB of files, monthly cost is single-digit dollars. Lifecycle policy moves files older than 1 year to S3 Infrequent Access for further savings.

### Dropbox API Limits
Dropbox API has per-app rate limits. The sync Lambda batches operations where possible and respects rate limit headers. Sustained high-volume uploads could throttle; in that case, the Lambda queues into SQS for paced processing.

### Backup
S3 versioning is the primary safety net. Additionally, a cross-region replication can be enabled if Harmon requires geographic redundancy (not enabled by default; adds cost).

### Monitoring
CloudWatch metrics on:
- File upload count and volume per tenant
- Dropbox sync success rate
- Presigned URL generation rate
- Failed access attempts

Alerts on:
- Dropbox sync DLQ messages (immediate investigation)
- Bucket size approaching configured threshold
- Unusually high access volume from a single tenant (possible runaway query)
