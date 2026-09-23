# The Customer in the Service module — layout schema (2026-09-23)

**Status:** built 2026-09-23 (D-075). The Sales module keeps its Solar-centric Customer
page untouched; the Service module gets its own Customers tab, list, board and a smaller
detail page, all reading and writing the SAME `Sundial_Customer__c` record.

## What Harmon uses it for

Service's Customer is the **pre-estimate record**: every incoming contact — a call, an
email, a web form, an existing solar customer with a question — lands here first and
stays here until it is either **resolved without a job** (answered on the phone, referred
to the manufacturer or the finance partner, handed to another department) or **turns
into an estimate** (and then a job). The office keeps most of them as **Leads** until an
estimate is warranted, assigns the next step to a person in any department, and tracks
open / unresolved requests by stage, assignee and follow-up date. Tim's Salesforce Flows
handle the reminders off `Last_Contact_Date__c`, `Next_Follow_Up_Date__c` and
`Assigned_To__c`; nothing in the portal sends a reminder.

Two questions the layout answers every time the page opens: **what did they need, and
whose move is it?**

## Rules

1. **One record, two views.** The Service page shows a subset of `Sundial_Customer__c`;
   it never copies data anywhere. A field edited here is edited for Sales too. The
   solar pipeline (adders, budget, commissions, appointment, proposal, contract) is
   simply not on this page.
2. **The Service list is the customers tagged Service** (`Customer_Type__c` includes
   `Service`). The search box reaches the whole hub; an untagged customer who calls in
   (an old solar customer) is opened in the Service view and tagged with the **Add to
   Service** button, which also stamps `Service_Stage__c = New`. Every customer created
   from the Service module (New Customer / New Estimate / New Job / the Club join) is
   tagged on creation, as before.
3. **`Status__c` stays the hub's lifecycle** (Lead / Opportunity / Customer / Past
   Customer) and `Stage__c` stays the solar sales pipeline. The Service pipeline is its
   own field, `Service_Stage__c`, so nothing Service does shows up in a Sales dropdown.
4. **Assigned To is a person's name, never an id.** `Assigned_To__c` is a lookup to
   `Sundial_User__c`; the list joins it to the tenant's user list in the browser, the
   detail page shows a dropdown of every active user in every department.
5. **Files and Comments are the hub's** — the same `FilesPanel` (`SUNDIAL/{customerId}/`)
   and `CommentsPanel` (`record_object = 'customer'`) the Sales page uses, so the solar
   install's documents and notes are one click away when a service question comes in.
6. **Nothing new is invented where a field exists.** Four fields are added (below);
   everything else on the page is an existing field, relabelled where Service reads it
   differently.

## New fields (package `salesforce/service-customer-2026-09-23/`)

| Field | Type | Values / notes |
|---|---|---|
| `Service_Stage__c` | Picklist | **New** · Contact Attempt Made · In Progress · Waiting on Customer · Waiting on Other Department · Estimate Created · Resolved · Closed. The board's columns. Set to New by every Service create and by Add to Service; the office moves it. |
| `Service_Request_Type__c` | Picklist | System Not Producing · Monitoring Offline · Inverter / Equipment Fault · Battery Issue · Roof Leak · Panel Damage · Removal & Reinstall · Electrical / Panel Upgrade · Add-On (Battery, EV Charger, Panels) · Maintenance / Cleaning · Billing or Finance Question · Warranty Question · General Question · Other |
| `Service_Resolution__c` | Picklist | Resolved by Phone · Referred to Manufacturer · Referred to Finance Partner · Referred to Another Department · Estimate Created · Job Created · Not Interested · No Response · Duplicate · Other. How an open request ended; empty while it is open. |
| `Service_Resolved_Date__c` | Date | When it ended — the Flow's "closed" signal and the report's cycle time. |

Cache columns (`sql/2026-09-23_service_customer.sql`): `service_stage`, `service_request_type`,
`service_resolution`, `service_resolved_date`, plus the existing fields the list needs that
the cache did not carry: `assigned_to_sf_id`, `assigned_date`, `last_contact_date`,
`next_follow_up_date`, `follow_up_needed`, `primary_email` (already there), `description`.
`sundial-cache-sync` fills any column whose name matches the field, so the columns are the
whole change — then one full resync of `customer`.

## The list and the board (`/service/customers`)

Columns: **Name · Address · Status · Service Stage · Request Type · Lead Source ·
Assigned To · Next Follow-Up · Last Contact**. Sorted by most recently updated (the
hub's `created_date` rule), then by next follow-up when the "Follow-ups" filter is on.

Filters: Service Stage (default **Open** = everything but Resolved / Closed), Status,
Assigned To (any user, "Unassigned", "Mine"), Request Type; search (name / phone / email /
address, the whole hub). Toolbar: **New Customer** (the same form as the New Estimate
popup's customer half, address lookup and duplicate check included — creates the customer
alone, tagged Service, Stage New, and opens it), **New Estimate**, **New Job**.

Board: one column per `Service_Stage__c` value (empty columns hidden by the same switch
the Sales board has); a card shows name, address, request type, assigned-to and next
follow-up, with an overdue follow-up marked. Drag between columns is a later addition —
the stage is changed on the page for now.

## The detail page (`/service/customers/{id}`)

**Header band:** name (First + Last, else Name) · `Status__c` chip · `Service_Stage__c`
chip · Service Club badge (`Active_Membership__c`) · `Do_Not_Contact__c` / `Do_Not_Call__c`
warnings · phone (tel: link) · email (mailto:) · address (maps link) · Lead Source ·
**Assigned To** (name) · Next follow-up (overdue in red). Buttons, in this order:
**Create Estimate**, **Create Job** (the existing popup with this customer pre-picked),
**Add to Service** (only when untagged), **Edit**. Under it the related-records bar:
Estimates · Service Jobs · Solar Projects · Roofing Projects · Service Club.

**Side tabs** (a `dl` of fields, view / edit like the Sales page; `*` = the fields the
office actually types on most contacts):

### 1. Request (default tab)
| Field | Label on the page | Notes |
|---|---|---|
| `Service_Request_Type__c` * | What they need | new |
| `Description__c` * | The request | long text — what the customer said, in their words; carried onto the estimate's job description by hand for now |
| `Service_Stage__c` * | Service stage | new |
| `Assigned_To__c` * | Assigned to | user dropdown; writes the lookup |
| `Assigned_Date__c` | Assigned on | date |
| `Next_Follow_Up_Date__c` * | Next follow-up | date; the Flow's reminder anchor |
| `Last_Contact_Date__c` * | Last contact | date |
| `Follow_Up_Needed__c` | Follow-up needed | checkbox |
| `Call_Attempts__c` | Call attempts | number |
| `Outreach_Notes__c` * | Contact log | long text — one line per attempt / conversation, newest on top |
| `Service_Resolution__c` | Resolution | new; picklist |
| `Service_Resolved_Date__c` | Resolved on | new; date |
| `Status__c` | Customer status | Lead / Opportunity / Customer / Past Customer |
| `Customer_Type__c` | Departments | read-only chips |
| `Lead_Source__c` | Lead source | picklist |
| `Lead_Sub_Source__c` | Lead sub-source | text |
| `Referred_By__c` | Referred by | text |
| `Lead_Date__c` | Lead date | date |
| `First_Contact_Date__c` | First contact | date |

### 2. Contact
`First_Name__c` · `Last_Name__c` · `Primary_Phone__c` · `Secondary_Phone__c` ·
`Primary_Email__c` · `Preferred_Contact_Method__c` · `Best_Time_to_Contact__c` ·
`Preferred_Language__c` · `Co_Owner_Name__c` · `Co_Owner_Phone__c` · `Co_Owner_Email__c` ·
`Alternate_Contact_Name__c` · `Alternate_Contact_Phone__c` · `Alternate_Contact_Email__c` ·
`Do_Not_Contact__c` · `Do_Not_Call__c`

### 3. Property
`Street__c` · `City__c` · `State__c` · `Postal_Code__c` · `County__c` · `Property_Type__c` ·
`Stories__c` · `Year_Built__c` · `Roof_Type__c` · `Fence_Gate_Code__c` ·
`Equipment_Behind_Fence__c` · `Mailing_Address_Differs__c` · `Mailing_Street__c` ·
`Mailing_City__c` · `Mailing_State__c` · `Mailing_Postal_Code__c` (mailing fields only when
"differs" is ticked — the same `visibleWhen` rule the Sales config has) · `Parcel_Number__c` ·
`AHJ__c`

### 4. System & Accounts (what is installed, who else is involved)
`Existing_Solar_System__c` · `Existing_Panel_Count__c` · `Final_System_Size_kW__c` ·
`Final_Panel_Count__c` · `Proposed_Panel_Type__c` (label "Panel model") ·
`Inverter_Type__c` · `Inverter_Quantity__c` · `Battery_Type__c` · `Battery_Qty__c` ·
`Project_Type__c` · `Mounting__c` · `Active_System_Monitoring__c` ·
`Harmon_Documents_Signed_Date__c` (label "Contract signed") · `Sold_Date__c` ·
`Sales_Company__c` · `Sales_Rep_Name__c` (read-only) · `Financing_Type__c` ·
`Financing_Partner__c` · `Leasing_Partner__c` · `Utility_Company__c` ·
`Utility_Account_Number__c` · `Utility_Meter__c` · `Utility_Rate_Plan__c` ·
`APS_Reservation_Number__c` · `Linked_Solar_Project__c` (read-only; the related bar is the
link) — all read-only on this page except monitoring, utility and the existing-system
pair: the installed system is the solar project's fact, Service reads it.

### 5. Files — `FilesPanel` on the customer (the Sales page's).
### Comments — the persistent right-hand `CommentsPanel`, on every tab.

## Access

Office scope (`tenant`) reads and writes through the existing `GET /sf/customer/{id}?full=true`
and `PATCH /sf/customer/{id}` (describe-gated, formula fields refused). The list is
`GET /sf/customer?field=Customer_Type__c&value=Service&op=includes` (new `op`: a
multi-select INCLUDES on the cache and the live path alike). A Technician's view of a
customer stays what it is (`/tech/customers`, read-only); this page is the office's.
Standalone create: `POST /service/customers` (`service.estimate.write`) — the popup's
`customer.new` shape, the same duplicate guard and tagging as New Estimate, plus
`Service_Stage__c = New` when the org has the field.
