// scripts/diagnose-cache.mjs — "the portal isn't showing my records": is it Salesforce
// or the cache? Read-only. Counts one object's rows in Salesforce (tenant-scoped, active
// vs inactive where the object has Is_Active__c) and in the Supabase cache table, and
// says what to do about a gap.
//
//   node scripts/diagnose-cache.mjs --object pricebookitem --tenant harmon
//   node scripts/diagnose-cache.mjs --object job --tenant harmon
//
// WHY THIS EXISTS (2026-09-18): the list endpoint reads the cache first and only asks
// Salesforce when the cache has NOTHING for the tenant/object. A cache with a few rows
// (items made from the portal) never learns about rows that arrived by DataLoader, a
// Flow, or an admin — until sundial-cache-sync runs. It runs on demand today (no
// EventBridge schedule yet), so a bulk import "vanishes" in the portal until you run it.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const OBJECT = opt("object", "pricebookitem");
const TENANT = opt("tenant", "harmon");

const REGISTRY = {
  customer: { sfObject: "Sundial_Customer__c", cacheTable: "sundial_customer_cache" },
  solar: { sfObject: "Sundial_Solar__c", cacheTable: "sundial_solar_cache" },
  roofing: { sfObject: "Sundial_Roofing__c", cacheTable: "sundial_roofing_cache" },
  estimate: { sfObject: "Sundial_Estimate__c", cacheTable: "sundial_estimate_cache" },
  job: { sfObject: "Sundial_Service_Job__c", cacheTable: "sundial_service_job_cache" },
  servicecall: { sfObject: "Sundial_Service_Call__c", cacheTable: "sundial_service_call_cache" },
  pricebookitem: { sfObject: "Sundial_Price_Book_Item__c", cacheTable: "sundial_price_book_item_cache", activeField: "Is_Active__c" },
  serviceline: { sfObject: "Sundial_Service_Line__c", cacheTable: "sundial_service_line_cache" },
  serviceinvoice: { sfObject: "Sundial_Service_Invoice__c", cacheTable: "sundial_service_invoice_cache" },
  servicepayment: { sfObject: "Sundial_Service_Payment__c", cacheTable: "sundial_service_payment_cache" },
  serviceplan: { sfObject: "Sundial_Service_Plan__c", cacheTable: "sundial_service_plan_cache" },
  membership: { sfObject: "Sundial_Membership__c", cacheTable: "sundial_membership_cache" },
};
const entry = REGISTRY[OBJECT];
if (!entry) {
  console.error(`unknown object '${OBJECT}' — one of ${Object.keys(REGISTRY).join(", ")}`);
  process.exit(2);
}

const count = async (where) => {
  const r = await sfQuery(`SELECT COUNT(Id) c FROM ${entry.sfObject} WHERE ${where}`);
  return Number(r?.[0]?.c ?? r?.[0]?.expr0 ?? 0) || 0;
};

async function main() {
  const t = await sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
  const tenantId = t?.[0]?.Id;
  if (!tenantId) throw new Error(`tenant '${TENANT}' not found`);
  const where = `Client__c = '${tenantId}'`;
  const sfTotal = await count(where);
  const sfActive = entry.activeField ? await count(`${where} AND ${entry.activeField} = true`) : null;
  const sfNoTenant = await count(`Client__c = null`);
  // Who owns what the integration user CAN see. Under the Private sharing model the
  // integration user sees only rows it owns or rows shared to it — a DataLoader import
  // run as Tim is owned by Tim and is invisible here until a sharing rule (or an
  // ownership transfer) says otherwise. That is the "success file says 219, the
  // portal shows 1" case (2026-09-18).
  const sample = await sfQuery(`SELECT Id, Name, Owner.Name, CreatedBy.Name FROM ${entry.sfObject} WHERE ${where} ORDER BY CreatedDate DESC LIMIT 5`);
  const owners = [...new Set((sample || []).map((r) => r.Owner?.Name).filter(Boolean))];

  let cacheTotal = null;
  let cacheActive = null;
  let cacheError = null;
  try {
    const supabase = await getSupabaseClient();
    const { count: c, error } = await supabase.from(entry.cacheTable).select("sf_id", { count: "exact", head: true }).eq("client_sf_id", tenantId);
    if (error) throw new Error(error.message);
    cacheTotal = c ?? 0;
    if (entry.activeField) {
      const { count: a, error: e2 } = await supabase.from(entry.cacheTable).select("sf_id", { count: "exact", head: true }).eq("client_sf_id", tenantId).eq("is_active", true);
      if (!e2) cacheActive = a ?? 0;
    }
  } catch (e) {
    cacheError = e?.message || String(e);
  }

  console.log(`\n${entry.sfObject} for tenant ${TENANT} (${tenantId})`);
  console.log(`  Salesforce: ${sfTotal} row(s)${sfActive != null ? ` — ${sfActive} active, ${sfTotal - sfActive} inactive` : ""}${sfNoTenant ? `  (+ ${sfNoTenant} row(s) with NO Client__c — invisible to every tenant)` : ""}`);
  if (owners.length) console.log(`  Visible rows are owned by: ${owners.join(", ")} (the integration user sees only what it owns or is shared)`);
  if (cacheError) console.log(`  Cache (${entry.cacheTable}): could not read — ${cacheError}`);
  else console.log(`  Cache (${entry.cacheTable}): ${cacheTotal} row(s)${cacheActive != null ? ` — ${cacheActive} active` : ""}`);

  console.log("\nDiagnosis:");
  console.log("  NOTE: these counts are what the INTEGRATION USER can see. Rows created by another user (a DataLoader import, a Flow run as an admin) are invisible to it under the Private sharing model until a sharing rule shares them, or their owner is changed to the integration user. If Salesforce's own list view shows more than this, that is the cause — see salesforce/pricebook-import/README.md → 'Sharing'.");
  if (sfTotal === 0) {
    console.log("  Salesforce has NOTHING for this tenant. The import / create never landed (or landed under another Client__c). Check DataLoader's success/error files, and the Client__c column.");
  } else if (cacheError) {
    console.log("  Could not compare with the cache — fix the Supabase credentials first (sundial/supabase/service-role).");
  } else if (cacheTotal === 0) {
    console.log("  The cache is empty, so the portal reads live from Salesforce — it should already show these rows. If it does not, the portal is filtering them (Price Book hides inactive items unless 'show inactive' is on) or the list call is failing (check the browser's network tab).");
  } else if (cacheTotal < sfTotal) {
    console.log(`  The cache has ${cacheTotal} of ${sfTotal} — the portal shows only what is cached, and the rest arrived without going through the portal. Run a full resync of this object:`);
    console.log(`    aws lambda invoke --function-name sundial-cache-sync --region us-west-1 --cli-binary-format raw-in-base64-out --payload '{\\"mode\\":\\"full\\",\\"object\\":\\"${OBJECT}\\"}' sync.json ; Get-Content sync.json`);
    console.log("  (or Lambda console → sundial-cache-sync → Test with that JSON). Re-run this script afterwards; the two numbers should match.");
  } else if (cacheTotal > sfTotal) {
    console.log("  The cache has MORE than Salesforce — ghost rows from deleted records. Run { \"mode\": \"reconcile\", \"object\": \"" + OBJECT + "\" } on sundial-cache-sync (dryRun first).");
  } else {
    console.log("  Salesforce and the cache agree. If the portal still shows fewer, it is a filter on the page" + (entry.activeField ? " ('show inactive')" : "") + " or a stale browser tab — hard-refresh.");
  }
}

main().catch((e) => {
  console.error("diagnose-cache failed:", e?.sfBody || e?.message || e);
  process.exit(1);
});
