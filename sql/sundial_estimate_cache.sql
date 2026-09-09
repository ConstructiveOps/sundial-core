-- sundial_estimate_cache — Supabase cache table for Sundial_Estimate__c (Service Estimate, D-072).
--
-- Mirrors the sundial_roofing_cache pattern: the display subset the portal's list/board/
-- grid surfaces render, plus the standard control columns every Sundial cache table
-- carries. Detail views use GET /sf/estimate/{id}?full=true (describe-driven, live).
--
-- HOW THIS POPULATES: column NAMES match sfFieldToColumn() (strip __c, lowercase;
-- reference fields get _sf_id). The read and sync Lambdas select ONLY Salesforce fields
-- whose mapped column exists here, so creating this table makes estimate records populate via
-- read-through and the scheduled sundial-cache-sync job. Add a column later and it starts
-- caching. GENERATED from the same spec as the .object files - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL;
-- tenant_id is the human slug (label only).

create table if not exists sundial_estimate_cache (
  -- Control / identity
  sf_id                                  text primary key,          -- Salesforce record Id
  client_sf_id                           text not null,             -- Client__c (tenant isolation key)
  tenant_id                              text,                      -- Client__r.Name slug (label only)

  -- Display subset
  name                                   text,        -- Name (auto-number)
  sundial_customer_sf_id                 text,        -- Sundial_Customer__c (Required unless Is_Template__c (templates have no customer; ...)
  service_job_sf_id                      text,        -- Service_Job__c (The 1:1 pair. Null while the estimate is a proposal with no ...)
  customer_name_at_creation              text,        -- Customer_Name_at_Creation__c (Snapshot at record creation (standard snapshot pattern).)
  address_at_creation                    text,        -- Address_at_Creation__c (Snapshot at record creation.)
  primary_phone_at_creation              text,        -- Primary_Phone_at_Creation__c (Snapshot at record creation.)
  primary_email_at_creation              text,        -- Primary_Email_at_Creation__c (Snapshot at record creation.)
  originating_solar_project_sf_id        text,        -- Originating_Solar_Project__c (System being quoted on (no Asset object, D-065.1).)
  originating_roofing_project_sf_id      text,        -- Originating_Roofing_Project__c
  originating_commercial_project_sf_id   text,        -- Originating_Commercial_Project__c (Phase 3 object - REMOVE from the package if Sundial_Commerci...)
  sold_by_sf_id                          text,        -- Sold_By__c (Commission attribution (with Markup below). Blank = office/n...)
  is_template                            boolean,     -- Is_Template__c (True = a named line set (Paige's Fronius/removal-reinstall/E...)
  template_name                          text,        -- Template_Name__c (Display name in the template picker.)
  status                                 text,        -- Status__c (Draft -> Sent -> (Viewed) -> Approved | Declined | Expired; ...)
  version                                numeric,     -- Version__c (Incremented on every Send. 0 = never sent.)
  last_sent_at                           timestamptz, -- Last_Sent_At__c
  last_sent_via                          text,        -- Last_Sent_Via__c
  last_viewed_at                         timestamptz, -- Last_Viewed_At__c (Hosted page opened (token hit).)
  approved_at                            timestamptz, -- Approved_At__c
  approved_version                       numeric,     -- Approved_Version__c (Which sent version the customer approved.)
  approved_amount                        numeric,     -- Approved_Amount__c (Total of the approved version (frozen - Total__c keeps movin...)
  approval_method                        text,        -- Approval_Method__c (Online = accept button on the hosted page; Verbal = office l...)
  approved_by_name                       text,        -- Approved_By_Name__c (Typed name on the hosted page, or the office user for Verbal...)
  declined_reason                        text,        -- Declined_Reason__c
  valid_until                            date,        -- Valid_Until__c (Send date + tenant validity days (GET FROM HARMON: the numbe...)
  reminder_1_sent_at                     timestamptz, -- Reminder_1_Sent_At__c (+3d reminder (tenant config).)
  reminder_2_sent_at                     timestamptz, -- Reminder_2_Sent_At__c (+5d reminder; after this the estimate hands off to the NSA d...)
  labor_subtotal                         numeric,     -- Labor_Subtotal__c (Sum of Labor-kind lines + labor portion of Product lines. La...)
  material_subtotal                      numeric,     -- Material_Subtotal__c (Sum of Material-kind lines + material portion of Product lin...)
  fee_subtotal                           numeric,     -- Fee_Subtotal__c (Sum of Fee-kind lines.)
  subtotal                               numeric,     -- Subtotal__c (Labor + Material + Fee, before discount/markup/tax.)
  discount_scope                         text,        -- Discount_Scope__c (Which subtotal the discount applies to (labor-only / materia...)
  discount_type                          text,        -- Discount_Type__c
  discount_value                         numeric,     -- Discount_Value__c (The percent (10 = 10%) or the dollar amount, per Discount_Ty...)
  discount_amount                        numeric,     -- Discount_Amount__c (Computed dollars off.)
  discount_source                        text,        -- Discount_Source__c (Service Plan = applied automatically from the customer's act...)
  markup_type                            text,        -- Markup_Type__c (Hidden from the customer - only the total shows. Tim's commi...)
  markup_value                           numeric,     -- Markup_Value__c
  markup_amount                          numeric,     -- Markup_Amount__c (Computed dollars added (never printed as a line).)
  tax_rate                               numeric,     -- Tax_Rate__c (Resolved from the service-address city via the per-tenant AZ...)
  tax_jurisdiction                       text,        -- Tax_Jurisdiction__c (City/rate label used, for the printed document.)
  tax_amount                             numeric,     -- Tax_Amount__c (Tax over Taxable lines after discount/markup allocation.)
  total                                  numeric,     -- Total__c (Subtotal - Discount + Markup + Tax. The number the customer ...)
  deposit_required                       boolean,     -- Deposit_Required__c (When true the hosted page charges the deposit at acceptance ...)
  deposit_type                           text,        -- Deposit_Type__c
  deposit_value                          numeric,     -- Deposit_Value__c
  deposit_amount                         numeric,     -- Deposit_Amount__c (Computed from Deposit_Type/Value against Total.)
  deposit_paid_at                        timestamptz, -- Deposit_Paid_At__c (Mirrors the Deposit-type Service Payment.)
  created_in_field                       boolean,     -- Created_In_Field__c (True when a tech created/extended it from the PWA (field est...)
  created_by_service_call_sf_id          text,        -- Created_By_Service_Call__c (The visit during which the tech created the estimate.)

  created_date                           timestamptz, -- CreatedDate (list ordering)
  last_synced_at                         timestamptz not null default now(),
  cache_version                          integer not null default 1,
  is_stale                               boolean not null default false
);

create index if not exists idx_sundial_estimate_cache_tenant
  on sundial_estimate_cache (client_sf_id);
create index if not exists idx_sundial_estimate_cache_customer
  on sundial_estimate_cache (client_sf_id, sundial_customer_sf_id);
create index if not exists idx_sundial_estimate_cache_job
  on sundial_estimate_cache (client_sf_id, service_job_sf_id);
create index if not exists idx_sundial_estimate_cache_status
  on sundial_estimate_cache (client_sf_id, status);
create index if not exists idx_sundial_estimate_cache_template
  on sundial_estimate_cache (client_sf_id, is_template) where is_template = true;
create index if not exists idx_sundial_estimate_cache_recent
  on sundial_estimate_cache (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_sundial_estimate_cache_stale
  on sundial_estimate_cache (client_sf_id, is_stale) where is_stale = true;
