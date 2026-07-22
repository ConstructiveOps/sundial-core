# Sundial — Salesforce Schema

> Full schema reference for the Sundial platform's Salesforce data model.
> Update this file as objects, fields, or relationships change.

---

## Naming Convention

All Sundial custom objects use the `Sundial_` prefix. All custom field API names use snake_case with `__c` suffix per Salesforce convention. Field labels are human-readable (no underscores).

Examples:
- Object: `Sundial_Customer__c` (label: "Customer")
- Field: `Customer_Name_at_Creation__c` (label: "Customer Name at Creation")

---

## Custom Object Catalog

### `Sundial_Tenant__c`

**Purpose:** Tenant anchor for the multi-client model. Each Sundial client (tenant) gets exactly one `Sundial_Tenant__c` record. The `Client__c` lookup on every other Sundial object points to this object, making it the single per-tenant isolation anchor.

**Key Fields:**
- `Name` — Standard Name field holds the tenant slug. The first record is named `harmon`, matching `VITE_TENANT_ID`, the S3 tenant prefix, and the `client-config.ts` tenant identifier.

**Intentionally minimal:** No fields beyond the standard `Name` for now. The object exists to provide a stable, dedicated tenant identity (a tenant is not a person), separate from the user/permission model. Additional tenant metadata fields can be added later if needed.

**Relationships:**
- Referenced by every Sundial object via the `Client__c` lookup (the per-tenant isolation anchor).

**Note:** This supersedes the earlier approach in which the tenant was effectively the top-level `Sundial_User__c` record (`Hierarchy_Level__c` = "Client"). The "Client" hierarchy level still exists as a user permission tier, but it is a separate concept from tenant ownership. See DECISIONS.md D-034.

---

### `Sundial_User__c`

**Purpose:** Represents portal users (Harmon employees, dealers, sales reps) and their organizational hierarchy. Does NOT represent Salesforce login users; Harmon users authenticate via Supabase.

**Key Fields:**
- `Hierarchy_Level__c` — Picklist: Client, Dealer, Sales Manager, Sales Rep
- `Parent_User__c` — Lookup to `Sundial_User__c` (self-referential, the user above in the hierarchy)
- `Supabase_User_Id__c` — External ID, links to Supabase auth user record
- `First_Name__c` — Text
- `Last_Name__c` — Text
- `Email__c` — Email
- `Phone__c` — Phone
- `Active__c` — Checkbox
- `Client__c` — Lookup to `Sundial_Tenant__c` (the tenant anchor; "harmon" record), used for sharing scope across multi-client deployments. (Previously pointed to the top-level `Sundial_User__c` org record; superseded by `Sundial_Tenant__c` per DECISIONS.md D-034. API name unchanged: `Client__c`.)
- `Default_Department__c` — Picklist: Residential Solar, Roofing, Service, Commercial (controls portal landing experience)
- `Roles__c` — Multi-select picklist for cross-departmental access (Dispatcher, Office Admin, PM, Sales Rep, etc.)

**Relationships:**
- Self-lookup via `Parent_User__c`
- Referenced by every project object as `Sales_Rep__c`, `Project_Manager__c`, `Assigned_Tech__c`, etc.

---

### `Sundial_Customer__c`

**Purpose:** Customer and address hub. Single record represents an address and the current occupant/contact. Serves as Lead, Opportunity, and ongoing Customer record throughout the lifecycle. New person at same address or existing person at new address updates this record; historical accuracy is preserved via the snapshot pattern on project records.

**Key Fields:**
- `Name` — Text (standard record Name field; holds the current occupant/contact name. NOT a `Customer_Name__c` custom field — corrected 2026-07-21 after the Acumatica push read the wrong API name)
- `Street__c` — Text
- `City__c` — Text
- `State__c` — Picklist or text
- `Postal_Code__c` — Text
- `Country__c` — Picklist (default US)
- `Primary_Phone__c` — Phone
- `Primary_Email__c` — Email
- `Alternate_Contact_Name__c` — Text
- `Alternate_Contact_Phone__c` — Phone
- `Alternate_Contact_Email__c` — Email
- `Status__c` — Picklist: Lead, Opportunity, Customer, Past Customer
- `Lead_Source__c` — Picklist
- `Lead_Date__c` — Date
- `First_Contact_Date__c` — Date
- `Active__c` — Checkbox
- `Client__c` — Lookup to `Sundial_Tenant__c` (tenant anchor) for sharing scope
- `Notes__c` — Long text

**Relationships:**
- One-to-many with `Sundial_Solar__c`, `Sundial_Roofing__c`, `Sundial_Commercial__c`, `Sundial_Service__c`
- One-to-many with standard `Asset` records (installed systems via custom lookup field on Asset)

**Important Note:** When ownership changes or address corrections happen, this record is updated in place. The project records' snapshot fields preserve "who was here when this work was done."

---

### `Sundial_Solar__c`

**Purpose:** Residential solar projects.

**Key Architectural Fields (this object will have hundreds of fields total; this section lists the architecturally important ones):**

*Identity and snapshot:*
- `Project_Name__c` — Text
- `Sundial_Customer__c` — Lookup to `Sundial_Customer__c` (required, the current customer)
- `Customer_Name_at_Creation__c` — Snapshot, populated at record creation
- `Address_at_Creation__c` — Snapshot (full address concatenated or use separate snapshot fields)
- `Primary_Phone_at_Creation__c` — Snapshot
- `Primary_Email_at_Creation__c` — Snapshot

*Stage and assignment:*
- `Stage__c` — Picklist driving the sales/install pipeline
- `Sales_Rep__c` — Lookup to `Sundial_User__c`
- `Project_Manager__c` — Lookup to `Sundial_User__c`
- `Client__c` — Lookup to `Sundial_Tenant__c` (tenant anchor)

*System specs:*
- `System_Size_kW__c` — Number
- `Number_of_Panels__c` — Number
- `Inverter_Type__c` — Picklist
- `Battery_Included__c` — Checkbox
- `Battery_Capacity_kWh__c` — Number

*Budget (background calculation from Harmon's calculator):*
- `Project_Budget__c` — Currency (calculated)
- `Estimated_Material_Cost__c` — Currency
- `Estimated_Labor_Cost__c` — Currency
- `Target_Margin__c` — Percent
- `Calculated_Sale_Price__c` — Currency

*Integration:*
- `Acumatica_Project_Id__c` — Text, External ID
- `Solar_Project_Id__c` — Lookup or text reference to existing `Solar_Project__c` when synced for CO operations
- `Synced_to_Solar_Project__c` — Checkbox
- `Last_Sync_Date__c` — Datetime

*Related projects:*
- `Linked_Roofing_Project__c` — Lookup to `Sundial_Roofing__c` (when reroof is part of solar install)

*Plus hundreds of operational and stage-specific fields managed in Salesforce Setup.*

---

### `Sundial_Roofing__c`

**Purpose:** Roofing projects. Used for roofing-only work (residential or commercial), and as the linked reroof record when a solar project includes a reroof.

**Key Architectural Fields:**
- `Project_Name__c` — Text
- `Sundial_Customer__c` — Lookup, required
- Snapshot fields (same pattern as solar)
- `Project_Type__c` — Picklist: Residential, Commercial, Reroof for Residential Solar, Reroof for Commercial Solar
- `Stage__c` — Picklist
- `Sales_Rep__c` — Lookup to `Sundial_User__c`
- `Project_Manager__c` — Lookup to `Sundial_User__c`
- `Roof_Type__c` — Picklist (asphalt, tile, metal, etc.)
- `Square_Footage__c` — Number
- `Layers_to_Remove__c` — Number
- `Decking_Replacement_Needed__c` — Checkbox
- `Linked_Solar_Project__c` — Lookup to `Sundial_Solar__c` (when part of a solar install)
- `Linked_Commercial_Project__c` — Lookup to `Sundial_Commercial__c` (when part of a commercial install)
- `Acumatica_Project_Id__c` — External ID
- `Client__c` — Lookup to `Sundial_Tenant__c` (tenant anchor)

*Plus hundreds of fields for material specifications, inspection results, warranty terms, etc.*

---

### `Sundial_Commercial__c`

**Purpose:** Commercial solar projects. Longer cycles, progress billing, change orders, AIA documentation.

**Key Architectural Fields:**
- `Project_Name__c` — Text
- `Sundial_Customer__c` — Lookup, required
- Snapshot fields
- `Stage__c` — Picklist
- `Sales_Rep__c` — Lookup to `Sundial_User__c`
- `Project_Manager__c` — Lookup to `Sundial_User__c`
- `System_Size_kW__c` — Number
- `Progress_Billing_Enabled__c` — Checkbox
- `AIA_Documentation_Required__c` — Checkbox
- `Retainage_Percent__c` — Percent
- `Linked_Roofing_Project__c` — Lookup to `Sundial_Roofing__c`
- `Acumatica_Project_Id__c` — External ID
- `Client__c` — Lookup to `Sundial_Tenant__c` (tenant anchor)

**Milestone fields (for Gantt view):**

Commercial projects follow a predictable lifecycle of named milestones. Rather than a child Milestone object, each milestone is represented by a set of fields directly on `Sundial_Commercial__c`. This keeps the data model flat, reportable, and within the 500-field budget while supporting the Gantt visualization in Phase 3.

For each of the following milestones, the object has four fields: `{Milestone}_Start__c` (Date), `{Milestone}_End__c` (Date), `{Milestone}_Status__c` (Picklist: Not Started, In Progress, Complete, Blocked, Cancelled), and `{Milestone}_Percent_Complete__c` (Percent).

Milestones:
- Site_Assessment
- Design_Development
- Permitting
- Procurement
- Construction
- Commissioning
- PTO
- Closeout

Total milestone fields: 8 milestones × 4 fields = 32 fields.

Additionally:
- `Critical_Path_Notes__c` — Long text for project manager commentary on dependencies and risks
- `Overall_Project_Percent_Complete__c` — Formula or stored field aggregating milestone completion

**Gantt Visualization:**

The Phase 3 Commercial dashboard renders a Gantt view by querying the milestone date/status/percent fields directly. No child object traversal needed. The Gantt library (Frappe Gantt or similar) accepts the milestones as a flat array of bars with start/end/percent attributes.

This pattern is Commercial-only. Residential Solar and Roofing projects use the standard `Stage__c` picklist and do not require Gantt visualization.

*Plus hundreds of additional fields for commercial-specific contract terms, change order tracking, etc., to be defined during Phase 3 discovery.*

---

### `Sundial_Service__c`

**Purpose:** Service ticket. Parent record for all service work. Children are individual visits.

**Cross-Module Tie:** Solar, Roofing, and Commercial projects flow into Service after PTO for future warranty and follow-up work. Service tickets carry lookups back to the originating project(s) so service techs can see project history, system specs, and prior work without leaving the ticket.

**Key Architectural Fields:**

*Identity and snapshot:*
- `Ticket_Number__c` — Auto-number
- `Sundial_Customer__c` — Lookup, required
- Snapshot fields (same pattern as solar projects)
- `Installed_System__c` — Lookup to standard `Asset` (when service is on a known system)

*Originating project links (cross-module ties):*
- `Originating_Solar_Project__c` — Lookup to Sundial_Solar__c (when this service is for a solar system installed by Harmon)
- `Originating_Commercial_Project__c` — Lookup to Sundial_Commercial__c (when service is for a commercial solar installation)
- `Originating_Roofing_Project__c` — Lookup to Sundial_Roofing__c (when service is warranty work on a roof installed by Harmon)
- These lookups enable the PWA to show "this is a warranty service on the install completed on [date]" context, surface system specs from the original project, and link to the install photos in the file system.

*Origin (intake):*
- `Intake_Channel__c` — Picklist: Phone, Email, Web Form, Monitoring Alert, Manufacturer Referral, Leasing Company, Online Booking
- `Intake_Date__c` — Datetime
- `Source_Email_From__c` — Email (for manufacturer/leasing intake)
- `Source_Email_Reference__c` — Text (case/ticket reference from sender)

*Triage and assignment:*
- `Priority__c` — Picklist: Low, Standard, High, Emergency
- `Status__c` — Picklist: New, Triaging, Remote Investigation, Scheduled, In Progress, Awaiting Parts, Awaiting Office Review, Ready to Bill, Invoiced, Paid, Closed
- `Service_Type__c` — Picklist: Warranty, Paid Service, Monitoring Follow-up, Maintenance, Upgrade
- `System_Ownership__c` — Picklist: Customer Owned, Leased, Third-Party Owned

*Work description:*
- `Issue_Description__c` — Long text
- `Initial_Remote_Diagnosis__c` — Long text

*Roll-ups from visits:*
- `Total_Visit_Count__c` — Computed by trigger/Flow from related `Sundial_Service_Visit__c` records where Visit_Type = Service
- `Total_Time_Minutes__c` — Computed by trigger/Flow
- `Total_Materials_Cost__c` — Computed by trigger/Flow

*Billing:*
- `Estimated_Cost__c` — Currency
- `Final_Cost__c` — Currency
- `Customer_Card_on_File__c` — Checkbox (Stripe customer reference exists)
- `Stripe_Customer_Id__c` — External ID
- `Stripe_Payment_Intent_Id__c` — Text
- `Payment_Status__c` — Picklist
- `Acumatica_Invoice_Id__c` — External ID
- `Client__c` — Lookup to `Sundial_Tenant__c` (tenant anchor)

---

### `Sundial_Service_Visit__c`

**Purpose:** Individual visit (on-site or remote) associated with field work. Used for service work AND for solar/roofing/commercial install crew time tracking. Same object, same GPS/clock fields, displayed differently in different areas of the PWA based on `Visit_Type__c`.

**Relationship to Parents:** The parent relationship is contextual. The object has lookups to all four project objects plus the service ticket; exactly one is populated per record, enforced by a validation rule. This trade-off (lookup rather than master-detail) gives us multi-purpose use of a single object at the cost of master-detail roll-up summaries. Roll-ups to the parent are handled by Apex triggers or Flow on visit close.

**Key Fields:**
- `Visit_Number__c` — Auto-number across all visits
- `Visit_Type__c` — Picklist: Service, Solar Install, Roofing Install, Commercial Install. Required. Drives validation logic for which parent lookup is required and which UI tab in the PWA displays the visit.
- `Sundial_Service__c` — Lookup to Sundial_Service__c (required when Visit_Type = Service)
- `Sundial_Solar__c` — Lookup to Sundial_Solar__c (required when Visit_Type = Solar Install)
- `Sundial_Roofing__c` — Lookup to Sundial_Roofing__c (required when Visit_Type = Roofing Install)
- `Sundial_Commercial__c` — Lookup to Sundial_Commercial__c (required when Visit_Type = Commercial Install)
- `Tech__c` — Lookup to `Sundial_User__c`
- `Additional_Techs__c` — Multi-record relationship handled by parallel `Sundial_Service_Visit__c` records (each tech on a multi-tech visit gets their own record, all sharing the same parent and time window)
- `Visit_Sub_Type__c` — Picklist: On-Site, Remote, Office Work (for service); In-Field, Travel, Prep (for installs)
- `Scheduled_Start__c` — Datetime
- `Scheduled_End__c` — Datetime
- `Actual_Start__c` — Datetime (set by clock-in)
- `Actual_End__c` — Datetime (set by clock-out)
- `Duration_Minutes__c` — Formula or stored, calculated from actual times
- `Clock_In_Latitude__c` — Number
- `Clock_In_Longitude__c` — Number
- `Clock_Out_Latitude__c` — Number
- `Clock_Out_Longitude__c` — Number
- `Geofence_Verified__c` — Checkbox (true if clock in/out within configured radius of the relevant address)
- `Notes__c` — Long text (tech's notes from this visit)
- `Work_Performed__c` — Long text (service-specific; surfaced only when Visit_Type = Service)
- `Install_Milestones_Completed__c` — Long text or multi-select (install-specific; surfaced only when Visit_Type is an Install type)
- `Materials_Used__c` — Related list of material usage records, or JSON field
- `Photos_Count__c` — Number (count of attached files)
- `Status__c` — Picklist: Scheduled, In Progress, Complete, Cancelled, No-Show

**Validation Rule:** Exactly one of the four parent lookups must be populated, and it must match the `Visit_Type__c` value (Service → Sundial_Service__c, Solar Install → Sundial_Solar__c, etc.).

**PWA Display Logic:**
The PWA has separate tabs/sections for Service and for Install. When a tech opens a visit:
- Under the Service tab: Surface service-related fields (Work_Performed, service ticket details, customer history)
- Under the Solar/Roofing/Commercial tabs: Surface install-related fields (Install_Milestones_Completed, project details, install address)
- GPS, clock in/out, notes, and photo capture are identical across all contexts

---

### `Sundial_PO__c`

**Purpose:** Purchase orders. Created in Sundial, mirrored to Acumatica. Tracks credits via child `Sundial_PO_Credit__c` records.

**Key Fields:**
- `PO_Number__c` — Auto-number or text from Acumatica
- `Acumatica_PO_Id__c` — External ID
- `Vendor_Account__c` — Lookup to standard `Account` (vendors held in standard Account with a "Vendor" record type) OR custom `Sundial_Vendor__c` if we decide to keep vendors out of standard Account
- `Linked_Solar_Project__c` — Lookup to `Sundial_Solar__c` (one of the four project lookups will be populated)
- `Linked_Roofing_Project__c` — Lookup to `Sundial_Roofing__c`
- `Linked_Commercial_Project__c` — Lookup to `Sundial_Commercial__c`
- `Linked_Service_Ticket__c` — Lookup to `Sundial_Service__c`
- `PO_Date__c` — Date
- `Total_Amount__c` — Currency
- `Status__c` — Picklist: Draft, Pending Sync, Synced, Received, Paid, Closed, Cancelled
- `Custom_Acumatica_Field__c` — Mirrors Harmon's custom PO field (name and contents TBD during Phase 1 discovery)
- `Created_By_User__c` — Lookup to `Sundial_User__c`
- `Notes__c` — Long text
- `Total_Credits_Amount__c` — Roll-up summary from `Sundial_PO_Credit__c`
- `Net_Amount__c` — Formula: Total_Amount minus Total_Credits_Amount
- `Client__c` — Lookup to `Sundial_Tenant__c` (tenant anchor)

---

### `Sundial_PO_Credit__c`

**Purpose:** Tracks credits and returns against POs. Solves the Acumatica gap where PO-level credit tracing does not exist natively.

**Key Fields:**
- `Sundial_PO__c` — Master-Detail to parent PO
- `Credit_Date__c` — Date
- `Credit_Amount__c` — Currency
- `Credit_Reason__c` — Picklist: Return, Damage, Pricing Error, Vendor Adjustment, Other
- `Description__c` — Text
- `Vendor_Credit_Reference__c` — Text (vendor's credit memo number)
- `Acumatica_Reference__c` — Text (if/when Acumatica gets a related AP credit record)
- `Status__c` — Picklist: Pending, Applied, Verified
- `Logged_By_User__c` — Lookup to `Sundial_User__c`

---

## Standard Objects in Use

### `Asset` (standard)

**Purpose:** Installed solar systems and other equipment at customer sites. One Asset per installed system. Links to `Sundial_Customer__c` and to the originating project record.

**Custom fields added to Asset:**
- `Sundial_Customer__c` — Lookup to `Sundial_Customer__c` (this is in addition to or instead of standard Account relationship)
- `Originating_Solar_Project__c` — Lookup to `Sundial_Solar__c`
- `Originating_Commercial_Project__c` — Lookup to `Sundial_Commercial__c`
- `System_Size_kW__c` — Number
- `Inverter_Manufacturer__c` — Picklist
- `Inverter_Model__c` — Text
- `Panel_Manufacturer__c` — Picklist
- `Panel_Count__c` — Number
- `Battery_Manufacturer__c` — Picklist (nullable)
- `Battery_Model__c` — Text
- `Battery_Capacity_kWh__c` — Number
- `Install_Date__c` — Date
- `Warranty_Inverter_Years__c` — Number
- `Warranty_Panels_Years__c` — Number
- `Warranty_Workmanship_Years__c` — Number
- `Warranty_Expiration_Date__c` — Formula

Standard `SerialNumber`, `InstallDate`, `Status` fields used per their normal Salesforce semantics where useful.

### `Pricebook2`, `Product2`, `PricebookEntry` (standard)

**Purpose:** Service price book. Office staff add/update products and prices; service tickets reference products on line items.

Used per standard Salesforce patterns. Single standard price book is fine for Sundial v1.

---

## Snapshot Pattern (Implementation Detail)

When any project record (`Sundial_Solar__c`, `Sundial_Roofing__c`, `Sundial_Commercial__c`, `Sundial_Service__c`) is created with a `Sundial_Customer__c` lookup, a Flow fires on create that copies the following from the linked Customer to the project record:

- `Customer_Name_at_Creation__c` ← `Sundial_Customer__c.Name`
- `Address_at_Creation__c` ← formatted from Customer's address fields
- `Primary_Phone_at_Creation__c` ← `Sundial_Customer__c.Primary_Phone__c`
- `Primary_Email_at_Creation__c` ← `Sundial_Customer__c.Primary_Email__c`

These snapshot fields are set once at creation and never updated automatically. They give historical accuracy if the Customer record later changes. The lookup to the current `Sundial_Customer__c` remains for current-state queries.

For queries:
- "Who was the customer when this project was done?" → use snapshot fields on the project
- "Who is at this address now?" → query the linked `Sundial_Customer__c`

---

## Sundial_Solar__c → Solar_Project__c Mirror

For Sundial residential solar projects that Harmon hands off to Constructive Operations for back-office services, a Flow mirrors data into the existing `Solar_Project__c` object that the Constructive Operations internal team uses.

**Trigger:** Flow fires when `Sundial_Solar__c.Send_to_Constructive_Ops__c` (checkbox) is set to true, or on stage transition to a designated "Ready for CO" stage.

**Direction:** Primarily one-way (Sundial → Solar_Project__c) for most fields. Specific operational fields (install date confirmations, document approvals, status updates) flow back from Solar_Project__c → Sundial.

**Source of Truth:** Field-by-field policy lives in `docs/integrations/co-ops-sync.md` (to be created during Phase 1 development).

**Failure Handling:** Mirror failures land in a Salesforce-side error log; Sundial continues to function independently if the mirror fails.

---

## Sharing Architecture

Sundial data lives alongside other Constructive Operations clients in the same Salesforce org. Data isolation is achieved via:

1. **`Client__c` lookup on every relevant record.** Points to the `Sundial_Tenant__c` record representing the client organization / tenant (e.g., the "harmon" tenant). `Client__c` appears on every Sundial object as the per-tenant isolation anchor. (Previously pointed to the top-level `Sundial_User__c` org record; superseded by `Sundial_Tenant__c` per DECISIONS.md D-034. API name unchanged.)
2. **Org-wide defaults set to Private** on Sundial custom objects.
3. **Criteria-based sharing rules** based on `Client__c` field value.
4. **Sundial Integration User** owns most records by default; explicit sharing is granted to Tim (admin) and any cross-client roles.
5. **Role hierarchy within a client** uses the `Sundial_User__c.Parent_User__c` chain. Sharing logic resolves this chain to determine which records each user can see in the portal.

**Important:** Salesforce native role hierarchy is NOT used to drive Sundial user visibility because Harmon users don't have Salesforce licenses. Visibility is enforced at the portal layer based on the `Sundial_User__c.Parent_User__c` chain when constructing SOQL queries.

---

## Open Schema Decisions

These are still pending:

- **Vendor data model.** Custom `Sundial_Vendor__c` or standard `Account` with a Vendor record type. Likely Account with record type for simplicity, but confirm during Phase 1.
- **Multi-tech visit handling.** Junction object for multiple techs on one visit, or multiple parallel `Sundial_Service_Visit__c` records per ticket. Both work; decide based on reporting needs.
- **Material/inventory tracking depth.** Per-truck inventory is out of scope per Tim's prior decision. Per-job material usage will be tracked. Confirm exact data model during service module build.
- **Custom PO field name and content.** Awaiting finance discovery answer.
- **Acumatica template IDs and required field maps.** Awaiting finance discovery.
- **Hierarchy_Level__c picklist for non-Harmon clients.** Currently lists Client, Dealer, Sales Manager, Sales Rep — sufficient for Harmon. May need to expand for future tenants.
- **Aurora Solar data references.** Out of Phase 1 scope; revisit when Aurora integration is in scope.
