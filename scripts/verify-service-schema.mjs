// verify-service-schema.mjs — pre/post-deploy check for the Phase 2 service objects
// (salesforce/service-objects/ package; DECISIONS.md D-072 - seven objects + one
// field added to Sundial_Customer__c).
//
// WHAT IT DOES (read-only; describe calls only, no data touched):
//   1. Reads the package's .object files, so the expected manifest can never drift
//      from what the package actually deploys.
//   2. PRE-DEPLOY: says which of the seven objects already exist (any existing
//      object = STOP, whole-object deploy would overwrite object-level settings),
//      and whether Sundial_Commercial__c exists (absent => remove the three
//      commercial lookups from the package before deploying). A package file with
//      no <label> is a FIELD-ONLY addition to an existing object
//      (Sundial_Customer__c.Stripe_Customer_Id__c) and is checked field-by-field only.
//   3. POST-DEPLOY: per object, field-by-field — missing fields, type mismatches,
//      and the integration user's FLS (describe runs AS the integration user, so
//      updateable=false on a field we write means the permission set isn't
//      assigned or is missing an entry).
//
// Run:  node scripts/verify-service-schema.mjs
// Exit code 0 = everything this run could check is green; 1 = action needed.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeObject } from "../lib/salesforce.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "salesforce", "service-objects", "objects");

// Fields the Lambdas write (FLS-Edit required for the integration user). Formula
// and auto-number fields are read-only by nature and excluded automatically.
const parsePkg = () => {
  const out = {};
  for (const f of readdirSync(PKG).filter((n) => n.endsWith(".object"))) {
    const obj = f.replace(/\.object$/, "");
    const xml = readFileSync(join(PKG, f), "utf8");
    const fields = [];
    const fieldOnly = !/<label>[^<]*<\/label>\s*<nameField>/.test(xml) && !/<pluralLabel>/.test(xml);
    for (const m of xml.matchAll(/<fields>([\s\S]*?)<\/fields>/g)) {
      const blk = m[1];
      fields.push({
        api: blk.match(/<fullName>(.*?)<\/fullName>/)[1],
        type: blk.match(/<type>(\w+)<\/type>/)[1],
      });
    }
    out[obj] = Object.assign(fields, { fieldOnly });
  }
  return out;
};

// Salesforce describe "type" values for our metadata types (describe speaks a
// different dialect than metadata XML).
const DESCRIBE_TYPE = {
  Text: ["string"],
  Phone: ["phone"],
  Email: ["email"],
  DateTime: ["datetime"],
  Date: ["date"],
  Checkbox: ["boolean"],
  Currency: ["currency"],
  Number: ["double", "int"],
  Percent: ["percent"],
  Picklist: ["picklist"],
  LongTextArea: ["textarea"],
  Lookup: ["reference"],
  Formula: ["currency", "double", "string", "percent"], // formula shows as its return type
};

const READ_ONLY_TYPES = new Set(["Formula"]);

let actionNeeded = false;
const say = (s) => console.log(s);

const describeOrNull = async (obj) => {
  try {
    return await describeObject(obj, { forceRefresh: true });
  } catch {
    return null;
  }
};

const main = async () => {
  const manifest = parsePkg();
  const objects = Object.keys(manifest);
  say(`service-objects verify — ${objects.length} objects, ${objects.reduce((n, o) => n + manifest[o].length, 0)} fields in the package\n`);

  // Commercial dependency check (two lookups reference it).
  const commercial = await describeOrNull("Sundial_Commercial__c");
  if (!commercial) {
    actionNeeded = true;
    say("✗ Sundial_Commercial__c DOES NOT resolve for the integration user.");
    say("  Before deploying: remove Originating_Commercial_Project__c (estimate + job)");
    say("  and Sundial_Commercial__c (service call) from the .object files AND their");
    say("  three fieldPermissions entries — a lookup to a missing object fails the deploy.\n");
  } else {
    say("✓ Sundial_Commercial__c resolves — the three commercial lookups can stay.\n");
  }

  // D-072 §3.1a: the New Estimate / New Job popup tags customers with
  // Requested_Project_Types__c = "Service". The value must exist as an ACTIVE entry
  // on that multipicklist or the customer write fails at runtime. Not deployed by
  // this package (a valueSet redeploy could clobber Harmon's other values) - add it
  // in Setup if missing. Roofing / Commercial are reported for the later modules.
  {
    const cust = await describeOrNull("Sundial_Customer__c");
    const f = cust?.fields?.find((x) => x.name === "Requested_Project_Types__c");
    if (!f) {
      actionNeeded = true;
      say("✗ Sundial_Customer__c.Requested_Project_Types__c not visible to the integration user.\n");
    } else {
      const active = (f.picklistValues || []).filter((v) => v.active).map((v) => v.value);
      for (const want of ["Service", "Roofing", "Commercial"]) {
        const ok = active.includes(want);
        if (want === "Service" && !ok) actionNeeded = true;
        say(`${ok ? "✓" : want === "Service" ? "✗" : "○"} Requested_Project_Types__c value "${want}" ${ok ? "present" : "MISSING" + (want === "Service" ? " - add it in Setup before go-live" : " (needed when that module lands)")}`);
      }
      if (f.type !== "multipicklist") { actionNeeded = true; say(`✗ Requested_Project_Types__c is ${f.type}, expected multipicklist`); }
      if (!f.updateable) { actionNeeded = true; say("✗ Requested_Project_Types__c is not updateable by the integration user (FLS)"); }
      say("");
    }
  }

  for (const obj of objects) {
    const desc = await describeOrNull(obj);
    if (!desc && manifest[obj].fieldOnly) {
      actionNeeded = true;
      say(`✗ ${obj}: NOT visible, but the package only ADDS fields to it — it must already exist.\n`);
      continue;
    }
    if (!desc) {
      say(`○ ${obj}: NOT in the org (or not visible to the integration user).`);
      say(`  Pre-deploy this is the EXPECTED state. Post-deploy it means the deploy`);
      say(`  failed or FLS/permission-set assignment is missing.\n`);
      continue;
    }
    say(`● ${obj}: EXISTS (${desc.fields.length} fields visible)${manifest[obj].fieldOnly ? " — field-only addition, existing fields are expected" : ""}.`);
    const byName = new Map(desc.fields.map((f) => [f.name, f]));
    const missing = [];
    const typeOff = [];
    const flsOff = [];
    for (const f of manifest[obj]) {
      const live = byName.get(f.api);
      if (!live) {
        missing.push(f.api);
        continue;
      }
      const okTypes = DESCRIBE_TYPE[f.type] ?? [];
      if (okTypes.length && !okTypes.includes(live.type)) {
        typeOff.push(`${f.api} (package ${f.type} vs live ${live.type})`);
      }
      if (!READ_ONLY_TYPES.has(f.type) && !live.calculated && !live.autoNumber && !live.updateable) {
        flsOff.push(f.api);
      }
    }
    if (missing.length) {
      actionNeeded = true;
      say(`  ✗ ${missing.length} package fields MISSING: ${missing.join(", ")}`);
    }
    if (typeOff.length) {
      actionNeeded = true;
      say(`  ✗ type mismatches: ${typeOff.join("; ")}`);
    }
    if (flsOff.length) {
      actionNeeded = true;
      say(`  ✗ ${flsOff.length} fields NOT updateable by the integration user (assign the`);
      say(`    Sundial_Service_Objects permission set, or add the missing entries):`);
      say(`    ${flsOff.join(", ")}`);
    }
    if (!missing.length && !typeOff.length && !flsOff.length) {
      say(`  ✓ all package fields present, types match, integration-user FLS OK.`);
    }
    // Whole-object caution when the object predates this package:
    const extra = desc.fields
      .filter((f) => f.custom && !manifest[obj].some((p) => p.api === f.name))
      .map((f) => f.name);
    if (extra.length && !manifest[obj].fieldOnly) {
      say(`  ⚠ live object carries ${extra.length} custom fields NOT in the package: ${extra.join(", ")}`);
      say(`    (Fine post-deploy if added deliberately; PRE-deploy this means the object`);
      say(`    already existed — reconcile before a whole-object deploy.)`);
    }
    say("");
  }

  say(actionNeeded ? "RESULT: action needed (see ✗ above)." : "RESULT: green.");
  process.exit(actionNeeded ? 1 : 0);
};

main().catch((e) => {
  console.error("verify-service-schema failed:", e?.message || e);
  process.exit(1);
});
