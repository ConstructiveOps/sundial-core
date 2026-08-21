// sundial-acumatica-budget-push — Acumatica ProjectBudget population (Layer 2).
//
// STATUS: READ + RECONCILE SCAFFOLDING ONLY. The GUID-write path is still hard-
// guarded off (see writeBudgetLines) — but the DATA BLOCKERS ARE RESOLVED.
//
// Gate 5a (data) — DONE 2026-08-07 via a live harvest of the canonical sandbox
// project R269999 (customer C001311112; see scratchpad/R269999-reconcile.json and
// docs/integrations/acumatica-budget-push.md):
//   (A) InventoryIDs harvested. The sheet's old "AccountGroup" column was actually
//       the InventoryID; the REAL AccountGroup is BILLING/LABOR/OTHER/MATERIAL.
//       MAPPING_ROWS below now carry the full 4-part key verbatim from the scaffold.
//   (B) Geo commission -> APPT COM (LABOR · SALESCOMM · Expense), confirmed from
//       role semantics. Harmon finance sign-off still required before the first
//       PRODUCTION write (PENDING_HARMON_SIGNOFF).
//
// Income is TWO lines — BALANCE (Balance of Contract) and GENM/BILLING (Solar
// Material), both Type=Income, both InventoryID <N/A>. There is NO "BILL" task.
//
// WHAT THIS DOES NOW (safe, read-only): given a Salesforce Sundial_Solar__c record
// (or an Acumatica ProjectID), read the EXISTING scaffolded ProjectBudget lines
// (GET $filter, URL-encoded) and return them keyed by the full natural key + GUID
// `id` — the reconciliation table. It does NOT create, update, or delete anything.
//
// The eventual write path (Layer 2, after Gate 5b sign-off): match each mapping row
// to EXACTLY ONE existing line by ProjectTaskID+AccountGroup+InventoryID+Type, then
// PUT /ProjectBudget/{id} updating OriginalBudgetedAmount (+ OriginalBudgetedQty /
// UOM=HOUR on labor lines). Updates by GUID — never key-upsert, never insert.

import { getAcumaticaEntity, putAcumaticaEntity } from "../../lib/acumatica.js";
import { sfQuery, soqlEscapeString, sfUpdateRecord } from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  httpMethod,
} from "../../lib/http.js";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const PROJECT_BUDGET_ENTITY = "ProjectBudget";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

// The portal "Update Budget" button hits POST /projects/{recordId}/budget/push,
// which returns 202 immediately and hands the work to an async self-invoke of THIS
// same function (InvocationType Event). The runtime always sets these two env vars.
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;
const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-west-1" });

// --- The mapping rows (Acumatica Mapping tab, RECONCILED to the live R269999
// scaffold on 2026-08-07) ---------------------------------------------------
// Each row carries the TRUE 4-part natural key: taskId + accountGroup + inventoryId
// + type, taken VERBATIM from the harvested ProjectBudget lines
// (scratchpad/R269999-reconcile.json; table in docs/integrations/acumatica-budget-push.md).
//
// KEY CORRECTION: the sheet's old "AccountGroup" column actually held the
// InventoryID. The REAL AccountGroup is BILLING / LABOR / OTHER / MATERIAL — so the
// commission lines are AccountGroup=LABOR with InventoryID=SALESCOMM (NOT
// AccountGroup=SALESCOMM as the sheet implied). InventoryID is what separates the
// two BURDENEXR lines (SALESCOMM commission-burden vs RESIDENTAL labor-burden).
//
// (!) "RESIDENTAL" IS THE ACUMATICA-SIDE SPELLING (missing the second "I"). It is
// intentionally misspelled here to match the live InventoryID EXACTLY — DO NOT
// "correct" it to RESIDENTIAL, or every RESIDENTAL line will fail to match.
//
// "<N/A>" is a LITERAL InventoryID value on those lines (not null/absent). The
// matcher compares it as the literal string, so it must stay exactly "<N/A>".
//
// 18 rows vs. the sheet's 17: income is split into TWO code rows (BALANCE + GENM/
// BILLING). Intentional SUMS into one scaffold line: the two SLPC rows (Sales Rep +
// Overhead) and the three GENO rows (Other Material + CO Fee + Permit).

// The one item still needing a human YES before the FIRST production write (Gate 5b):
export const PENDING_HARMON_SIGNOFF = {
  // Geo commission -> APPT COM (LABOR · SALESCOMM · Expense). Confirmed from role
  // semantics (appointment-setter flat commission); the code + full key are wired
  // into MAPPING_ROWS below, but Harmon finance must sign off before the first
  // PRODUCTION ProjectBudget push.
  geoCommissionTaskId: "APPT COM",
};

export const MAPPING_ROWS = [
  // line, taskId, accountGroup, type, inventoryId, amountField, hoursField, keyStatus, note.
  //
  // keyStatus: "harvested"   = the 4-part key came verbatim from the R269999 scaffold
  //            "provisional" = v3-only line whose key is this doc's best reading of §5
  //                            and is CONFIRMED OR REFUTED BY THE RE-HARVEST. A
  //                            provisional key that matches nothing aborts the push
  //                            loudly, which is exactly what a guess should do.

  // ---- INCOME (always written, never skip-zero) ---------------------------
  { line: "Income - Balance of Contract", taskId: "BALANCE", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "Contract_Amount__c-Total_Material_Budget__c", hoursField: null, keyStatus: "harvested", note: "Income 1 of 2. Contract net of the material billing (GENM/BILLING) so the two income lines sum to the contract. DELIBERATELY EXCLUDES the DC rebate: the rebate gets its OWN income line, so adding it here too would double-count the revenue. Confirm at re-harvest (Q12b)." },
  { line: "Income - Solar Material", taskId: "GENM", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null, keyStatus: "harvested", note: "Income 2 of 2. Distinct from the GENM/MATERIAL cost line via AccountGroup+Type." },

  // ---- COMMISSIONS (D9/D10/D16/D17) ---------------------------------------
  // FOUR lines now, not two, each with exactly ONE source field. The v1 shape
  // (SLPC = rep + overhead summed) is gone: overhead moved into the SLMC management
  // line, and the rep split in two by deal type.
  { line: "3rd Party Rep Commission", taskId: "SLPC  OUT", accountGroup: "OTHER", type: "Expense", inventoryId: "M1&M2COM", amountField: "Sales_Rep_Commission_Amt__c", hoursField: null, keyStatus: "provisional", note: "D9/D16. Sales_Rep_Commission_Amt__c now holds the THIRD-PARTY amount only (the field was relabelled '3rd Party Rep Commission $/W'). ZERO on an internal deal, so skip-zero leaves this line alone. AccountGroup OTHER + InventoryID M1&M2COM per §5 - NOT LABOR/SALESCOMM like the other three. The sheet label at H7 is 'SLPC  OUT' with TWO spaces; that spacing is reproduced here and MUST be confirmed by the re-harvest." },
  { line: "Internal Rep Commission", taskId: "SLPC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Internal_Rep_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D9/D16. Zero on a third-party deal. Same key v1 used for the rep+overhead sum, but the amount source is now the INTERNAL rep alone." },
  { line: "Management Commission", taskId: "SLMC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Management_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D10. ONE line from the COMBINED (.04 + .015) amount. Do NOT sum Sales_Mgr_Commission_Amt__c + Overhead_Commission_Amt__c here - Management_Commission_Amt__c already IS that sum, and adding the components too would double it. The components stay on the record only so the attribute sync can split them (MGRCOM* / MGMTOR*)." },
  { line: "Setter Commission", taskId: "APPT COM", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Setter_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D17. Source CHANGED from Geo_Commission_Amount__c (the INPUT rate, always 70) to Setter_Commission_Amt__c (what actually APPLIED - 0 when the Customer has no Setter__c). v1 would have posted 70 to every job regardless. Still needs Harmon sign-off on the APPT COM code (PENDING_HARMON_SIGNOFF)." },
  { line: "Commission Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Commission_Burden_Amt__c", hoursField: null, keyStatus: "harvested", note: "75% of (internal + management + setter); third-party is NOT burdened. InventoryID SALESCOMM separates it from the RESIDENTAL labor burden." },

  // ---- LABOR + HOURS ------------------------------------------------------
  { line: "Audit + QA Labor", taskId: "GENA", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Audit_Labor_Cost__c", hoursField: "GENA_Hours__c", keyStatus: "harvested", note: "WARNING: v1 summed Audit_Labor_Cost__c + QA_Labor_Cost__c. In v2 Audit_Labor_Cost__c IS the whole GENA line (audit + QA, sheet J21), so keeping the v1 sum would DOUBLE-COUNT QA. See budget-v2-output-gap.md section A." },
  { line: "Roofing Labor", taskId: "ROOFCOM", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Roofing_Labor_Cost__c", hoursField: null, keyStatus: "harvested", note: "Piece rate - no hours source, so the scaffold qty is left alone." },
  { line: "S1 Install Labor", taskId: "S1", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S1_Labor_Cost__c", hoursField: "S1_Hours__c", keyStatus: "harvested" },
  { line: "S2 Install Labor", taskId: "S2", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S2_Labor_Cost__c", hoursField: "S2_Hours__c", keyStatus: "harvested" },
  { line: "S3 Labor (Battery + Adders + NS)", taskId: "S3", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S3_Labor_Cost__c", hoursField: "S3_Hours__c", keyStatus: "harvested", note: "v2 S3 = battery + ALL standard-adder + ALL NS-block labor (five blocks now, at the Powerwall rate)." },
  { line: "Labor Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Total_Labor_Burden_Budget__c", hoursField: null, keyStatus: "harvested", note: "InventoryID RESIDENTAL separates it from the SALESCOMM commission burden." },

  // ---- MATERIAL / OTHER ---------------------------------------------------
  { line: "Total Material", taskId: "GENM", accountGroup: "MATERIAL", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null, keyStatus: "harvested", note: "Sheet J15: equipment + BOS + roofing + standard-adder material + NS material (no markup)." },
  { line: "Other (GENO)", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Other_Budget__c", hoursField: null, keyStatus: "harvested", note: "WARNING: ONE ROW, not three. v1 summed Total_Other_Budget__c + Constructive_Ops_Fee__c + Permit_Pass_Through_Cost__c into this key. In v2 Total_Other_Budget__c IS the whole J16 group - Material Other + CO fee + permit + Active Monitoring + LR Battery Warranty (D12) - so the v1 rows would double-count CO fee and permit. This is the GENO group (J16), deliberately NOT Total_Other_Summary__c (N13), which also contains the four standalone lines below and would double-count those instead." },
  { line: "Dealer Fee", taskId: "DLR", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Dealer_Fee__c", hoursField: null, keyStatus: "harvested", note: "CARRIED OVER FROM v1 AND NOT IN THE section 5 v3 TABLE. Kept because the line exists in the live scaffold and dropping it silently would leave a real line unwritten. Note the dealer fee is ALSO subtracted from Balance of Revenue in the calc - confirm at re-harvest whether it belongs as an expense line too, or whether that was a v1 double-count (Q12c)." },

  // ---- STANDALONE COST LINES (D11/D13) - NEW IN v3 ------------------------
  // All four were computed in BRADS and then EXCLUDED from Total Job Cost; D11 fixed
  // that. None existed in the v1 sandbox scaffold, so every key here is provisional.
  { line: "Engineer Stamps", taskId: "ENGR", accountGroup: "SUBCON", type: "Expense", inventoryId: "<N/A>", amountField: "Engineer_Stamps_Cost__c", hoursField: null, keyStatus: "provisional", note: "Sheet J17 / E55, from the Structural-Electrical Engineer Stamp adder. Section 5 writes the task as 'ENGR?' - the v1 scaffold had BOTH an ENGR 'Engineering Costs' line and a SUBCON line, so which one this is MUST come from the re-harvest." },
  { line: "Subcontractor", taskId: "SUBCON", accountGroup: "SUBCON", type: "Expense", inventoryId: "<N/A>", amountField: "Subcontractor_Cost__c", hoursField: null, keyStatus: "provisional", note: "Sheet J18 / E56, from the Bird Blocking adder (per-watt cost x watts)." },
  { line: "Audit Software", taskId: "SOFTWARE", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Adder_Software_Fee_Price__c*Adder_Software_Fee_Qty__c", hoursField: null, keyStatus: "provisional", note: "Sheet J19 / E60. There is NO dedicated SF output field (left extras-only per gap doc section D), so the amount is the PRODUCT of the two adder fields - identical to what the calc computes, where a pass-through row's cost IS price x qty." },
  { line: "Referral Fees", taskId: "REFERRAL", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Adder_Referral_Fee_Price__c*Adder_Referral_Fee_Qty__c", hoursField: null, keyStatus: "provisional", note: "Sheet J20 / E63. D13: this is a NEW task code absent from the v1 scaffold - the live template MUST contain it or the push aborts. Section 5 leaves the InventoryID as '?'; <N/A> is the guess, matching the other OTHER lines. Same price x qty product as Software." },
];

/**
 * The DC REBATE income line - DECLARED BUT NOT ACTIVE.
 *
 * Its 4-part key is unknown until an RSDC project is harvested (section 5, D2/D3), and
 * the line only exists on RSDC scaffolds at all. It is kept OUT of MAPPING_ROWS on
 * purpose, because both alternatives are worse:
 *
 *   - putting it in with a null key would make matchMappingToLines flag a missing key
 *     part and abort EVERY push, including plain RS projects that correctly have no
 *     rebate line;
 *   - leaving it out entirely would silently drop $0.45/W of income on RSDC jobs.
 *
 * So: absent from the mapping, and GUARDED in writeBudgetLines - a job whose
 * DC_Rebate_Amount__c is non-zero cannot be pushed until this key is filled in. Once the
 * RSDC reconcile reports it, fill taskId/accountGroup/inventoryId and move the row up
 * into MAPPING_ROWS.
 */
export const PENDING_HARVEST_ROWS = [
  {
    line: "Income - DC Rebate (RSDC only)",
    taskId: null,
    accountGroup: null,
    inventoryId: null,
    type: "Income",
    amountField: "DC_Rebate_Amount__c",
    hoursField: null,
    keyStatus: "unknown",
    note: "0.45 x watts when Domestic Content is set (D2). Key TBD from the RSDC scaffold harvest.",
  },
];


// Unwrap an Acumatica field value ({ value: x } or scalar).
function av(v) {
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

// The full natural key for a ProjectBudget line/mapping row.
export function naturalKey({ taskId, accountGroup, inventoryId, type }) {
  return [taskId ?? "", accountGroup ?? "", inventoryId ?? "", type ?? ""].join(" | ");
}

// Read the existing scaffolded ProjectBudget lines for a ProjectID (read-only).
// $filter is URL-encoded by lib/acumatica.js (getAcumaticaEntity -> URLSearchParams).
export async function readProjectBudgetLines(acumaticaProjectId) {
  const res = await getAcumaticaEntity(PROJECT_BUDGET_ENTITY, {
    $filter: `ProjectID eq '${String(acumaticaProjectId).replace(/'/g, "''")}'`,
  });
  if (!res.ok) {
    const err = new Error(`ProjectBudget read failed (${res.status})`);
    err.acuStatus = res.status;
    throw err;
  }
  const lines = Array.isArray(res.data) ? res.data : [];
  return lines.map((l) => ({
    id: l.id, // GUID — the write path addresses lines by this
    taskId: av(l.ProjectTaskID),
    accountGroup: av(l.AccountGroup),
    inventoryId: av(l.InventoryID),
    type: av(l.Type),
    description: av(l.Description),
    originalBudgetedAmount: av(l.OriginalBudgetedAmount),
    originalBudgetedQty: av(l.OriginalBudgetedQty),
    uom: av(l.UOM),
    key: naturalKey({
      taskId: av(l.ProjectTaskID),
      accountGroup: av(l.AccountGroup),
      inventoryId: av(l.InventoryID),
      type: av(l.Type),
    }),
  }));
}

// Match mapping rows to existing scaffold lines by the FULL natural key
// (ProjectTaskID + AccountGroup + InventoryID + Type). Two rules:
//  - Several mapping rows sharing ONE key (e.g. the GENO adders: Other Material,
//    CO Fee, Permit) SUM into that single scaffold line — never duplicated.
//  - FAIL LOUDLY (never guess, never merge on a partial key): a row missing any
//    key part (especially InventoryID) is flagged; a key matching 0 or >1 lines
//    is flagged. Only a key matching exactly one line is a match.
export function matchMappingToLines(mappingRows, lines) {
  const matched = [];
  const problems = [];

  // Partition out rows we can't key completely (can't match or group them safely).
  const complete = [];
  for (const row of mappingRows) {
    if (
      row.inventoryId == null ||
      row.taskId == null ||
      row.accountGroup == null ||
      row.type == null
    ) {
      problems.push({
        row: row.line,
        reason:
          "mapping row missing a key part (inventoryId/taskId/accountGroup/type) — cannot match uniquely",
      });
    } else {
      complete.push(row);
    }
  }

  // Group complete rows by full key; each group -> exactly one line (amounts summed).
  const groups = new Map();
  for (const row of complete) {
    const k = naturalKey(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }

  for (const [key, rows] of groups) {
    const hits = lines.filter((l) => l.key === key);
    if (hits.length !== 1) {
      problems.push({
        key,
        count: hits.length,
        rows: rows.map((r) => r.line),
        reason: hits.length === 0 ? "no scaffolded line matched" : "matched multiple lines",
      });
      continue;
    }
    matched.push({
      key,
      lineId: hits[0].id,
      uom: hits[0].uom, // scaffold line UOM; HOUR lines also get an OriginalBudgetedQty
      type: rows[0].type, // Income lines are ALWAYS written (no skip-zero)
      rows: rows.map((r) => r.line),
      summed: rows.length > 1, // multiple mapping rows -> summed into this one line
      amountFields: rows.map((r) => r.amountField).filter(Boolean),
      hoursFields: rows.map((r) => r.hoursField).filter(Boolean),
    });
  }
  return { matched, problems };
}

// --- Budget field resolution ------------------------------------------------
function numOf(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Evaluate a field expression against record values.
//
// Grammar: TERMS separated by + / -, each term a PRODUCT of field names joined by *.
//   "Contract_Amount__c-Total_Material_Budget__c"                  (BALANCE income)
//   "Adder_Software_Fee_Price__c*Adder_Software_Fee_Qty__c"        (v3 pass-throughs)
// Salesforce API names contain none of + - *, so splitting on them is unambiguous.
// Missing/blank fields count as 0.
//
// WHY MULTIPLICATION EXISTS (added for v3): the SOFTWARE and REFERRAL budget lines have
// no dedicated Salesforce output field — the gap review left them extras-only because
// they are "trivially price × qty". True, but the push reads FIELDS off the record, not
// the calc's return value, so it needs to do that multiplication itself. The product is
// identical to what budgetCalc computes for a pass-through row.
//
// A missing factor zeroes the whole term, which is a sharper failure than in a sum — but
// every field named here is included in budgetFieldNames() and therefore in the SOQL, so
// a name that does not exist fails loudly at query time rather than quietly returning 0.
function evalFieldExpr(spec, values) {
  let total = 0;
  for (const term of String(spec).match(/[+-]?[^+-]+/g) || []) {
    let t = term.trim();
    if (!t) continue;
    let sign = 1;
    if (t[0] === "+") t = t.slice(1).trim();
    else if (t[0] === "-") { sign = -1; t = t.slice(1).trim(); }
    let product = 1;
    for (const factor of t.split("*")) product *= numOf(values?.[factor.trim()]);
    total += sign * product;
  }
  return total;
}

// Every distinct Sundial_Solar__c field referenced by MAPPING_ROWS (amount + hours
// sources; +/- expressions split), so a caller can SELECT exactly these.
/**
 * Fields the GUARDS need that are not amount sources for any line.
 *
 * `Commission_Deal_Type__c` is the v2-engine marker: only budgetCalc v2 writes it, so a
 * blank value means the record's stored budget numbers came from the v1 engine (or were
 * never calculated). See the guard in writeBudgetLines.
 */
export const GUARD_FIELDS = ["Commission_Deal_Type__c"];

// Includes PENDING_HARVEST_ROWS' sources so the DC-rebate guard below can see
// DC_Rebate_Amount__c on the record, and GUARD_FIELDS for the same reason — a guard
// that cannot read its own trigger field is not a guard.
export function budgetFieldNames() {
  const names = new Set(GUARD_FIELDS);
  for (const r of [...MAPPING_ROWS, ...PENDING_HARVEST_ROWS]) {
    if (r.amountField)
      for (const f of r.amountField.split(/[+\-*]/)) {
        const n = f.trim();
        if (n) names.add(n);
      }
    if (r.hoursField) names.add(r.hoursField.trim());
  }
  return [...names];
}

// Sum a list of amount-field specs (each may be an A+B or A-B expression).
function sumFields(fieldSpecs, values) {
  let total = 0;
  for (const spec of fieldSpecs || []) total += evalFieldExpr(spec, values);
  return round2(total);
}

// PUT one ProjectBudget line, with exponential backoff on 429 / 5xx (transient).
// A non-429 4xx is a real rejection — do not retry. Never retries a success.
const WRITE_MAX_ATTEMPTS = 4;
async function putBudgetLineWithRetry(body) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    const res = await putAcumaticaEntity(PROJECT_BUDGET_ENTITY, body);
    if (res.ok) return { ok: true, status: res.status };
    lastStatus = res.status;
    lastText = (res.text || "").slice(0, 300);
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < WRITE_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1))); // 0.5s,1s,2s
      continue;
    }
    break;
  }
  return { ok: false, status: lastStatus, text: lastText };
}

// Write the budget outputs onto the project's EXISTING scaffolded ProjectBudget
// lines. Re-reads the scaffold FRESH in this run (guids never cached/stale),
// re-matches, and ABORTS LOUDLY before any PUT on: 0 scaffold lines, any match
// problem (a key hitting ≠ 1 line), or an income line with no amount source.
//
// Per matched group: amount = sum of its amountField(s) (composites split);
// expense lines whose amount is 0 are SKIPPED (left as-is); income lines are ALWAYS
// written. HOUR lines (per the live scaffold UOM) also write OriginalBudgetedQty
// from their hours source. Re-push is SAFE BY CONSTRUCTION — every write is an
// idempotent update-by-GUID of an existing line (no inserts, deterministic values).
//
// dryRun computes every per-line amount/qty and returns them WITHOUT any PUT.
//
// @param {string} acumaticaProjectId
// @param {object} budgetValues - { <Sundial_Solar__c field>: number } (see budgetFieldNames)
// @param {{ dryRun?: boolean }} [opts]
export async function writeBudgetLines(acumaticaProjectId, budgetValues, opts = {}) {
  const { dryRun = false } = opts;

  // 1) FRESH scaffold read — guids come from THIS run only.
  const lines = await readProjectBudgetLines(acumaticaProjectId);
  if (lines.length === 0) {
    return {
      ok: false,
      aborted: "no_scaffolded_lines",
      acumaticaProjectId,
      message: "ProjectBudget returned 0 lines — never create lines from scratch.",
    };
  }

  // 1z) V2-ENGINE GUARD — the rollout guard. Runs FIRST, before anything else looks at
  // an amount, because if this fails every number below is from the wrong engine.
  //
  // v3 mapping against v1-calculated numbers is the dangerous combination during the
  // rollout window, and it is dangerous SILENTLY: the keys all still match, so the push
  // succeeds and posts a plausible, wrong budget. Concretely a v1 record would post
  // GENO without CO fee and permit (they lived in separate v1 fields that v3 no longer
  // reads), zero to the four D11 standalone lines, and nothing to SLPC OUT — because
  // Internal_Rep_Commission_Amt__c and friends are simply blank on a v1 record.
  //
  // Commission_Deal_Type__c is the marker: ONLY budgetCalc v2 writes it. Blank means v1
  // (or never calculated). Note 'None' is a perfectly valid v2 value — it means the v2
  // calc ran and found neither rep PPW populated — so the test is emptiness, NOT
  // "not one of the three labels".
  const dealTypeMarker = String(budgetValues?.Commission_Deal_Type__c ?? "").trim();
  if (dealTypeMarker === "") {
    return {
      ok: false,
      aborted: "budget_calculated_by_previous_engine",
      acumaticaProjectId,
      message:
        "Budget was calculated with the previous engine — run Recalculate Budget first.",
      detail:
        "Commission_Deal_Type__c is blank. Only budgetCalc v2 sets it, so the stored " +
        "budget values on this record predate the v2 engine and do not populate the v3 " +
        "mapping's lines (SLPC OUT, the four SUBCON/SOFTWARE/REFERRAL lines, and the " +
        "combined GENO figure). Pushing them would post a plausible but wrong budget.",
    };
  }

  // 1a) DEAL-TYPE GUARD (D16) — defense in depth.
  //
  // budgetCalc already throws when both rep PPWs are populated, so a record that
  // reaches here should be unambiguous. But the push reads STORED AMOUNTS, which could
  // be stale (calculated before the second PPW was entered, or written by something
  // other than the calc). Two non-zero rep amounts would post commission to BOTH the
  // SLPC OUT and SLPC lines — paying the same commission twice in the budget — and
  // skip-zero would not catch it, because neither is zero. Refuse.
  const thirdPartyAmt = numOf(budgetValues?.Sales_Rep_Commission_Amt__c);
  const internalAmt = numOf(budgetValues?.Internal_Rep_Commission_Amt__c);
  if (thirdPartyAmt > 0 && internalAmt > 0) {
    return {
      ok: false,
      aborted: "commission_deal_type_ambiguous",
      acumaticaProjectId,
      message:
        `Both Sales_Rep_Commission_Amt__c (${thirdPartyAmt}, 3rd party) and ` +
        `Internal_Rep_Commission_Amt__c (${internalAmt}) are non-zero. A deal is either ` +
        "third-party or internal (D16) and they post to different budget lines; writing " +
        "both would double-pay the commission. Recalculate the budget — the calc rejects " +
        "this input — then re-push.",
    };
  }

  // 1b) PENDING-HARVEST GUARD — a line we cannot key yet must not be silently dropped.
  //
  // The DC rebate is the live case: its 4-part key is unknown until an RSDC scaffold is
  // harvested. On a plain RS job the amount is 0 and this is a no-op. On an RSDC job it
  // is real income (0.45 × watts), and pushing without it would understate revenue by
  // thousands with nothing in the output to say so.
  const pendingWithValue = PENDING_HARVEST_ROWS
    .map((r) => ({ row: r, amount: sumFields([r.amountField], budgetValues) }))
    .filter((p) => p.amount !== 0);
  if (pendingWithValue.length > 0) {
    return {
      ok: false,
      aborted: "pending_harvest_line_has_value",
      acumaticaProjectId,
      message:
        "A budget line whose Acumatica key is still unknown has a non-zero amount, so " +
        "pushing would silently drop it. Harvest the key from an RSDC scaffold " +
        "(reconcile), fill it into PENDING_HARVEST_ROWS, and move the row into " +
        "MAPPING_ROWS.",
      lines: pendingWithValue.map((p) => ({ line: p.row.line, amount: p.amount, source: p.row.amountField })),
    };
  }

  // 2) Re-match against the fresh read. Any key not matching exactly one line
  //    aborts BEFORE any PUT.
  const { matched, problems } = matchMappingToLines(MAPPING_ROWS, lines);
  if (problems.length > 0) {
    return { ok: false, aborted: "match_problems", acumaticaProjectId, problems };
  }

  // 3) Income lines are always written, so their amount source must exist. Refuse
  //    a real write that would otherwise post 0 to an income line.
  const incomeNoSource = matched
    .filter((g) => g.type === "Income" && g.amountFields.length === 0)
    .map((g) => g.rows.join(" + "));
  if (incomeNoSource.length > 0 && !dryRun) {
    return {
      ok: false,
      aborted: "income_amount_source_unresolved",
      acumaticaProjectId,
      message:
        "Income line(s) have no amountField in MAPPING_ROWS; refusing to write 0 to income. " +
        "Fill the amount source for: " + incomeNoSource.join(", "),
    };
  }

  // 4) Per group: compute, then (dry-run record | PUT).
  const results = [];
  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const g of matched) {
    const isIncome = g.type === "Income";
    // Write OriginalBudgetedQty only when the line has an actual hours source in the
    // mapping (GENA/S1/S2/S3). HOUR lines with no source (ROOFCOM piece-rate, Labor
    // Burden) get amount only — we never overwrite the scaffold qty with a bogus 0.
    const hasQty = g.uom === "HOUR" && g.hoursFields.length > 0;
    const amount = sumFields(g.amountFields, budgetValues);
    const qty = hasQty ? sumFields(g.hoursFields, budgetValues) : null;
    // "computed" = the amount is DERIVED, not a plain field/sum — i.e. any spec uses
    // subtraction (BALANCE = Contract_Amount__c - Total_Material_Budget__c). Surfaced
    // in dry-run so a reviewer can see which lines are calculated vs. read straight.
    const computed = g.amountFields.some((s) => s.includes("-"));
    const amountExpr = computed ? g.amountFields.join(" + ") : null;

    // Skip-zero: expense lines at 0 are left as-is; income is always written.
    if (!isIncome && amount === 0) {
      skipped++;
      results.push({ key: g.key, lineId: g.lineId, action: "skip_zero", amount: 0, uom: g.uom, type: g.type, rows: g.rows });
      continue;
    }

    const body = { id: g.lineId, OriginalBudgetedAmount: { value: amount } };
    if (hasQty) body.OriginalBudgetedQty = { value: qty };

    if (dryRun) {
      results.push({
        key: g.key, lineId: g.lineId, action: "would_write",
        amount, ...(hasQty ? { qty } : {}), uom: g.uom, type: g.type, rows: g.rows,
        ...(computed ? { computed: true, amountExpr } : {}),
        ...(isIncome && g.amountFields.length === 0 ? { needsAmountSource: true } : {}),
      });
      continue;
    }

    console.log(
      `budget-push PUT ${g.key} guid=${g.lineId} amount=${amount}` +
        (hasQty ? ` qty=${qty}` : "")
    );
    const put = await putBudgetLineWithRetry(body);
    if (put.ok) {
      written++;
      results.push({ key: g.key, lineId: g.lineId, action: "written", amount, ...(hasQty ? { qty } : {}), uom: g.uom, status: put.status });
    } else {
      failed++;
      results.push({ key: g.key, lineId: g.lineId, action: "failed", amount, status: put.status, error: put.text });
    }
  }

  return {
    ok: failed === 0,
    dryRun,
    acumaticaProjectId,
    summary: { matchedGroups: matched.length, written, skipped, failed },
    results,
  };
}

// Resolve an Acumatica ProjectID from a Sundial_Solar__c record id (read-only).
async function projectIdForRecord(recordId) {
  const soql =
    `SELECT Acumatica_Project_ID__c FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows && rows.length ? rows[0].Acumatica_Project_ID__c : null;
}

// --- handler: dispatch by invocation shape ---------------------------------
// Ways this Lambda is entered:
//   1. Async worker self-invoke  -> event.__worker === true    (handleWorker)
//   2. Dry-run write (direct)    -> event.dryRunWrite === true (handleDryRunWrite)
//   3. API Gateway HTTP request  -> event.requestContext etc.  (handleHttp)
//   4. Direct payload (reconcile) -> { recordId | acumaticaProjectId } (handleReconcile)
// The reconcile path is UNCHANGED from before; HTTP + worker are the write path.
function isHttpEvent(event) {
  return !!(
    event &&
    (event.requestContext || event.httpMethod || event.routeKey || event.rawPath)
  );
}

export const handler = async (event) => {
  if (event && event.__worker === true) return handleWorker(event);
  if (event && event.dryRunWrite === true) return handleDryRunWrite(event);
  if (isHttpEvent(event)) return handleHttp(event);
  return handleReconcile(event);
};

// --- Dry-run write (direct invoke, READ-ONLY) ------------------------------
// Payload: { dryRunWrite:true, recordId:"<Sundial_Solar__c Id>" } (preferred — pulls
// the record's real budget values), or { dryRunWrite:true, acumaticaProjectId:"R269999" }
// (project only; values default to 0). Computes every per-line amount/qty exactly as a
// real push would and returns them WITHOUT any PUT and WITHOUT any SF write-back. The
// runbook's pre-push check. No gates — it's a read.
async function handleDryRunWrite(event) {
  try {
    let acumaticaProjectId = event.acumaticaProjectId || null;
    let budgetValues = {};
    if (event.recordId) {
      const fields = budgetFieldNames();
      const soql =
        `SELECT Acumatica_Project_ID__c, ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
        `WHERE Id = '${soqlEscapeString(event.recordId)}' LIMIT 1`;
      const rows = await sfQuery(soql);
      if (!rows || rows.length === 0) return { ok: false, error: "record_not_found" };
      budgetValues = rows[0];
      acumaticaProjectId =
        acumaticaProjectId || String(rows[0].Acumatica_Project_ID__c || "").trim();
    }
    if (!acumaticaProjectId) {
      return {
        ok: false,
        error: "no_project_id",
        message: "Provide recordId (with Acumatica_Project_ID__c set) or acumaticaProjectId.",
      };
    }
    const result = await writeBudgetLines(acumaticaProjectId, budgetValues, { dryRun: true });
    return { mode: "dry_run_write", ...result };
  } catch (err) {
    console.error("budget-push dry-run error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
}

// --- HTTP: POST /projects/{recordId}/budget/push ---------------------------
// Validates the gates, flips Budget_Push_Status__c to 'Pushing', fires the async
// worker, and returns 202. Never does the Acumatica writes on the HTTP leg (API
// Gateway caps at ~29s; the worker gets the full function timeout).
async function handleHttp(event) {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "POST") {
    return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });
  }

  const pp = event?.pathParameters || {};
  const recordId = pp.recordId ? decodeURIComponent(pp.recordId) : null;
  if (!recordId || !/^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
    return jsonResponse(400, cors, {
      error: "invalid_record_id",
      code: "INVALID_RECORD_ID",
      message: "Path must carry a Sundial_Solar__c record id.",
    });
  }

  // Auth — tenant derived ONLY from the verified token.
  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    throw err;
  }
  const tenantId = identity.tenantId;
  if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });

  // Load the project TENANT-SCOPED with the two gate inputs + the linked customer's
  // Acumatica-sync flag. Not owned / missing is indistinguishable -> 404.
  const soql =
    `SELECT Id, Acumatica_Project_ID__c, Budget_Calc_Status__c, Commission_Deal_Type__c, ` +
    `Sundial_Customer__r.Synced_to_Acumatica__c ` +
    `FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  if (!rows || rows.length === 0) {
    return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  const rec = rows[0];
  const acumaticaProjectId = String(rec.Acumatica_Project_ID__c || "").trim();
  const calcStatus = rec.Budget_Calc_Status__c;
  const customerSynced = rec.Sundial_Customer__r?.Synced_to_Acumatica__c === true;

  // Gate 1: only push CALCULATED numbers — never Pending/Error/blank.
  if (calcStatus !== "Calculated") {
    return jsonResponse(409, cors, {
      error: "budget_not_calculated",
      code: "BUDGET_NOT_CALCULATED",
      message: `Budget_Calc_Status__c is '${calcStatus || "(blank)"}', must be 'Calculated'.`,
    });
  }
  // Gate 1b (v2 ROLLOUT GUARD): 'Calculated' does not say WHICH engine calculated it.
  // A record calculated before the v2 rollout still reads 'Calculated' but carries v1
  // numbers, which the v3 mapping would post as a plausible, wrong budget rather than
  // failing. Commission_Deal_Type__c is only ever written by budgetCalc v2.
  //
  // Checked HERE as well as in writeBudgetLines so the button gets an immediate, honest
  // 409 instead of a 202 followed by an async failure the user has to go find. The
  // deeper guard still stands for the worker / dry-run / direct-invoke paths.
  //
  // The fix is a click: Recalculate Budget, then Update Budget.
  if (String(rec.Commission_Deal_Type__c || "").trim() === "") {
    return jsonResponse(409, cors, {
      error: "budget_calculated_by_previous_engine",
      code: "BUDGET_CALCULATED_BY_PREVIOUS_ENGINE",
      message:
        "Budget was calculated with the previous engine — run Recalculate Budget first.",
    });
  }
  // Gate 2: the Acumatica project + budget scaffold must already exist (Layer 1).
  if (!customerSynced) {
    return jsonResponse(409, cors, {
      error: "customer_not_synced",
      code: "CUSTOMER_NOT_SYNCED",
      message: "Linked customer is not Synced_to_Acumatica__c=true; the Acumatica project/budget scaffold must exist first.",
    });
  }
  // Gate 3: need the project id to target.
  if (!acumaticaProjectId) {
    return jsonResponse(409, cors, {
      error: "no_acumatica_project",
      code: "NO_ACUMATICA_PROJECT",
      message: "Acumatica_Project_ID__c is blank; cannot target a ProjectBudget.",
    });
  }

  // Flip to 'Pushing' so the UI reflects in-flight state, then fire the worker.
  try {
    await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, { Budget_Push_Status__c: "Pushing" });
  } catch (err) {
    console.error("budget-push: could not set Pushing status:", err?.message || String(err));
    return jsonResponse(502, cors, { error: "sf_update_failed", code: "SF_UPDATE_FAILED" });
  }

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: "Event", // async, fire-and-forget
        Payload: Buffer.from(
          JSON.stringify({ __worker: true, recordId, acumaticaProjectId, tenantId })
        ),
      })
    );
  } catch (err) {
    console.error("budget-push: self-invoke failed:", err?.message || String(err));
    // Roll the status back so the UI isn't stuck on 'Pushing'.
    try {
      await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
        Budget_Push_Status__c: "Failed",
        Budget_Push_Error__c: "Async worker could not be started: " + (err?.message || String(err)),
      });
    } catch {}
    return jsonResponse(502, cors, { error: "worker_invoke_failed", code: "WORKER_INVOKE_FAILED" });
  }

  return jsonResponse(202, cors, {
    status: "Pushing",
    recordId,
    acumaticaProjectId,
    message: "Budget push started.",
  });
}

// --- Async worker: the actual read -> match -> write, then SF write-back -----
// Runs off the API Gateway clock. Reads the budget field values, writes the
// ProjectBudget lines, then records the outcome on the Solar record in ONE PATCH.
// Budget_Finalized__c is set true ONLY on success (idempotent — re-pushes leave it
// true). On any failure/abort it records the reason and leaves Finalized untouched.
async function handleWorker(event) {
  const { recordId, acumaticaProjectId, tenantId } = event;
  try {
    // Pull exactly the fields the mapping references (tenant-scoped defense-in-depth).
    const fields = budgetFieldNames();
    const soql =
      `SELECT ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(recordId)}'` +
      (tenantId ? ` AND Client__c = '${soqlEscapeString(tenantId)}'` : "") +
      ` LIMIT 1`;
    const rows = await sfQuery(soql);
    if (!rows || rows.length === 0) {
      await markFailed(recordId, "Record not found or not owned by tenant during worker read.");
      return { ok: false, error: "record_not_found" };
    }

    const result = await writeBudgetLines(acumaticaProjectId, rows[0]);

    if (result.ok) {
      await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
        Budget_Push_Status__c: "Pushed",
        Budget_Pushed_At__c: new Date().toISOString(),
        Budget_Push_Error__c: null,
        Budget_Finalized__c: true, // first success finalizes; re-push leaves it true
      });
    } else {
      const failedKeys = (result.results || [])
        .filter((r) => r.action === "failed")
        .map((r) => `${r.key}(${r.status})`)
        .join(", ");
      const errMsg = result.aborted
        ? `aborted:${result.aborted} ${result.message || ""}`.trim()
        : `${result.summary?.failed || 0} line(s) failed: ${failedKeys}`;
      await markFailed(recordId, errMsg);
    }
    return result;
  } catch (err) {
    console.error("budget-push worker error:", err?.message || String(err));
    try {
      await markFailed(recordId, "worker exception: " + (err?.message || String(err)));
    } catch {}
    return { ok: false, error: "worker_exception", message: err?.message || String(err) };
  }
}

// Record a failed push. Budget_Finalized__c is deliberately NOT touched here.
async function markFailed(recordId, message) {
  await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
    Budget_Push_Status__c: "Failed",
    Budget_Push_Error__c: String(message).slice(0, 32000),
  });
}

// --- RECONCILE (read-only) -------------------------------------------------
// Input: { recordId } (Sundial_Solar__c) or { acumaticaProjectId }. Returns the
// existing lines + the mapping match result for the Gate 5a table. No writes.
async function handleReconcile(event) {
  const body =
    event && typeof event === "object" && !event.Records ? event : {};
  let acumaticaProjectId = body.acumaticaProjectId || null;
  try {
    if (!acumaticaProjectId && body.recordId) {
      acumaticaProjectId = await projectIdForRecord(body.recordId);
    }
    if (!acumaticaProjectId) {
      return { ok: false, error: "no_project_id", message: "Provide acumaticaProjectId or a recordId with Acumatica_Project_ID__c set." };
    }

    const lines = await readProjectBudgetLines(acumaticaProjectId);
    if (lines.length === 0) {
      // Per spec: zero lines means the project wasn't created / scaffold failed.
      return { ok: false, error: "no_scaffolded_lines", acumaticaProjectId, message: "ProjectBudget returned 0 lines — project not created or scaffold failed. Do NOT create lines from scratch." };
    }

    const { matched, problems } = matchMappingToLines(MAPPING_ROWS, lines);
    return {
      ok: true,
      mode: "reconcile_read_only",
      acumaticaProjectId,
      lineCount: lines.length,
      lines, // full existing scaffold, keyed by natural key + GUID (Gate 5a table)
      mappingMatch: { matchedCount: matched.length, matched, problems },
      // Data blockers resolved from the R269999 harvest (2026-08-07). What remains
      // before a PRODUCTION write is Gate 5b sign-off, not more data.
      gate5b: [
        "Confirm this run shows all mapping rows matched with 0 problems.",
        "Harmon finance sign-off on the Geo commission -> APPT COM (LABOR/SALESCOMM) mapping.",
        "Tim approves the hand-proven write plan before writeBudgetLines is implemented.",
      ],
    };
  } catch (err) {
    console.error("acumatica-budget-push reconcile error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
}
