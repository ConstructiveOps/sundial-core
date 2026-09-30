// policy.js — the rules of the demo seed, in one place.
//
// WHY A SEPARATE FILE: these lists are what keep a demo seed from damaging a production
// org that a paying client (Harmon) lives in. Keeping them together means the preflight,
// the writer and the tests all enforce the SAME rules, and the owner can read them in
// one sitting.

export const DEFAULT_TENANT_SLUG = "conops-demo";
/** The real client. The seed must never write into it, under any flag. */
export const HARMON_TENANT_SLUG = "harmon";
export const HARMON_TENANT_ID = "a1W7y000007AszBEAS";

/** Where the run's local files live (git-ignored: /migration/ is in .gitignore). */
export const OUT_DIR_PARTS = ["migration", "demo"];
export const DEMO_USERS_SECRET = "sundial/demo-users";

/** The order the phases run in. `dealers` comes before `users` because a sales user's
 *  Dealer__c lookup needs the dealer to exist first. */
export const PHASES = ["tenant", "dealers", "users", "customers", "solar", "roofing", "pricebook", "service", "supabase", "files"];

export const OBJ = Object.freeze({
  tenant: "Sundial_Tenant__c",
  dealer: "Sundial_Dealer__c",
  user: "Sundial_User__c",
  customer: "Sundial_Customer__c",
  solar: "Sundial_Solar__c",
  roofing: "Sundial_Roofing__c",
  item: "Sundial_Price_Book_Item__c",
  estimate: "Sundial_Estimate__c",
  line: "Sundial_Service_Line__c",
  job: "Sundial_Service_Job__c",
  call: "Sundial_Service_Call__c",
  invoice: "Sundial_Service_Invoice__c",
  payment: "Sundial_Service_Payment__c",
  day: "Sundial_Tech_Day__c",
});

/** Every object the seed writes — and therefore every object the preflight describes. */
export const SEEDED_OBJECTS = Object.freeze(Object.values(OBJ));

/**
 * Objects the seed must NEVER write:
 *  - Sundial_Commercial__c has no Client__c, so a record there cannot be tenant-stamped.
 *  - Sundial_PO__c mirrors Acumatica purchase orders; the demo has no Acumatica.
 *  - The Service Club objects: the demo has no Service Club.
 */
export const FORBIDDEN_OBJECTS = Object.freeze([
  "Sundial_Commercial__c",
  "Sundial_PO__c",
  "Sundial_Service_Plan__c",
  "Sundial_Membership__c",
]);

/**
 * Fields the seed must never write, on any object.
 *  - HCP_Id__c belongs to the Housecall Pro import alone (CLAUDE.md).
 *  - Acumatica / Aurora / Sunbase / Dropbox / Stripe fields are integration state; a
 *    value there makes a Lambda or a Flow believe an outside system knows this record.
 *  - Solar_Project__c / "Send to Constructive Ops" style fields are the mirror into the
 *    vendor's own back-office object.
 *  - Utility logins are credentials, even fake ones have no place in a demo.
 *  - Project_Manager__c / Contract_Specialist__c on Solar are RESTRICTED lists of real
 *    Harmon employees.
 */
export const FORBIDDEN_FIELD_PATTERNS = Object.freeze([
  /^HCP_Id__c$/,
  /Acumatica/i,
  /Aurora/i,
  /Sunbase/i,
  /Dropbox/i,
  /Stripe/i,
  /^Solar_Project__c$/,
  /Constructive_Ops$|Send_to_Constructive|Synced_to_Solar_Project/i,
  /^Legacy_ID__c$/,
  /^External_CRM_ID__c$/,
  /^Utility_(Username|Password)__c$/,
  /^Harmon_/,
  /^Contract_Specialist__c$/,
  /^Public_Token/,
  /^Report_Public_Token/,
]);
/** Per-object additions to the list above. */
export const FORBIDDEN_FIELDS_BY_OBJECT = Object.freeze({
  // On Solar this is a restricted multi-select of Harmon's real project managers. On
  // Roofing the same API name is a lookup to a Sundial user, which the demo does fill.
  Sundial_Solar__c: ["Project_Manager__c", "Commission_Deal_Type__c", "Budget_Calc_Status__c"],
  Sundial_Roofing__c: ["Budget_Calc_Status__c"],
  Sundial_Customer__c: ["Budget_Calc_Status__c", "Appointment_Assigned_To__c", "Sat_By__c"],
});

export function isForbiddenField(sfObject, field) {
  if (FORBIDDEN_FIELD_PATTERNS.some((re) => re.test(field))) return true;
  return (FORBIDDEN_FIELDS_BY_OBJECT[sfObject] || []).includes(field);
}

/**
 * UNRESTRICTED picklists where the demo deliberately writes its OWN values (the API
 * accepts a new value on an unrestricted picklist; the demo portal overrides the
 * dropdown lists). On every OTHER picklist — restricted or not — the seed only ever
 * writes a value the org already has, so it never adds a value to a list Harmon uses.
 */
export const DEMO_OWNED_PICKLISTS = Object.freeze({
  Sundial_Customer__c: ["Sales_Company__c", "Dealer_Name__c"],
  Sundial_Solar__c: ["Sales_Company_Harmon_Solar_or_Third__c", "Sales_Representative__c", "Solar_Installer__c", "PM_Name__c"],
});
export const isDemoOwnedPicklist = (sfObject, field) => (DEMO_OWNED_PICKLISTS[sfObject] || []).includes(field);

/**
 * Fields the demo cannot do without. If one of these is missing from the org, is not
 * createable, or a value planned for it is not accepted, the preflight STOPS the run.
 * Every other planned field is optional: when the org does not have it (a package that
 * is not deployed yet), it is dropped with a printed warning and the run continues.
 */
export const REQUIRED_FIELDS = Object.freeze({
  Sundial_Tenant__c: ["Name"],
  Sundial_Dealer__c: ["Name", "Client__c", "Active__c", "Is_Internal__c"],
  Sundial_User__c: [
    "First_Name__c", "Last_Name__c", "Email__c", "Access_Level__c", "Hierarchy_Level__c", "Active__c",
    "Supabase_User_Id__c", "Client__c", "Dealer__c", "Default_Department__c", "Super_Admin__c",
    "Dispatch_Board__c", "Dispatch_Order__c",
  ],
  Sundial_Customer__c: [
    "Name", "Client__c", "First_Name__c", "Last_Name__c", "Primary_Phone__c", "Primary_Email__c", "Street__c",
    "City__c", "State__c", "Postal_Code__c", "Status__c", "Stage__c", "Customer_Type__c", "Sales_Rep__c",
    "Dealer__c", "Welcome_Call_Status__c", "Service_Stage__c", "Linked_Solar_Project__c",
  ],
  Sundial_Solar__c: [
    "Sundial_Customer__c", "Client__c", "Stage__c", "Project_Name__c", "Customer_Name_at_Creation__c",
    "Address_at_Creation__c", "Primary_Phone_at_Creation__c", "Primary_Email_at_Creation__c", "Sales_Rep__c",
    "Dealer__c", "System_Size__c", "Contract_Amount__c", "Sales_Company_Harmon_Solar_or_Third__c",
  ],
  Sundial_Roofing__c: ["Sundial_Customer__c", "Client__c", "Stage__c", "Project_Name__c"],
  Sundial_Price_Book_Item__c: ["Name", "Client__c", "Item_Code__c", "Kind__c", "Unit_of_Measure__c", "Is_Active__c", "Version__c", "Taxable__c", "Labor_Price__c", "Material_Price__c"],
  Sundial_Estimate__c: [
    "Client__c", "Sundial_Customer__c", "Status__c", "Version__c", "Version_Log__c", "Service_Job__c",
    "Customer_Name_at_Creation__c", "Address_at_Creation__c", "Labor_Subtotal__c", "Material_Subtotal__c",
    "Fee_Subtotal__c", "Subtotal__c", "Discount_Amount__c", "Markup_Amount__c", "Tax_Amount__c", "Total__c",
    "Deposit_Amount__c", "Tax_Rate__c", "Scope_Summary__c",
  ],
  Sundial_Service_Line__c: ["Estimate__c", "Client__c", "Kind__c", "Description__c", "Quantity__c", "Unit_Price__c", "Unit_of_Measure__c", "Taxable__c", "Stage__c", "Sort_Order__c", "Source__c"],
  Sundial_Service_Job__c: ["Client__c", "Sundial_Customer__c", "Estimate__c", "Status__c", "Payment_Status__c", "Customer_Name_at_Creation__c", "Address_at_Creation__c", "Priority__c", "Bill_To_Type__c"],
  Sundial_Service_Call__c: [
    "Client__c", "Sundial_Service_Job__c", "Tech__c", "Status__c", "Scheduled_Start__c", "Scheduled_End__c",
    "Clock_Intervals__c", "Actual_Start__c", "Actual_End__c", "Duration_Minutes__c", "Visit_Type__c",
  ],
  Sundial_Service_Invoice__c: ["Name", "Client__c", "Service_Job__c", "Status__c", "Subtotal__c", "Tax_Amount__c", "Total__c", "Paid_Amount__c", "Issued_At__c"],
  Sundial_Service_Payment__c: ["Client__c", "Service_Job__c", "Invoice__c", "Type__c", "Method__c", "Amount__c", "Status__c", "Received_At__c"],
  Sundial_Tech_Day__c: ["Client__c", "Tech__c", "Work_Date__c", "Day_Key__c", "Day_Log__c", "Day_Start__c", "Status__c"],
});
export const isRequiredField = (sfObject, field) => (REQUIRED_FIELDS[sfObject] || []).includes(field);

/**
 * How an already-written record is recognised WITHOUT the id-map — used only to recover
 * from a crash in the split second between "Salesforce created it" and "the id-map was
 * saved". Most of these objects cannot be deleted by the integration user, so a lost id
 * must be re-found rather than re-created. Each list is a set of fields that is unique
 * inside the demo plan (the tests prove that).
 */
export const NATURAL_KEYS = Object.freeze({
  Sundial_Tenant__c: ["Name"],
  Sundial_Dealer__c: ["Name"],
  Sundial_User__c: ["Email__c"],
  Sundial_Customer__c: ["Name", "Street__c"],
  Sundial_Solar__c: ["Sundial_Customer__c"],
  Sundial_Roofing__c: ["Sundial_Customer__c"],
  Sundial_Price_Book_Item__c: ["Item_Code__c"],
  Sundial_Estimate__c: ["Sundial_Customer__c", "Scope_Summary__c"],
  Sundial_Service_Line__c: ["Estimate__c", "Sort_Order__c"],
  Sundial_Service_Job__c: ["Estimate__c"],
  Sundial_Service_Call__c: ["Sundial_Service_Job__c", "Tech__c", "Status__c", "Scheduled_Start__c"],
  Sundial_Service_Invoice__c: ["Service_Job__c"],
  Sundial_Service_Payment__c: ["Service_Job__c", "Type__c", "Amount__c", "Received_At__c"],
  Sundial_Tech_Day__c: ["Day_Key__c"],
});

/** Fictional contact rules (safety rule 5). 555-0100…555-0199 is the range reserved for fiction. */
export const FAKE_PHONE_RE = /^\((602|480|623)\) 555-01\d\d$/;
export const FAKE_PHONE_E164_RE = /^\+1(602|480|623)55501\d\d$/;
export const FAKE_EMAIL_RE = /^[a-z0-9.'-]+@example\.com$/;
/** Demo LOGINS are plus-addresses of the owner, so nothing reaches a stranger. */
export const OWNER_EMAIL_RE = /^tim\+demo-[a-z0-9-]+@constructiveoperations\.com$/;
export const demoUserEmail = (slug) => `tim+demo-${slug}@constructiveoperations.com`;

/** Which object a stable key belongs to, from its prefix ("job:031" -> Sundial_Service_Job__c). */
const KEY_PREFIX_OBJECT = Object.freeze({
  tenant: OBJ.tenant, dealer: OBJ.dealer, user: OBJ.user, customer: OBJ.customer, solar: OBJ.solar, roofing: OBJ.roofing,
  item: OBJ.item, estimate: OBJ.estimate, line: OBJ.line, job: OBJ.job, call: OBJ.call, invoice: OBJ.invoice,
  payment: OBJ.payment, day: OBJ.day,
});
export function objectOfKey(key, extra = {}) {
  if (extra[key]) return extra[key];
  return KEY_PREFIX_OBJECT[String(key).split(":")[0]] ?? null;
}
