// Read-only probe: why does a commission-PO amount UPDATE not stick? (2026-10-23)
//
//   node scripts/probe-commission-po-update.mjs SOL-10125 SOL-10061 SOL-10130
//
// For each Solar project: the stored M1 / M2 OrderNbrs and the amounts Salesforce holds,
// then each PurchaseOrder from Acumatica with $expand=Details — the header (Status, Hold,
// Approved, Type, OrderNbr, LastModifiedDateTime, totals) and EVERY field on every line,
// so a price-override / received / billed field shows up whatever it is called.
//
//   node scripts/probe-commission-po-update.mjs --all-failed
//
// One summary line per PO for every Failed project whose error is the update re-read
// mismatch: status, hold, amount now vs what the engine wanted, received / completed
// flags, last modified — the "has anything been received or billed against it" check —
// and the amount Tim's ruling (2026-10-23) says it should hold: M1 frozen → M2 = commission − the
// REAL M1; M1 still open → the rule split. Rows marked OFF are the ones a re-push must change.
//
// GET only. Nothing here writes to Acumatica or Salesforce.
import { getAcumaticaEntity } from "../lib/acumatica.js";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";

if (process.argv[2] === "--all-failed") {
  const av = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);
  const failed = await sfQuery(
    `SELECT Id, Name, Acumatica_Project_ID__c, Sales_Rep_Commission_Amt__c, Commission_PO_M1_Number__c, ` +
      `Commission_PO_M2_Number__c, Commission_PO_Error__c FROM Sundial_Solar__c ` +
      `WHERE Commission_PO_Status__c = 'Failed' ORDER BY Name`
  );
  const mismatch = failed.filter((r) => /was updated but no longer matches/.test(r.Commission_PO_Error__c ?? ""));
  console.log(`${mismatch.length} of ${failed.length} Failed projects carry the update re-read mismatch\n`);
  console.log("project    PO      status  hold  now        wanted     onRcpt done  lastModified             target     verdict");
  console.log("(wanted = from the error text; target = Tim's ruling 2026-10-23: M1 frozen -> M2 = commission - the REAL M1, else the rule split)\n");
  for (const r of mismatch) {
    // What the failing run wanted, per PO, from its own error lines.
    const wanted = {};
    for (const m of String(r.Commission_PO_Error__c).matchAll(/PO (\d+) [^\n]*?expected ([\d.]+)/g)) wanted[m[1]] ??= m[2];
    const total = Number(r.Sales_Rep_Commission_Amt__c) || 0;
    const ruleM1 = Math.min(Math.round(total * 50) / 100, 2500);
    const pos = {};
    for (const nbr of [r.Commission_PO_M1_Number__c, r.Commission_PO_M2_Number__c].filter(Boolean)) {
      const res = await getAcumaticaEntity("PurchaseOrder", { $filter: `OrderNbr eq '${nbr}'`, $expand: "Details" });
      pos[nbr] = res.ok && Array.isArray(res.data) ? res.data[0] ?? null : null;
      if (!pos[nbr]) pos[nbr] = { failed: res.status };
    }
    // Frozen = Closed / Completed / anything received: the amount it holds is what was paid.
    const frozen = (po) => po && !po.failed &&
      (!["Open", "On Hold"].includes(av(po.Status)) || Number(av(po.Details?.[0]?.QtyOnReceipts)) > 0 || av(po.Details?.[0]?.Completed) === true);
    const m1 = pos[r.Commission_PO_M1_Number__c];
    const m1Now = Number(av(m1?.Details?.[0]?.UnitCost));
    const target = {
      [r.Commission_PO_M1_Number__c]: frozen(m1) ? null : ruleM1,
      [r.Commission_PO_M2_Number__c]: Math.round((total - (frozen(m1) ? m1Now : ruleM1)) * 100) / 100,
    };
    console.log(`${r.Name}  commission ${total}  rule M1 ${ruleM1}`);
    for (const [nbr, po] of Object.entries(pos)) {
      if (po.failed) { console.log(`  ${nbr}  read failed ${po.failed}`); continue; }
      const d = po.Details?.[0] ?? {};
      const now = Number(av(d.UnitCost));
      const t = target[nbr];
      const verdict = frozen(po) ? "frozen (paid) - never touch"
        : t == null ? "-"
        : Math.abs(now - t) < 0.005 ? "OK (matches ruling)"
        : `OFF by ${Math.round((now - t) * 100) / 100}`;
      console.log(
        `  ${nbr}  ${String(av(po.Status)).padEnd(7)} ${String(av(po.Hold)).padEnd(5)} ` +
          `${String(now).padEnd(10)} ${String(wanted[nbr] ?? "-").padEnd(10)} ${String(av(d.QtyOnReceipts)).padEnd(6)} ` +
          `${String(av(d.Completed)).padEnd(5)} ${String(av(po.LastModifiedDateTime)).slice(0, 19).padEnd(24)} ` +
          `${String(t ?? "-").padEnd(10)} ${verdict}`
      );
    }
  }
  process.exit(0);
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: node scripts/probe-commission-po-update.mjs <SOL-name> [SOL-name...]");
  process.exit(1);
}

const av = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);
const flat = (obj) =>
  Object.keys(obj ?? {}).sort().filter((k) => !["custom", "_links", "rowNumber", "note"].includes(k))
    .map((k) => {
      const v = obj[k];
      if (Array.isArray(v)) return `${k}=[${v.length}]`;
      const x = av(v);
      return `${k}=${x === null || x === undefined ? "∅" : typeof x === "object" ? JSON.stringify(x) : x}`;
    });

const rows = await sfQuery(
  `SELECT Id, Name, Acumatica_Project_ID__c, Sales_Rep_Commission_Amt__c, ` +
    `Commission_PO_M1_Number__c, Commission_PO_M1_Amount__c, Commission_PO_M2_Number__c, Commission_PO_M2_Amount__c, ` +
    `Commission_PO_Status__c, Budget_Push_Status__c, Budget_Last_Pushed__c, LastModifiedDate ` +
    `FROM Sundial_Solar__c WHERE Name IN (${names.map((n) => `'${soqlEscapeString(n)}'`).join(", ")})`
).catch(async () =>
  // Budget_Last_Pushed__c may not exist under that name — retry without it.
  sfQuery(
    `SELECT Id, Name, Acumatica_Project_ID__c, Sales_Rep_Commission_Amt__c, ` +
      `Commission_PO_M1_Number__c, Commission_PO_M1_Amount__c, Commission_PO_M2_Number__c, Commission_PO_M2_Amount__c, ` +
      `Commission_PO_Status__c, Budget_Push_Status__c, LastModifiedDate ` +
      `FROM Sundial_Solar__c WHERE Name IN (${names.map((n) => `'${soqlEscapeString(n)}'`).join(", ")})`
  )
);

for (const r of rows) {
  console.log(`\n================ ${r.Name}  project ${r.Acumatica_Project_ID__c}  (${r.Id})`);
  console.log(`  Salesforce: commission ${r.Sales_Rep_Commission_Amt__c}  M1 ${r.Commission_PO_M1_Number__c} @ ${r.Commission_PO_M1_Amount__c}  M2 ${r.Commission_PO_M2_Number__c} @ ${r.Commission_PO_M2_Amount__c}  status ${r.Commission_PO_Status__c}  push ${r.Budget_Push_Status__c}  modified ${r.LastModifiedDate}`);
  for (const nbr of [r.Commission_PO_M1_Number__c, r.Commission_PO_M2_Number__c].filter(Boolean)) {
    const res = await getAcumaticaEntity("PurchaseOrder", { $filter: `OrderNbr eq '${nbr}'`, $expand: "Details" });
    if (!res.ok) { console.log(`  PO ${nbr}: read failed ${res.status} ${String(res.text).slice(0, 200)}`); continue; }
    const pos = Array.isArray(res.data) ? res.data : [];
    if (pos.length !== 1) { console.log(`  PO ${nbr}: ${pos.length} rows`); continue; }
    const po = pos[0];
    console.log(`\n  --- PO ${nbr}  id ${po.id}`);
    console.log(`  header: Status=${av(po.Status)} Hold=${av(po.Hold)} Approved=${av(po.Approved)} Type=${av(po.Type)} OrderNbr=${av(po.OrderNbr)} LastModifiedDateTime=${av(po.LastModifiedDateTime)} OrderTotal=${av(po.OrderTotal)} LineTotal=${av(po.LineTotal)}`);
    console.log(`  header (all): ${flat(po).join("  ")}`);
    for (const d of po.Details ?? []) {
      console.log(`  line ${d.id}:`);
      console.log(`    ${flat(d).join("\n    ")}`);
    }
  }
}
