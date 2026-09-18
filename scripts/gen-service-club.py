"""scripts/gen-service-club.py — single source of truth for the Service Club objects
(D-073, 2026-09-18): the plan catalog and the membership row, one pointer field on the
customer hub, one on the estimate.

Run from the repo root:  python scripts/gen-service-club.py
Emits, from ONE field spec, straight into the repo:
  salesforce/service-club/{package.xml, objects/*.object, permissionsets/*.permissionset}
  sql/sundial_service_plan_cache.sql, sql/sundial_membership_cache.sql
  sql/2026-09-18_service_club.sql   (the two pointer columns on the existing caches)
  salesforce/service-club/spec.json
Change the model HERE (and in DECISIONS.md D-073), regenerate, never hand-edit outputs.

The XML / SQL helpers are a copy of the ones in gen-service-objects.py (that script
generates on import, so it cannot be imported for its helpers). Keep the two in step.
"""
import html, os, json, sys

_args = [a for a in sys.argv[1:] if not a.startswith("--")]
ROOT = _args[0] if _args else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = f"{ROOT}/salesforce/service-club"
for d in (f"{PKG}/objects", f"{PKG}/permissionsets", f"{ROOT}/sql"):
    os.makedirs(d, exist_ok=True)

def esc(s): return html.escape(s, quote=False)

TENANT = "Sundial_Tenant__c"

class F:
    def __init__(self, api, label, section, ftype, desc="", cache=True, sys=False, **kw):
        self.api, self.label, self.ftype, self.section, self.desc = api, label, ftype, section, desc
        self.cache, self.sys, self.kw = cache, sys, kw

def picklist_xml(values, default=None, restricted=True):
    vs = "\n".join(f"""                <value>
                    <fullName>{esc(v)}</fullName>
                    <default>{"true" if v == default else "false"}</default>
                    <label>{esc(v)}</label>
                </value>""" for v in values)
    return f"""        <valueSet>
            <restricted>{"true" if restricted else "false"}</restricted>
            <valueSetDefinition>
                <sorted>false</sorted>
{vs}
            </valueSetDefinition>
        </valueSet>"""

def field_xml(f):
    kw, t = f.kw, f.ftype
    p = [f"        <fullName>{f.api}</fullName>"]
    if t == "Checkbox":
        p.append(f"        <defaultValue>{'true' if kw.get('default') else 'false'}</defaultValue>")
    if t in ("Currency", "Number", "Percent") and "default" in kw:
        p.append(f"        <defaultValue>{kw['default']}</defaultValue>")
    if f.desc: p.append(f"        <description>{esc(f.desc)}</description>")
    p.append(f"        <externalId>{'true' if kw.get('externalId') else 'false'}</externalId>")
    p.append(f"        <label>{esc(f.label)}</label>")
    req = "true" if kw.get("required") else "false"
    if t == "Text":
        p += [f"        <length>{kw['length']}</length>", f"        <required>{req}</required>",
              "        <trackTrending>false</trackTrending>", "        <type>Text</type>",
              f"        <unique>{'true' if kw.get('unique') else 'false'}</unique>"]
    elif t in ("Phone", "Email", "Date", "DateTime", "Url"):
        p += [f"        <required>{req}</required>", "        <trackTrending>false</trackTrending>", f"        <type>{t}</type>"]
        if t == "Email": p.append("        <unique>false</unique>")
    elif t == "Checkbox":
        p += ["        <trackTrending>false</trackTrending>", "        <type>Checkbox</type>"]
    elif t in ("Currency", "Number", "Percent"):
        p += [f"        <precision>{kw.get('precision', 18)}</precision>", f"        <required>{req}</required>",
              f"        <scale>{kw.get('scale', 2)}</scale>", "        <trackTrending>false</trackTrending>", f"        <type>{t}</type>"]
        if t == "Number": p.append("        <unique>false</unique>")
    elif t == "Picklist":
        p += [f"        <required>{req}</required>", "        <trackTrending>false</trackTrending>", "        <type>Picklist</type>",
              picklist_xml(kw["values"], kw.get("default"), kw.get("restricted", True))]
    elif t == "LongTextArea":
        p += [f"        <length>{kw.get('length', 32768)}</length>", "        <trackTrending>false</trackTrending>",
              "        <type>LongTextArea</type>", f"        <visibleLines>{kw.get('visibleLines', 5)}</visibleLines>"]
    elif t == "Lookup":
        constraint = "Restrict" if kw.get("required") else "SetNull"
        p += [f"        <deleteConstraint>{constraint}</deleteConstraint>", f"        <referenceTo>{kw['refTo']}</referenceTo>",
              f"        <relationshipLabel>{esc(kw.get('relLabel', f.label + 's'))}</relationshipLabel>",
              f"        <relationshipName>{kw['relName']}</relationshipName>", f"        <required>{req}</required>",
              "        <trackTrending>false</trackTrending>", "        <type>Lookup</type>"]
    else:
        raise ValueError(t)
    return "    <fields>\n" + "\n".join(p) + "\n    </fields>"

def obj_xml(o):
    fields = "\n".join(field_xml(f) for f in o["fields"])
    if o["name_type"] == "AutoNumber":
        nf = f"""    <nameField>
        <displayFormat>{o['name_fmt']}</displayFormat>
        <label>{esc(o['name_label'])}</label>
        <type>AutoNumber</type>
    </nameField>"""
    else:
        nf = f"""    <nameField>
        <label>{esc(o['name_label'])}</label>
        <type>Text</type>
    </nameField>"""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!--
{o['header']}
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <enableActivities>false</enableActivities>
    <enableBulkApi>true</enableBulkApi>
    <enableFeeds>false</enableFeeds>
    <enableHistory>false</enableHistory>
    <enableReports>true</enableReports>
    <enableSearch>true</enableSearch>
    <enableSharing>true</enableSharing>
    <enableStreamingApi>true</enableStreamingApi>
{fields}
    <label>{esc(o['label'])}</label>
{nf}
    <pluralLabel>{esc(o['plural'])}</pluralLabel>
    <searchLayouts/>
    <sharingModel>ReadWrite</sharingModel>
    <externalSharingModel>Private</externalSharingModel>
</CustomObject>
"""

def lk(api, label, section, refTo, relName, desc="", relLabel=None, required=False, cache=True, sys=False):
    return F(api, label, section, "Lookup", desc, cache=cache, sys=sys, refTo=refTo, relName=relName,
             relLabel=relLabel or label + "s", required=required)

def tenant(relName, relLabel):
    return lk("Client__c", "Client", "Identity", TENANT, relName, "Tenant isolation anchor (D-034/D-035). Every Lambda query filters on this.", relLabel, required=True)

SNAP = lambda sec: [
    F("Customer_Name_at_Creation__c", "Customer Name at Creation", sec, "Text", "Snapshot at record creation (standard snapshot pattern).", sys=True, length=120),
    F("Address_at_Creation__c", "Address at Creation", sec, "Text", "Snapshot at record creation.", sys=True, length=255),
    F("Primary_Phone_at_Creation__c", "Primary Phone at Creation", sec, "Phone", "Snapshot at record creation.", sys=True),
    F("Primary_Email_at_Creation__c", "Primary Email at Creation", sec, "Email", "Snapshot at record creation.", sys=True),
]

OBJECTS = []

# ============================ Sundial_Service_Plan__c ============================
OBJECTS.append(dict(
    api="Sundial_Service_Plan__c", label="Service Plan", plural="Service Plans", key="serviceplan",
    table="sundial_service_plan_cache", name_type="Text", name_label="Plan Name",
    parent=None,
    search=(["name", "plan_code"], ["Name", "Plan_Code__c"]),
    delete=False,
    header="""  Sundial_Service_Plan__c - the Service Club catalog (D-073): one row per thing sold online,
  per tenant. Kind Subscription (Monitor / Maintain / Clean / Protect - monthly or yearly) or
  One-time (a truck roll). The Stripe Product / Price ids are DERIVED from these rows by
  scripts/seed-service-club.mjs and written back; a price change is a new Stripe Price and an
  archived old one, never an edit. The member discount is expressed in the estimate's own
  discount vocabulary so the estimate Lambda can copy it straight onto a new estimate.""",
    fields=[
        tenant("Sundial_Service_Plans", "Service Plans"),
        F("Plan_Code__c", "Plan Code", "Identity", "Text", "Stable key per tenant (monitor / maintain / clean / protect / truck-roll). The seed script upserts on Client + code; the public pages address plans by it.", length=40, required=True),
        F("Kind__c", "Kind", "Identity", "Picklist", "Subscription = a recurring Stripe subscription (monthly / yearly prices). One-time = paid once through the estimate + deposit path (the truck roll).", values=["Subscription", "One-time"], default="Subscription"),
        F("Availability__c", "Availability", "Identity", "Picklist", "Available = on the public page and purchasable. Coming Soon = shown, not purchasable (Protect at launch). Hidden = office only (send-a-link still works). Retired = keeps history, sells nothing.", values=["Available", "Coming Soon", "Hidden", "Retired"], default="Available"),
        F("Sort_Order__c", "Sort Order", "Identity", "Number", "Public page order.", precision=3, scale=0, default="10"),
        F("Highlight__c", "Highlight", "Copy", "Text", "Badge on the public card, e.g. MOST POPULAR. Blank = none.", length=40),
        F("Tagline__c", "Tagline", "Copy", "Text", "One line under the plan name.", length=255),
        F("Features__c", "Features", "Copy", "LongTextArea", "One feature per line, in the order shown on the card.", cache=False, length=4000, visibleLines=6),
        F("Monthly_Price__c", "Monthly Price", "Pricing", "Currency", "Subscription plans: per month.", precision=16, scale=2),
        F("Yearly_Price__c", "Yearly Price", "Pricing", "Currency", "Subscription plans: per year (blank = no yearly option).", precision=16, scale=2),
        F("Price__c", "Price", "Pricing", "Currency", "One-time plans: the amount charged at purchase.", precision=16, scale=2),
        F("Price_Book_Item_Code__c", "Price Book Item Code", "Pricing", "Text", "One-time plans: the price-book Item_Code__c that becomes the estimate line (the active version's price wins over Price__c when set). Blank = an ad-hoc line at Price__c.", length=40),
        F("Stripe_Product_Id__c", "Stripe Product Id", "Stripe", "Text", "Written by the seed script.", sys=True, length=60),
        F("Stripe_Monthly_Price_Id__c", "Stripe Monthly Price Id", "Stripe", "Text", "Written by the seed script; replaced (old archived) when Monthly_Price__c changes.", sys=True, length=60),
        F("Stripe_Yearly_Price_Id__c", "Stripe Yearly Price Id", "Stripe", "Text", "Written by the seed script.", sys=True, length=60),
        F("Discount_Scope__c", "Member Discount Scope", "Member Discount", "Picklist", "What the member discount applies to on an estimate - the estimate's own Discount_Scope__c values.", values=["Labor", "Material", "Both"], default="Labor"),
        F("Discount_Type__c", "Member Discount Type", "Member Discount", "Picklist", "", values=["Percent", "Amount"], default="Percent"),
        F("Discount_Value__c", "Member Discount Value", "Member Discount", "Number", "10 = 10% (Percent) or $10 (Amount). Blank / 0 = the plan carries no estimate discount.", precision=16, scale=2),
        F("Discount_Description__c", "Member Discount Description", "Member Discount", "Text", "How the office and the customer read it, e.g. '10% off repair labor'.", length=255),
        F("Includes_Tune_Up__c", "Includes Annual Tune-Up", "Entitlements", "Checkbox", "The office owes the member one tune-up a year.", default=False),
        F("Includes_Cleaning__c", "Includes Annual Cleaning", "Entitlements", "Checkbox", "The office owes the member one panel cleaning a year.", default=False),
        F("Notes__c", "Notes", "Copy", "Text", "", length=255),
    ],
))

# ============================ Sundial_Membership__c ============================
OBJECTS.append(dict(
    api="Sundial_Membership__c", label="Service Club Membership", plural="Service Club Memberships", key="membership",
    table="sundial_membership_cache", name_type="AutoNumber", name_fmt="MEM-{00000}", name_label="Membership Number",
    parent=("Sundial_Customer__c", "sundial_customer_sf_id"),
    search=(["name", "customer_name_at_creation", "primary_email_at_creation"], ["Name", "Customer_Name_at_Creation__c", "Primary_Email_at_Creation__c"]),
    delete=False,
    header="""  Sundial_Membership__c - one row per customer x plan x Stripe subscription (D-073). Born
  Pending by Sundial's own join (never by a webhook), Active when Stripe's checkout completes,
  then follows the subscription: Past Due on a failed renewal, Cancelled when it ends.
  Stripe_Subscription_Id__c is the idempotency key for every subscription event. The customer
  hub's Active_Membership__c points at the one live row.""",
    fields=[
        lk("Sundial_Customer__c", "Sundial Customer", "Identity", "Sundial_Customer__c", "Service_Club_Memberships", "Required.", "Service Club Memberships", required=True),
        lk("Service_Plan__c", "Service Plan", "Identity", "Sundial_Service_Plan__c", "Memberships", "Required.", "Memberships", required=True),
        tenant("Sundial_Memberships", "Service Club Memberships"),
        *SNAP("Identity"),
        F("Status__c", "Status", "Status", "Picklist", "Pending (checkout started) -> Active -> Past Due (renewal failed) -> Cancelled (subscription ended) | Expired (pending checkout never completed).", values=["Pending", "Active", "Past Due", "Cancelled", "Expired"], default="Pending"),
        F("Billing_Interval__c", "Billing Interval", "Status", "Picklist", "", values=["Monthly", "Yearly", "None"], default="Monthly"),
        F("Price__c", "Price", "Status", "Currency", "What the member pays per interval, as sold.", precision=16, scale=2),
        F("Source__c", "Source", "Status", "Picklist", "Online = the public join page. Office = a join link sent from Sundial. Migrated = an existing member moved onto Stripe billing.", values=["Online", "Office", "Migrated"], default="Online"),
        F("Stripe_Subscription_Id__c", "Stripe Subscription Id", "Stripe", "Text", "External ID - the webhook's idempotency key.", sys=True, length=60, externalId=True),
        F("Stripe_Checkout_Session_Id__c", "Stripe Checkout Session Id", "Stripe", "Text", "The session the join minted; the success page looks the membership up by it.", sys=True, length=80, externalId=True),
        F("Stripe_Customer_Id__c", "Stripe Customer Id", "Stripe", "Text", "Mirror of the customer hub's, at join time.", sys=True, length=60),
        F("Started_At__c", "Started At", "Dates", "DateTime", "When the subscription became Active.", sys=True),
        F("Current_Period_End__c", "Current Period End", "Dates", "DateTime", "From Stripe; the next renewal.", sys=True),
        F("Cancel_At_Period_End__c", "Cancel At Period End", "Dates", "Checkbox", "Cancelled by the member or the office, still Active until the period ends.", sys=True, default=False),
        F("Cancelled_At__c", "Cancelled At", "Dates", "DateTime", "When the cancellation was requested.", sys=True),
        F("Ended_At__c", "Ended At", "Dates", "DateTime", "When the subscription actually ended (Stripe's customer.subscription.deleted).", sys=True),
        F("Cancel_Reason__c", "Cancel Reason", "Dates", "Text", "", length=255),
        F("Last_Payment_At__c", "Last Payment At", "Money", "DateTime", "", sys=True),
        F("Last_Payment_Amount__c", "Last Payment Amount", "Money", "Currency", "", sys=True, precision=16, scale=2),
        F("Lifetime_Revenue__c", "Lifetime Revenue", "Money", "Currency", "Sum of Stripe invoice.paid amounts on this subscription.", sys=True, precision=16, scale=2, default="0"),
        F("Payment_Failures__c", "Payment Failures", "Money", "Number", "Count of invoice.payment_failed events.", sys=True, precision=5, scale=0, default="0"),
        F("SolarFacts_Status__c", "SolarFacts Status", "SolarFacts", "Picklist", "The monitoring hand-off (D-073.6): Not Sent -> Sent on activation; Cancel Sent when the subscription ends. Failed / Cancel Failed keep the error and the office's Resend button lights up.", sys=True, values=["Not Sent", "Sent", "Failed", "Cancel Sent", "Cancel Failed", "Not Applicable"], default="Not Sent"),
        F("SolarFacts_Last_Sent_At__c", "SolarFacts Last Sent At", "SolarFacts", "DateTime", "", sys=True),
        F("SolarFacts_Last_Error__c", "SolarFacts Last Error", "SolarFacts", "Text", "", sys=True, length=255),
        F("SolarFacts_Account_Id__c", "SolarFax Account Id", "SolarFacts", "Text", "SolarFax's account_id from POST /users (their API), for support lookups.", sys=True, length=60),
        F("SolarFacts_User_Id__c", "SolarFax User Id", "SolarFacts", "Text", "SolarFax's user_id from POST /users.", sys=True, length=60),
        F("Notes__c", "Notes", "Status", "Text", "", length=255),
    ],
))

CUSTOMER_FIELD = lk("Active_Membership__c", "Active Membership", "Service Club", "Sundial_Membership__c", "Active_Members",
                    "Lambda-maintained pointer to the customer's one live Service Club membership (Active or Past Due); cleared when it ends. Deployed as a single CustomField, never a whole-object deploy of Sundial_Customer__c.", "Active Members")
ESTIMATE_FIELD = lk("Membership__c", "Membership", "Discount", "Sundial_Membership__c", "Estimates",
                    "The membership whose plan discount this estimate carries (Discount_Source__c = Service Plan). Deployed as a single CustomField.", "Estimates")

for o in OBJECTS:
    open(f"{PKG}/objects/{o['api']}.object", "w").write(obj_xml(o))

open(f"{PKG}/objects/Sundial_Customer__c.object", "w").write(f"""<?xml version="1.0" encoding="UTF-8"?>
<!--
  Sundial_Customer__c - ONE NEW FIELD ONLY (D-073). package.xml lists it as a CustomField
  member, so this file adds Active_Membership__c and touches nothing else on the object.
  NEVER convert this to a whole-object deploy: it would overwrite the live object's settings.
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
{field_xml(CUSTOMER_FIELD)}
</CustomObject>
""")
open(f"{PKG}/objects/Sundial_Estimate__c.object", "w").write(f"""<?xml version="1.0" encoding="UTF-8"?>
<!--
  Sundial_Estimate__c - ONE NEW FIELD ONLY (D-073): Membership__c. Delta deploy; the full
  object lives in salesforce/service-objects/. Never convert to a whole-object deploy.
-->
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
{field_xml(ESTIMATE_FIELD)}
</CustomObject>
""")

# ---------------------------------------------------------------------------
# package.xml
# ---------------------------------------------------------------------------
open(f"{PKG}/package.xml", "w").write(f"""<?xml version="1.0" encoding="UTF-8"?>
<!--
  service-club (D-073, 2026-09-18) - the Service Club catalog + membership objects, one
  pointer field on Sundial_Customer__c, one on Sundial_Estimate__c, and the integration-user
  permission set for them.

  PRECONDITION: salesforce/service-objects (D-072) is deployed - Sundial_Estimate__c must
  exist for the Membership__c field.

  DEPLOY: zip this folder's CONTENTS (package.xml at zip root; Linux/WSL zip or Explorer
  Send-to, NEVER PowerShell 5.1 Compress-Archive) -> Workbench -> Migration -> Deploy ->
  Single Package -> CHECK ONLY first, expect 5/5 components (2 objects + 2 fields + 1
  permission set), then deploy for real. Assign Sundial_Service_Club to the integration
  user. Then in the Supabase SQL editor: sql/sundial_service_plan_cache.sql,
  sql/sundial_membership_cache.sql, sql/2026-09-18_service_club.sql. Then the seed script
  (scripts/seed-service-club.mjs; the runbook docs/integrations/service-club.md has the exact
  command - a double dash cannot appear inside this XML comment).
-->
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Sundial_Service_Plan__c</members>
        <members>Sundial_Membership__c</members>
        <name>CustomObject</name>
    </types>
    <types>
        <members>Sundial_Customer__c.Active_Membership__c</members>
        <members>Sundial_Estimate__c.Membership__c</members>
        <name>CustomField</name>
    </types>
    <types>
        <members>Sundial_Service_Club</members>
        <name>PermissionSet</name>
    </types>
    <version>62.0</version>
</Package>
""")

# ---------------------------------------------------------------------------
# Permission set
# ---------------------------------------------------------------------------
def fp(obj, api, editable):
    return f"""    <fieldPermissions>
        <editable>{'true' if editable else 'false'}</editable>
        <field>{obj}.{api}</field>
        <readable>true</readable>
    </fieldPermissions>"""

fps, skipped_required = [], []
for o in OBJECTS:
    for f in o["fields"]:
        if f.kw.get("required"):
            skipped_required.append(f"{o['api']}.{f.api}")
            continue
        fps.append(fp(o["api"], f.api, True))
fps.append(fp("Sundial_Customer__c", CUSTOMER_FIELD.api, True))
fps.append(fp("Sundial_Estimate__c", ESTIMATE_FIELD.api, True))
ops = "\n".join(f"""    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>{o['api']}</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>""" for o in OBJECTS)
open(f"{PKG}/permissionsets/Sundial_Service_Club.permissionset", "w").write(f"""<?xml version="1.0" encoding="UTF-8"?>
<!--
  Object + field permissions on the Service Club objects (D-073) for the Sundial
  INTEGRATION USER (assign to it after deploy). No deletes: plans retire, memberships
  cancel - a code mistake fails instead of destroying history.

  REQUIRED fields carry no fieldPermissions entries ON PURPOSE (Salesforce forbids FLS on
  required fields): {", ".join(skipped_required)}.
-->
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Sundial Service Club</label>
    <description>D-073: object and field access for Sundial_Service_Plan__c, Sundial_Membership__c, Sundial_Customer__c.Active_Membership__c and Sundial_Estimate__c.Membership__c, for the Sundial integration user.</description>
{ops}
{chr(10).join(fps)}
</PermissionSet>
""")

# ---------------------------------------------------------------------------
# SQL cache tables
# ---------------------------------------------------------------------------
def col(api): return api[:-3].lower() if api.endswith("__c") else api.lower()
def pgtype(f):
    t = f.ftype
    if t == "Lookup": return "text"
    if t in ("Currency", "Number", "Percent"): return "numeric"
    if t == "Checkbox": return "boolean"
    if t == "DateTime": return "timestamptz"
    if t == "Date": return "date"
    return "text"

INDEXES = {
    "serviceplan": [("code", "(client_sf_id, plan_code)"), ("availability", "(client_sf_id, availability, sort_order)")],
    "membership": [("customer", "(client_sf_id, sundial_customer_sf_id)"), ("status", "(client_sf_id, status)"), ("plan", "(client_sf_id, service_plan_sf_id, status)"), ("subscription", "(stripe_subscription_id) where stripe_subscription_id is not null")],
}

for o in OBJECTS:
    t, key = o["table"], o["key"]
    rows = []
    for f in o["fields"]:
        if not f.cache or f.api == "Client__c": continue
        c = col(f.api) + ("_sf_id" if f.ftype == "Lookup" else "")
        rows.append((c, pgtype(f), f"{f.api}" + (f" ({f.desc[:60]}...)" if len(f.desc) > 60 else (f" ({f.desc})" if f.desc else ""))))
    width = max(len(r[0]) for r in rows) + 2
    body = "\n".join(f"  {r[0]:<{width}} {r[1] + ',':<12} -- {r[2]}" for r in rows)
    name_comment = "Name (auto-number)" if o["name_type"] == "AutoNumber" else "Name (text)"
    idx = "\n".join(f"create index if not exists idx_{t}_{n}\n  on {t} {expr};" for n, expr in INDEXES[key])
    open(f"{ROOT}/sql/{t}.sql", "w").write(f"""-- {t} — Supabase cache table for {o['api']} ({o['label']}, D-073).
--
-- Same pattern as the D-072 service caches: the display subset the portal's lists render,
-- plus the standard control columns. Column NAMES match sfFieldToColumn() (strip __c,
-- lowercase; reference fields get _sf_id), so creating this table makes {key} records
-- populate via read-through and the scheduled sundial-cache-sync job. GENERATED by
-- scripts/gen-service-club.py - edit the spec, not this.
--
-- TENANT ISOLATION: client_sf_id is the isolation key (D-035), NOT NULL.

create table if not exists {t} (
  -- Control / identity
  {'sf_id':<{width}} text primary key,          -- Salesforce record Id
  {'client_sf_id':<{width}} text not null,             -- Client__c (tenant isolation key)
  {'tenant_id':<{width}} text,                      -- Client__r.Name slug (label only)

  -- Display subset
  {'name':<{width}} text,        -- {name_comment}
{body}

  {'created_date':<{width}} timestamptz, -- CreatedDate (list ordering)
  {'last_synced_at':<{width}} timestamptz not null default now(),
  {'cache_version':<{width}} integer not null default 1,
  {'is_stale':<{width}} boolean not null default false
);

create index if not exists idx_{t}_tenant
  on {t} (client_sf_id);
{idx}
create index if not exists idx_{t}_recent
  on {t} (client_sf_id, created_date desc nulls last, sf_id);
create index if not exists idx_{t}_stale
  on {t} (client_sf_id, is_stale) where is_stale = true;
""")

open(f"{ROOT}/sql/2026-09-18_service_club.sql", "w").write("""-- 2026-09-18 Service Club (D-073): the two pointer columns on EXISTING cache tables.
-- Run after the Salesforce package deploys. Idempotent.

alter table sundial_customer_cache add column if not exists active_membership_sf_id text; -- Active_Membership__c
alter table sundial_estimate_cache add column if not exists membership_sf_id text;        -- Membership__c

create index if not exists idx_sundial_customer_cache_active_membership
  on sundial_customer_cache (client_sf_id, active_membership_sf_id) where active_membership_sf_id is not null;

-- The Stripe ledger learns which membership an event was about (subscription events).
alter table sundial_stripe_events add column if not exists membership_sf_id text;
create index if not exists idx_sundial_stripe_events_membership
  on sundial_stripe_events (client_sf_id, membership_sf_id) where membership_sf_id is not null;

-- SolarFax ids (revised 2026-09-18, their API): on a membership cache table created before the revision.
alter table sundial_membership_cache add column if not exists solarfacts_account_id text; -- SolarFacts_Account_Id__c
alter table sundial_membership_cache add column if not exists solarfacts_user_id text;    -- SolarFacts_User_Id__c
""")

spec = {o["key"]: {"sfObject": o["api"], "cacheTable": o["table"], "parent": o["parent"], "search": o["search"], "fields": [f.api for f in o["fields"]]} for o in OBJECTS}
spec["deltas"] = {"Sundial_Customer__c": [CUSTOMER_FIELD.api], "Sundial_Estimate__c": [ESTIMATE_FIELD.api]}
json.dump(spec, open(f"{PKG}/spec.json", "w"), indent=2)
print("service-club: 2 objects, 2 delta fields, 1 permission set, 3 sql files written")
