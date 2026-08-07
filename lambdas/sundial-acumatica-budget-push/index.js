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

import { getAcumaticaEntity } from "../../lib/acumatica.js";
import { sfQuery, soqlEscapeString } from "../../lib/salesforce.js";

const PROJECT_BUDGET_ENTITY = "ProjectBudget";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

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
  // line, taskId, accountGroup, type, inventoryId, amountField, hoursField, note.
  // Full 4-part key verbatim from the R269999 harvest.
  { line: "Income - Balance of Contract", taskId: "BALANCE", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: null, hoursField: null, note: "Income 1 of 2. BALANCE/BILLING/Income, InventoryID <N/A>. Amount source TBD from the budget calc." },
  { line: "Income - Solar Material", taskId: "GENM", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: null, hoursField: null, note: "Income 2 of 2. GENM/BILLING/Income — distinct from GENM/MATERIAL cost via AccountGroup+Type. Amount source TBD." },
  { line: "Dealer Fee", taskId: "DLR", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Dealer_Fee__c", hoursField: null, note: "DLR/OTHER/<N/A>. Only send when > 0." },
  { line: "Sales Rep Commission", taskId: "SLPC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Sales_Rep_Commission_Amt__c", hoursField: null, note: "Sums with Overhead Commission into the single SLPC/LABOR/SALESCOMM line." },
  { line: "Sales Manager Commission", taskId: "SLMC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Sales_Mgr_Commission_Amt__c", hoursField: null },
  { line: "Geo Commission", taskId: "APPT COM", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Geo_Commission_Amount__c", hoursField: null, note: "Confirmed from role semantics (appointment-setter flat commission); Harmon sign-off required before first PRODUCTION push (PENDING_HARMON_SIGNOFF)." },
  { line: "Overhead Commission", taskId: "SLPC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Overhead_Commission_Amt__c", hoursField: null, note: "Sums with Sales Rep Commission into the single SLPC/LABOR/SALESCOMM line." },
  { line: "Commission Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Commission_Burden_Amt__c", hoursField: null, note: "BURDENEXR/LABOR/SALESCOMM — InventoryID SALESCOMM separates it from Labor Burden (RESIDENTAL)." },
  { line: "Audit + QA Labor", taskId: "GENA", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Audit_Labor_Cost__c+QA_Labor_Cost__c", hoursField: "GENA_Hours__c", note: "Labor line GENA/LABOR/RESIDENTAL, UOM=HOUR, qty from GENA_Hours__c. NOT the GENA/OTHER/AUDIT SVCS outside-services line — this is internal employee audit/QA labor." },
  { line: "Roofing Labor", taskId: "ROOFCOM", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Roofing_Labor_Cost__c", hoursField: null },
  { line: "S1 Install Labor", taskId: "S1", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S1_Labor_Cost__c", hoursField: "S1_Hours__c" },
  { line: "S2 Install Labor", taskId: "S2", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S2_Labor_Cost__c", hoursField: "S2_Hours__c" },
  { line: "S3 Labor (Battery + Adders)", taskId: "S3", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S3_Labor_Cost__c", hoursField: "S3_Hours__c" },
  { line: "Labor Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Total_Labor_Burden_Budget__c", hoursField: null, note: "BURDENEXR/LABOR/RESIDENTAL — InventoryID RESIDENTAL separates it from Commission Burden (SALESCOMM)." },
  { line: "Total Material", taskId: "GENM", accountGroup: "MATERIAL", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null },
  { line: "Other Material", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Other_Budget__c", hoursField: null, note: "Sums with CO Fee + Permit into the single GENO/OTHER/<N/A> line." },
  { line: "Constructive Ops Fee", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Constructive_Ops_Fee__c", hoursField: null, note: "Sums into the GENO/OTHER/<N/A> line." },
  { line: "Permit Pass-Through", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Permit_Pass_Through_Cost__c", hoursField: null, note: "Sums into the GENO/OTHER/<N/A> line." },
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
      rows: rows.map((r) => r.line),
      summed: rows.length > 1, // multiple mapping rows -> summed into this one line
      amountFields: rows.map((r) => r.amountField).filter(Boolean),
    });
  }
  return { matched, problems };
}

// HARD GUARD: the write path is not built. It throws so nothing can accidentally
// push. Gate 5a (data) is DONE — MAPPING_ROWS carry the full 4-part keys from the
// R269999 harvest. The remaining gate is Gate 5b (sign-off), NOT more data.
export async function writeBudgetLines() {
  throw new Error(
    "BLOCKED: ProjectBudget write path is intentionally not implemented. " +
      "Data blockers are RESOLVED (InventoryIDs + geo commission harvested from " +
      "R269999, 2026-08-07). Gated on Gate 5b sign-off: a clean matched-run against " +
      "R269999 (all rows matched, 0 problems) AND a hand-proven write plan approved " +
      "by Tim (incl. Harmon sign-off on the APPT COM geo mapping) before implementing."
  );
}

// Resolve an Acumatica ProjectID from a Sundial_Solar__c record id (read-only).
async function projectIdForRecord(recordId) {
  const soql =
    `SELECT Acumatica_Project_ID__c FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows && rows.length ? rows[0].Acumatica_Project_ID__c : null;
}

// --- handler: RECONCILE (read-only) ----------------------------------------
// Input: { recordId } (Sundial_Solar__c) or { acumaticaProjectId }. Returns the
// existing lines + the mapping match result for the Gate 5a table. No writes.
export const handler = async (event) => {
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
};
