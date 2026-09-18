// scripts/seed-service-club.mjs — the Service Club catalog (D-073): upsert the tenant's
// Sundial_Service_Plan__c rows and derive the Stripe Products / Prices from them.
//
//   node scripts/seed-service-club.mjs --tenant harmon              # dry run (prints the plan)
//   node scripts/seed-service-club.mjs --tenant harmon --apply      # write Salesforce + Stripe
//   node scripts/seed-service-club.mjs --tenant harmon --apply --no-stripe   # rows only
//
// WHAT IT DOES, in order, idempotently:
//   1. Upserts one Sundial_Service_Plan__c per entry in CATALOG[tenant], matched on
//      Client__c + Plan_Code__c. Copy fields (name, tagline, features, prices, discount,
//      availability) are written every run — this file is the source of truth for them
//      until the office edits a row from the portal, at which point stop re-running it
//      for that tenant (or edit the catalog here first).
//   2. For each Subscription plan: ensures a Stripe Product (Stripe_Product_Id__c) and a
//      recurring Price per interval whose amount matches the row (Stripe prices are
//      immutable: a changed amount = a NEW price + the old one archived). Ids written back.
//   3. One-time plans get no Stripe objects — they sell through the estimate + deposit path.
//
// Keys: Secrets Manager sundial/stripe (tenants[slug].secretKey) via lib/stripe.js. TEST
// keys make test products; run it again after the live keys land and the ids are replaced
// (the rows keep the live ids; the test products stay in the test account, harmless).
//
// Canary rule (CLAUDE.md): this writes a handful of rows, one at a time, re-reading each.

import { sfQuery, sfCreateRecord, sfUpdateRecord, soqlEscapeString } from "../lib/salesforce.js";
import { stripeForTenant, toCents } from "../lib/stripe.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const NO_STRIPE = args.includes("--no-stripe");
const tenantIx = args.indexOf("--tenant");
const TENANT = tenantIx >= 0 ? args[tenantIx + 1] : null;
if (!TENANT) {
  console.error("usage: node scripts/seed-service-club.mjs --tenant <slug> [--apply] [--no-stripe]");
  process.exit(2);
}

const PLAN_SF_OBJECT = "Sundial_Service_Plan__c";
const TENANT_SF_OBJECT = "Sundial_Tenant__c";

/**
 * The catalog, per tenant slug. Harmon's is what solarserviceclub.com showed on
 * 2026-09-18, verbatim prices. Protect ships Coming Soon (the site says so).
 * Member discount = the ONE estimate discount the plan carries (D-073.7); the "$50 off
 * inspections / 5% off equipment" lines stay in the feature copy and the office's hands.
 */
const CATALOG = {
  harmon: [
    {
      code: "monitor", name: "Monitor Plan", kind: "Subscription", sort: 10, availability: "Available",
      tagline: "Monthly monitoring and support.",
      monthly: 8.99, yearly: 99.99,
      features: ["Proactive system monitoring", "Remote troubleshooting", "Priority scheduling", "$50 off inspections", "10% off repair work", "5% off add-on equipment"],
      discount: { scope: "Labor", type: "Percent", value: 10, description: "10% off repair labor" },
      tuneUp: false, cleaning: false,
    },
    {
      code: "maintain", name: "Maintain Plan", kind: "Subscription", sort: 20, availability: "Available", highlight: "Most Popular",
      tagline: "Includes annual tune-up and preventive maintenance.",
      monthly: 19.99, yearly: 219.99,
      features: ["Everything in Monitor", "Annual tune-up scheduled when you join", "Hardware checks and inspection", "Preventive maintenance support"],
      discount: { scope: "Labor", type: "Percent", value: 10, description: "10% off repair labor" },
      tuneUp: true, cleaning: false,
    },
    {
      code: "clean", name: "Clean Plan", kind: "Subscription", sort: 30, availability: "Available",
      tagline: "Includes annual panel cleaning to help maximize production.",
      monthly: 39.99, yearly: 439.99,
      features: ["Everything in Maintain", "1 annual panel cleaning included", "Great for dusty areas", "Helps protect production and appearance"],
      discount: { scope: "Labor", type: "Percent", value: 10, description: "10% off repair labor" },
      tuneUp: true, cleaning: true,
    },
    {
      code: "protect", name: "Protect Plan", kind: "Subscription", sort: 40, availability: "Coming Soon",
      tagline: "Maximum protection for covered repair issues after inspection approval.",
      monthly: 39.99, yearly: 439.99,
      features: ["Everything in Maintain", "No-cost repair promise on covered issues", "$0 labor on covered repair visits", "$0 parts on covered failures", "Panel cleaning"],
      discount: { scope: "Labor", type: "Percent", value: 10, description: "10% off repair labor" },
      tuneUp: true, cleaning: true,
    },
    {
      code: "truck-roll", name: "Service Call", kind: "One-time", sort: 100, availability: "Available",
      tagline: "Book a technician visit now — we call you to schedule.",
      price: 275, priceBookItemCode: null,
      features: ["A technician at your home", "Diagnosis of the issue", "A written estimate for any repair"],
      tuneUp: false, cleaning: false,
    },
  ],
};

const plans = CATALOG[TENANT];
if (!plans) {
  console.error(`no catalog for tenant '${TENANT}' — add it to CATALOG in this script.`);
  process.exit(2);
}

function fieldsFor(p, tenantId) {
  const f = {
    Name: p.name,
    Client__c: tenantId,
    Plan_Code__c: p.code,
    Kind__c: p.kind,
    Availability__c: p.availability,
    Sort_Order__c: p.sort,
    Highlight__c: p.highlight ?? null,
    Tagline__c: p.tagline ?? null,
    Features__c: (p.features || []).join("\n"),
    Monthly_Price__c: p.kind === "Subscription" ? p.monthly ?? null : null,
    Yearly_Price__c: p.kind === "Subscription" ? p.yearly ?? null : null,
    Price__c: p.kind === "One-time" ? p.price ?? null : null,
    Price_Book_Item_Code__c: p.priceBookItemCode ?? null,
    Discount_Scope__c: p.discount?.scope ?? "Labor",
    Discount_Type__c: p.discount?.type ?? "Percent",
    Discount_Value__c: p.discount?.value ?? null,
    Discount_Description__c: p.discount?.description ?? null,
    Includes_Tune_Up__c: !!p.tuneUp,
    Includes_Cleaning__c: !!p.cleaning,
  };
  return f;
}

async function main() {
  const tenants = await sfQuery(`SELECT Id, Name FROM ${TENANT_SF_OBJECT} WHERE Name = '${soqlEscapeString(TENANT)}' LIMIT 1`);
  const tenantId = tenants?.[0]?.Id;
  if (!tenantId) throw new Error(`tenant '${TENANT}' not found in ${TENANT_SF_OBJECT}`);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — tenant ${TENANT} (${tenantId}), ${plans.length} plans${NO_STRIPE ? ", Stripe skipped" : ""}`);

  const existing = await sfQuery(`SELECT Id, Name, Plan_Code__c, Kind__c, Monthly_Price__c, Yearly_Price__c, Stripe_Product_Id__c, Stripe_Monthly_Price_Id__c, Stripe_Yearly_Price_Id__c FROM ${PLAN_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}'`);
  const byCode = new Map((existing || []).map((r) => [r.Plan_Code__c, r]));

  let stripe = null;
  if (!NO_STRIPE) {
    stripe = await stripeForTenant(TENANT);
    if (!stripe) console.warn("Stripe is not configured for this tenant (sundial/stripe) — rows will be written without Stripe ids.");
    else console.log(`Stripe: ${stripe.config.mode} keys`);
  }

  for (const p of plans) {
    const fields = fieldsFor(p, tenantId);
    let row = byCode.get(p.code);
    if (!APPLY) {
      console.log(`  ${row ? "update" : "create"} ${p.code} (${p.name}) — ${p.kind}${p.kind === "Subscription" ? ` $${p.monthly}/mo $${p.yearly}/yr` : ` $${p.price}`}, ${p.availability}`);
      continue;
    }
    if (row) {
      await sfUpdateRecord(PLAN_SF_OBJECT, row.Id, fields);
      console.log(`  updated ${p.code} (${row.Id})`);
    } else {
      const c = await sfCreateRecord(PLAN_SF_OBJECT, fields);
      row = { Id: c.id, Plan_Code__c: p.code };
      console.log(`  created ${p.code} (${c.id})`);
    }
    // Canary: re-read the row we just wrote and check a field we set.
    const back = (await sfQuery(`SELECT Id, Name, Plan_Code__c, Stripe_Product_Id__c, Stripe_Monthly_Price_Id__c, Stripe_Yearly_Price_Id__c FROM ${PLAN_SF_OBJECT} WHERE Id = '${row.Id}'`))?.[0];
    if (!back || back.Name !== p.name) throw new Error(`re-read of ${p.code} does not match what was written — stopping`);
    row = back;

    if (stripe && p.kind === "Subscription") {
      const stripeFields = {};
      let productId = row.Stripe_Product_Id__c;
      if (productId) {
        try {
          const prod = await stripe.client.get(`products/${encodeURIComponent(productId)}`);
          if (!prod?.id || prod.deleted) productId = null;
        } catch (e) {
          if (e?.status === 404) productId = null;
          else throw e;
        }
      }
      if (!productId) {
        const prod = await stripe.client.post("products", { name: `${p.name} — Service Club`, description: p.tagline || undefined, metadata: { tenant: TENANT, planCode: p.code, sundialPlanId: row.Id } });
        productId = prod.id;
        stripeFields.Stripe_Product_Id__c = productId;
        console.log(`    Stripe product ${productId}`);
      }
      for (const [interval, amount, field] of [["month", p.monthly, "Stripe_Monthly_Price_Id__c"], ["year", p.yearly, "Stripe_Yearly_Price_Id__c"]]) {
        if (amount == null) continue;
        let priceId = row[field];
        let current = null;
        if (priceId) {
          try {
            current = await stripe.client.get(`prices/${encodeURIComponent(priceId)}`);
          } catch (e) {
            if (e?.status !== 404) throw e;
          }
        }
        const matches = current && current.active && current.unit_amount === toCents(amount) && current.recurring?.interval === interval && current.product === productId;
        if (matches) continue;
        const created = await stripe.client.post("prices", { product: productId, currency: "usd", unit_amount: toCents(amount), recurring: { interval }, nickname: `${p.name} ${interval}ly`, metadata: { tenant: TENANT, planCode: p.code, interval } });
        if (current && current.active) {
          await stripe.client.post(`prices/${encodeURIComponent(current.id)}`, { active: false });
          console.log(`    archived old ${interval} price ${current.id}`);
        }
        stripeFields[field] = created.id;
        console.log(`    Stripe ${interval} price ${created.id} ($${amount})`);
      }
      if (Object.keys(stripeFields).length) await sfUpdateRecord(PLAN_SF_OBJECT, row.Id, stripeFields);
    }
  }
  console.log(APPLY ? "done." : "dry run only — add --apply to write.");
}

main().catch((e) => {
  console.error("seed-service-club failed:", e?.sfBody || e?.message || e);
  process.exit(1);
});
