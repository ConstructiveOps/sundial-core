// Clear Failed commission-PO records WITHOUT re-pushing their budgets (2026-10-23).
//
//   node scripts/reconcile-commission-pos.mjs                     dry run, every Failed project (harmon)
//   node scripts/reconcile-commission-pos.mjs SOL-10125 SOL-10061 dry run, just these
//   node scripts/reconcile-commission-pos.mjs --apply             write — ONE canary first, then the rest
//   ... --local                                                    run the handler in-process (before deploy)
//   ... --tenant <slug>                                            default harmon
//
// Each project goes to the budget-push Lambda as { reconcilePos: true, recordId, dryRun }.
// That runs the commission-PO stage ALONE with every Acumatica write removed: it reads both
// POs, and where the live amount is already right (the 27 October failures — Harmon fixed
// them by hand) it adopts it into Commission_PO_M{n}_Amount__c, puts the status back to
// M1 Raised / Both Raised and clears the error. A hand-set amount that differs from the
// rule is adopted as Manually Set (Frozen until that picklist value is deployed). A PO that
// genuinely needs changing reads `needs_push` and that record is left as it was.
//
// NOTHING IS WRITTEN TO ACUMATICA by this script in any mode. --apply writes to Salesforce.
//
// CANARY (CLAUDE.md, bulk data fixes): with --apply the first record is written alone,
// re-read, and the run aborts if any field the reconcile does not write has changed — the
// one check that sees automation (a recalc Flow) we cannot otherwise inspect.
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const local = args.includes("--local");
const tAt = args.indexOf("--tenant");
const slug = tAt >= 0 ? args[tAt + 1] : "harmon";
const names = args.filter((a, i) => !a.startsWith("--") && i !== tAt + 1);

const FUNCTION_NAME = "sundial-acumatica-budget-push";
const REGION = "us-west-1";

// What a reconcile is allowed to change on the record, and what it must not.
const WRITES = [
  "Commission_PO_M1_Number__c", "Commission_PO_M1_Amount__c",
  "Commission_PO_M2_Number__c", "Commission_PO_M2_Amount__c",
  "Commission_PO_Status__c", "Commission_PO_Error__c",
];
const CANARY_WATCH = [
  "Budget_Push_Status__c", "Budget_Push_Error__c", "Budget_Finalized__c", "Sales_Rep_Commission_Amt__c",
  "Acumatica_Project_ID__c", "Commission_PO_M1_Created__c", "Commission_PO_M2_Created__c", "Commission_Deal_Type__c",
];

let invoke;
if (local) {
  const { handler } = await import("../lambdas/sundial-acumatica-budget-push/index.js");
  invoke = (payload) => handler(payload);
} else {
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
  const client = new LambdaClient({ region: REGION });
  invoke = async (payload) => {
    const out = await client.send(new InvokeCommand({ FunctionName: FUNCTION_NAME, Payload: Buffer.from(JSON.stringify(payload)) }));
    const text = Buffer.from(out.Payload ?? []).toString("utf8");
    if (out.FunctionError) throw new Error(`Lambda error: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
}

const tenant = (await sfQuery(`SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(slug)}' LIMIT 1`))?.[0];
if (!tenant) { console.error(`No Sundial_Tenant__c named "${slug}".`); process.exit(1); }

const where = names.length
  ? `Name IN (${names.map((n) => `'${soqlEscapeString(n)}'`).join(", ")})`
  : "Commission_PO_Status__c = 'Failed'";
const rows = await sfQuery(
  `SELECT Id, Name FROM Sundial_Solar__c WHERE Client__c = '${soqlEscapeString(tenant.Id)}' AND ${where} ORDER BY Name`
);
console.log(`${rows.length} project(s) — ${apply ? "APPLY (Salesforce writes)" : "DRY RUN"}${local ? ", in-process" : `, via ${FUNCTION_NAME}`}\n`);

const snapshot = async (id) =>
  (await sfQuery(`SELECT ${[...WRITES, ...CANARY_WATCH].join(", ")} FROM Sundial_Solar__c WHERE Id = '${soqlEscapeString(id)}'`))[0];

function print(r) {
  if (!r || r.ok === false && !r.results) {
    console.log(`  ERROR ${r?.code ?? r?.error ?? "?"} ${r?.message ?? ""}`);
    return;
  }
  console.log(`  was ${r.before?.status} (M1 ${r.before?.M1}, M2 ${r.before?.M2}) → ${r.status ?? "left unchanged"}${r.reason ? `  [${r.reason}]` : ""}`);
  for (const x of r.results ?? []) {
    console.log(`    ${x.milestone} ${String(x.orderNbr ?? "").padEnd(7)} ${String(x.action).padEnd(22)} ${x.amount ?? ""}${x.message && x.action !== "reconciled" && !x.absorbed ? `  — ${x.message}` : ""}`);
  }
}

const tally = {};
for (const [i, row] of rows.entries()) {
  console.log(`${row.Name}  (${row.Id})`);
  const canary = apply && i === 0;
  const before = canary ? await snapshot(row.Id) : null;
  let r;
  try {
    r = await invoke({ reconcilePos: true, recordId: row.Id, tenantId: tenant.Id, dryRun: !apply });
  } catch (err) {
    console.log(`  INVOKE FAILED: ${err.message}`);
    if (canary) process.exit(1);
    continue;
  }
  print(r);
  const key = r?.status ?? r?.reason ?? r?.code ?? "error";
  tally[key] = (tally[key] ?? 0) + 1;

  if (canary) {
    const after = await snapshot(row.Id);
    const moved = CANARY_WATCH.filter((f) => JSON.stringify(before?.[f]) !== JSON.stringify(after?.[f]));
    if (moved.length > 0) {
      console.error(`\nCANARY ABORT: ${moved.join(", ")} changed on ${row.Name}, and the reconcile never writes those. ` +
        "Something else reacted to the write — find it before running the rest.");
      for (const f of moved) console.error(`  ${f}: ${JSON.stringify(before?.[f])} → ${JSON.stringify(after?.[f])}`);
      process.exit(1);
    }
    console.log(`  canary OK — nothing outside the six commission-PO fields moved.`);
  }
}

console.log(`\nSummary: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing to do"}`);
if (!apply) console.log("Dry run — nothing written. Re-run with --apply to write (one canary first).");
